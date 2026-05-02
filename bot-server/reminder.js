// bot-server/reminder.js — воркер 1-часовых напоминаний (Web Push)

require('dotenv').config();
const webpush = require('web-push');
const { Pool } = require('pg');

if (!process.env.PG_PASSWORD) {
  console.error('missing env: PG_PASSWORD');
  process.exit(1);
}
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) {
  console.error('missing env: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT');
  process.exit(1);
}

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DATABASE || 'beauty_catalog',
  user: process.env.PG_USER || 'beauty',
  password: process.env.PG_PASSWORD,
  max: 5,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[reminder] PostgreSQL pool error:', err.message);
});

const INTERVAL_MS = 60_000;

// === 24-часовой reminder с кнопками подтвердить/отменить/перенести ===
async function check24hReminders() {
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.date, b.time, b.client_name, b.client_phone, b.master_id,
              m.studio_name, m.name AS master_name, m.address, m.yandex_maps_url,
              s.name AS service_name
       FROM bookings b
       JOIN masters m ON b.master_id = m.id
       LEFT JOIN services s ON b.service_id = s.id
       WHERE b.status = 'confirmed'
         AND b.reminder_24h_sent_at IS NULL
         AND (b.date + b.time::interval) AT TIME ZONE 'Europe/Moscow'
             BETWEEN (NOW() AT TIME ZONE 'Europe/Moscow' + INTERVAL '23 hours')
                 AND (NOW() AT TIME ZONE 'Europe/Moscow' + INTERVAL '25 hours')`
    );

    for (const booking of rows) {
      const phoneNorm = String(booking.client_phone || '').replace(/\D/g, '').slice(-10);
      if (phoneNorm.length !== 10) {
        await pool.query('UPDATE bookings SET reminder_24h_sent_at = NOW() WHERE id = $1', [booking.id]);
        continue;
      }
      const subsRes = await pool.query(
        `SELECT endpoint, p256dh, auth FROM push_subscriptions
         WHERE right(regexp_replace(user_phone, '[^0-9]', '', 'g'), 10) = $1`,
        [phoneNorm]
      );

      const placeDisplay = booking.studio_name || booking.master_name;
      const timeStr = String(booking.time).slice(0, 5);
      const serviceTxt = booking.service_name ? `${booking.service_name} · ` : '';
      const title = 'Напоминание: завтра запись';
      const body = `${serviceTxt}${placeDisplay} · ${timeStr}\nПодтвердите запись или нажмите Отменить/Перенести.`;

      try {
        await pool.query(
          `INSERT INTO notifications (user_phone, master_id, type, title, body, read, created_at, booking_id, data)
           VALUES ($1, $2, 'reminder_24h', $3, $4, false, NOW(), $5, $6)`,
          [phoneNorm, booking.master_id, title, body, booking.id,
           JSON.stringify({ booking_id: booking.id, type: 'reminder_24h', actions: ['confirm','cancel','reschedule'] })]
        );
      } catch (e) { /* swallow */ }

      if (subsRes.rows.length) {
        const payload = JSON.stringify({
          title, body,
          data: {
            booking_id: booking.id,
            type: 'reminder_24h',
            url: '/?master=' + (booking.master_slug || ''),
            actions: ['confirm','cancel','reschedule'],
          },
        });
        for (const sub of subsRes.rows) {
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              payload
            );
          } catch (pushErr) {
            if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
              await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint])
                .catch(() => {});
            }
          }
        }
      }
      await pool.query(
        'UPDATE bookings SET reminder_24h_sent_at = NOW() WHERE id = $1 AND reminder_24h_sent_at IS NULL',
        [booking.id]
      );
    }
  } catch (err) {
    console.error('[reminder24h] error:', err.message);
  }
}

async function checkReminders() {
  let due = 0, sent = 0, skipped = 0;

  // Сначала запускаем 24h reminder (с кнопками для клиента)
  await check24hReminders();

  try {
    // 1. Находим записи с подходящим временем (без JOIN на подписки —
    //    в push_subscriptions нет master_id, и user_phone хранится в разных
    //    форматах +7XXX / 7XXX / 8XXX — точное сравнение не работает).
    const { rows } = await pool.query(
      `SELECT b.id, b.date, b.time, b.client_name, b.client_phone, b.master_id,
              m.studio_name, m.name AS master_name, m.address, m.yandex_maps_url
       FROM bookings b
       JOIN masters m ON b.master_id = m.id
       WHERE b.status = 'confirmed'
         AND b.reminder_1h_sent_at IS NULL
         AND (b.date + b.time::interval) AT TIME ZONE 'Europe/Moscow'
             BETWEEN (NOW() AT TIME ZONE 'Europe/Moscow' + INTERVAL '55 minutes')
                 AND (NOW() AT TIME ZONE 'Europe/Moscow' + INTERVAL '65 minutes')`
    );

    due = rows.length;

    for (const booking of rows) {
      // 2. Ищем все подписки этого клиента (нормализованный поиск по 10 цифрам).
      const phoneNorm = String(booking.client_phone || '').replace(/\D/g, '').slice(-10);
      if (phoneNorm.length !== 10) {
        console.log(`[reminder] booking ${booking.id}: invalid phone "${booking.client_phone}", skipping`);
        skipped++;
        continue;
      }

      const subsRes = await pool.query(
        `SELECT endpoint, p256dh, auth FROM push_subscriptions
         WHERE right(regexp_replace(user_phone, '[^0-9]', '', 'g'), 10) = $1`,
        [phoneNorm]
      );

      // Сохраняем in-app notification (для колокольчика клиента)
      const placeDisplay = booking.studio_name || booking.master_name;
      const timeStr = String(booking.time).slice(0, 5);
      const title = 'Напоминание о записи';
      const body = `Ждём вас сегодня в ${placeDisplay} в ${timeStr}. Адрес: ${booking.address || 'уточните у мастера'}.`;
      try {
        await pool.query(
          `INSERT INTO notifications (user_phone, master_id, type, title, body, read, created_at, booking_id, data)
           VALUES ($1, $2, 'reminder', $3, $4, false, NOW(), $5, $6)`,
          [phoneNorm, booking.master_id, title, body, booking.id,
           JSON.stringify({ url: booking.yandex_maps_url || '', booking_id: booking.id, type: 'reminder' })]
        );
      } catch (e) { /* swallow notification insert error */ }

      if (!subsRes.rows.length) {
        console.log(`[reminder] booking ${booking.id}: no push subscription for ${phoneNorm}`);
        // Помечаем как «обработано» — чтобы не зацикливаться. Notification в БД уже сохранён.
        await pool.query(
          `UPDATE bookings SET reminder_1h_sent_at = NOW() WHERE id = $1`,
          [booking.id]
        );
        skipped++;
        continue;
      }

      // 3. Рассылаем web-push на все активные подписки клиента
      const payload = JSON.stringify({
        title,
        body,
        data: { url: booking.yandex_maps_url || '', booking_id: booking.id, type: 'reminder' },
      });

      let anyPushSucceeded = false;
      for (const sub of subsRes.rows) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload
          );
          anyPushSucceeded = true;
        } catch (pushErr) {
          if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
            await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint])
              .catch(() => {});
          } else {
            console.error(`[reminder] push error for booking ${booking.id}:`, pushErr.message);
          }
        }
      }

      // 4. Помечаем флаг ТОЛЬКО после попытки рассылки — не теряем клиента
      //    из-за тихого прохождения UPDATE. Атомарно: если другой воркер уже
      //    обновил флаг, мы пропускаем (чтобы не делать двойную рассылку).
      const flagResult = await pool.query(
        `UPDATE bookings SET reminder_1h_sent_at = NOW()
         WHERE id = $1 AND reminder_1h_sent_at IS NULL
         RETURNING id`,
        [booking.id]
      );
      if (!flagResult.rows.length) {
        skipped++;
        continue;
      }
      if (anyPushSucceeded) sent++;
      else skipped++;
    }
  } catch (err) {
    console.error('[reminder] checkReminders error:', err.message);
  }

  console.log(`[reminder] tick: ${due} due, ${sent} sent, ${skipped} skipped`);
}

process.on('unhandledRejection', (reason) => {
  console.error('[reminder] unhandledRejection:', reason);
});

setInterval(checkReminders, INTERVAL_MS);
checkReminders();
