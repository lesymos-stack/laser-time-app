// Vercel Serverless Function — рассылка через бота
// Проксирует запрос к боту (server-to-server, HTTP OK)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const BOT_SERVER = process.env.BOT_SERVER_URL || 'http://90.156.168.186:3001';

  try {
    const resp = await fetch(`${BOT_SERVER}/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });

    const data = await resp.json();
    return res.status(resp.status).json(data);
  } catch (err) {
    console.error(`❌ broadcast proxy error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
}
