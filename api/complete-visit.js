// Vercel Serverless Function — завершение визита + начисление бонусов
// Использует SERVICE_KEY для обхода RLS
// Env vars в Vercel Dashboard: SUPABASE_SERVICE_ROLE_KEY, BOT_SERVER_URL

const SUPABASE_URL = 'https://jybvgjrdhfycfptwxihn.supabase.co';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const BOT_SERVER = process.env.BOT_SERVER_URL || 'http://90.156.168.186:3001';

  if (!SERVICE_KEY) return res.status(500).json({ error: 'SERVICE_KEY not configured' });

  try {
    const { master_id, master_code, booking_id, client_tg_id, price, action } = req.body;

    if (!master_id || !master_code || !booking_id || !action) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Проверяем master_code
    const mastersResp = await fetch(
      `${SUPABASE_URL}/rest/v1/masters?id=eq.${master_id}&select=id,master_code,name`,
      { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
    );
    const masters = await mastersResp.json();
    if (!masters.length || String(masters[0].master_code) !== String(master_code)) {
      return res.status(403).json({ error: 'Invalid master_code' });
    }

    const masterName = masters[0].name;
    const newStatus = action === 'no_show' ? 'no_show' : 'completed';

    // Обновляем статус записи
    const patchUrl = `${SUPABASE_URL}/rest/v1/bookings?id=eq.${booking_id}`;
    const patchRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({ status: newStatus }),
    });

    if (!patchRes.ok) {
      const errText = await patchRes.text();
      return res.status(500).json({ error: `PATCH failed: ${errText}` });
    }

    let bonusAmount = 0;

    // Начисляем бонусы только для completed
    if (newStatus === 'completed' && client_tg_id && price > 0) {
      // Находим клиента
      const clientsResp = await fetch(
        `${SUPABASE_URL}/rest/v1/clients?master_id=eq.${master_id}&tg_user_id=eq.${client_tg_id}&select=id,bonus_balance`,
        { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
      );
      const clients = await clientsResp.json();

      if (clients.length > 0) {
        const client = clients[0];
        bonusAmount = Math.round(price * 0.03 * 100) / 100; // 3%
        const expiresAt = new Date();
        expiresAt.setMonth(expiresAt.getMonth() + 3);

        // Создаём транзакцию бонуса
        await fetch(`${SUPABASE_URL}/rest/v1/bonus_transactions`, {
          method: 'POST',
          headers: {
            'apikey': SERVICE_KEY,
            'Authorization': `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            master_id,
            client_id: client.id,
            booking_id,
            amount: bonusAmount,
            type: 'credit',
            description: 'Начисление 3% за визит',
            expires_at: expiresAt.toISOString(),
          }),
        });

        // Обновляем баланс клиента
        const newBalance = parseFloat(client.bonus_balance || 0) + bonusAmount;
        await fetch(`${SUPABASE_URL}/rest/v1/clients?id=eq.${client.id}`, {
          method: 'PATCH',
          headers: {
            'apikey': SERVICE_KEY,
            'Authorization': `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ bonus_balance: newBalance }),
        });

        // Помечаем запись как bonus_credited
        await fetch(patchUrl, {
          method: 'PATCH',
          headers: {
            'apikey': SERVICE_KEY,
            'Authorization': `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ bonus_credited: true }),
        });

        // Уведомляем клиента через бота (server-to-server, HTTP OK)
        try {
          await fetch(`${BOT_SERVER}/api/notify-bonus`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ master_id, client_tg_id, bonus_amount: bonusAmount }),
          });
        } catch (e) { /* ignore notify error */ }

        console.log(`💎 Бонус ${bonusAmount} ₽ начислен клиенту tg:${client_tg_id}`);
      }
    }

    return res.status(200).json({ ok: true, status: newStatus, bonus: bonusAmount });
  } catch (err) {
    console.error(`❌ complete-visit error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
}
