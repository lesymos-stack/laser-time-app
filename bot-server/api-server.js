// ============================================================
// REST API сервер — замена Supabase REST API
// Работает на VPS рядом с бот-сервером, ходит в локальный PostgreSQL
// ============================================================

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const busboy = require('busboy');
const webpush = require('web-push');
const { pool } = require('./db');
const { sendCode, verifyCode, refreshAccessToken, getUserFromRequest } = require('./auth');

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// VAPID для отправки web-push
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  const subject = process.env.VAPID_SUBJECT || process.env.VAPID_EMAIL || 'mailto:noreply@beautyplatform.ru';
  webpush.setVapidDetails(subject, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

// Сохраняет notification в БД и рассылает push всем активным подпискам этого телефона.
// Молча проглатывает ошибки конкретных подписок (битые сертификаты и пр.).
async function sendPushToPhone(phone, { title, body, type = 'info', masterId = null, bookingId = null, data = null } = {}) {
  if (!phone) return;
  const phoneNorm = String(phone).replace(/\D/g, '').slice(-10);
  if (phoneNorm.length !== 10) return;
  try {
    // 1. Сохраняем in-app notification (для колокольчика)
    await pool.query(
      `INSERT INTO notifications (user_phone, master_id, type, title, body, read, created_at, booking_id, data)
       VALUES ($1, $2, $3, $4, $5, false, NOW(), $6, $7)`,
      [phoneNorm, masterId, type, title, body, bookingId, data ? JSON.stringify(data) : null]
    );
  } catch (e) {
    console.warn('notification insert failed:', e.message);
  }
  if (!process.env.VAPID_PUBLIC_KEY) return;
  try {
    // 2. Рассылаем web-push всем подпискам с этим телефоном (или нормализованным)
    const subs = await pool.query(
      `SELECT endpoint, p256dh, auth FROM push_subscriptions
       WHERE right(regexp_replace(user_phone, '[^0-9]', '', 'g'), 10) = $1`,
      [phoneNorm]
    );
    const payload = JSON.stringify({ title, body, data: { type, masterId, bookingId, ...(data || {}) } });
    for (const sub of subs.rows) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
      } catch (err) {
        // Удаляем мёртвые подписки (410 Gone)
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
        } else {
          console.warn('push send failed:', err.statusCode || err.message);
        }
      }
    }
  } catch (e) {
    console.warn('sendPushToPhone error:', e.message);
  }
}

// Процент бонусной программы (от стоимости услуги при «Завершить»).
// Можно вынести в колонку masters.loyalty_percent позже.
const BONUS_PERCENT = parseInt(process.env.BONUS_PERCENT || '5', 10);

// Форматирование даты из БД (Date object или строка) → "28 апреля"
function formatDateRu(dateValue) {
  if (!dateValue) return '';
  let dateStr;
  if (dateValue instanceof Date) {
    dateStr = dateValue.toISOString().slice(0, 10);
  } else {
    dateStr = String(dateValue).slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return '';
  try {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  } catch {
    return '';
  }
}

function formatTimeRu(timeValue) {
  if (!timeValue) return '';
  return String(timeValue).slice(0, 5);
}

if (!process.env.API_SECRET) {
  console.error('missing env: API_SECRET');
  process.exit(1);
}

const API_PORT = process.env.API_PORT || 3000;
const API_SECRET = process.env.API_SECRET;

// --- Утилиты ---
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : null); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// CORS whitelist — разрешены только наши домены
const CORS_ALLOWED_ORIGINS = [
  'https://app.beautyplatform.ru',
  'https://beautyplatform.ru',
  'https://laser-time-app.vercel.app',
];

function applyCorsHeaders(req, res) {
  const origin = req.headers['origin'] || '';
  if (CORS_ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  // Если Origin отсутствует (server-to-server) — заголовок не нужен
  // TODO: если появится новый домен — добавить в CORS_ALLOWED_ORIGINS выше
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
}

function sendJSON(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res, message, status = 400) {
  sendJSON(res, { error: message }, status);
}

// --- Авторизация ---
function getAuthLevel(req) {
  const apiKey = req.headers['x-api-key'] || '';
  if (apiKey === API_SECRET) return 'service';
  return 'public';
}

// Найти мастера по телефону (из JWT) — нормализуем сравнение по последним 10 цифрам,
// чтобы '+79094581323' / '89094581323' / '+7 (909) 458-13-23' матчились одинаково.
async function getMasterByPhone(phone) {
  const normalized = String(phone || '').replace(/\D/g, '').slice(-10);
  if (normalized.length !== 10) return null;
  const result = await pool.query(
    `SELECT id FROM masters
     WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1
     LIMIT 1`,
    [normalized]
  );
  return result.rows[0] || null;
}

// Получить master_id из JWT-payload — приоритет: явный master_id (master-code-login,
// master-phone-login), fallback — поиск по телефону (если мастер вошёл по SMS OTP
// как клиент, но в masters совпадает phone).
async function resolveMasterId(user) {
  if (!user) return null;
  if (user.master_id) return user.master_id;
  const m = await getMasterByPhone(user.phone);
  if (!m) {
    console.warn('[resolveMasterId] no match — phone:', JSON.stringify(user.phone), 'master_id:', user.master_id);
  }
  return m ? m.id : null;
}


// --- Парсер query-параметров в стиле Supabase ---
function parseFilters(query) {
  const filters = [];
  const values = [];
  let orderBy = null;
  let limit = null;
  let selectFields = '*';
  let offset = null;

  for (const [key, val] of Object.entries(query)) {
    if (key === 'order') {
      orderBy = val.split(',').map(p => {
        const [col, dir] = p.split('.');
        return `"${col}" ${dir === 'desc' ? 'DESC' : 'ASC'}`;
      }).join(', ');
      continue;
    }
    if (key === 'limit') { limit = parseInt(val); continue; }
    if (key === 'offset') { offset = parseInt(val); continue; }
    if (key === 'select') { selectFields = val; continue; }

    const match = val.match(/^(eq|neq|gt|gte|lt|lte|in|is|like|ilike|not)\.(.+)$/);
    if (!match) continue;

    const [, op, rawVal] = match;
    const col = `"${key}"`;

    if (op === 'eq') { values.push(rawVal); filters.push(`${col} = $${values.length}`); }
    else if (op === 'neq') { values.push(rawVal); filters.push(`${col} != $${values.length}`); }
    else if (op === 'gt') { values.push(rawVal); filters.push(`${col} > $${values.length}`); }
    else if (op === 'gte') { values.push(rawVal); filters.push(`${col} >= $${values.length}`); }
    else if (op === 'lt') { values.push(rawVal); filters.push(`${col} < $${values.length}`); }
    else if (op === 'lte') { values.push(rawVal); filters.push(`${col} <= $${values.length}`); }
    else if (op === 'in') {
      const items = rawVal.replace(/^\(|\)$/g, '').split(',');
      const placeholders = items.map(item => { values.push(item); return `$${values.length}`; });
      filters.push(`${col} IN (${placeholders.join(',')})`);
    } else if (op === 'is') {
      if (rawVal === 'null') filters.push(`${col} IS NULL`);
      else if (rawVal === 'true') filters.push(`${col} IS TRUE`);
      else if (rawVal === 'false') filters.push(`${col} IS FALSE`);
    } else if (op === 'not') {
      const subMatch = rawVal.match(/^(eq|in)\.(.+)$/);
      if (subMatch) {
        if (subMatch[1] === 'in') {
          const items = subMatch[2].replace(/^\(|\)$/g, '').split(',');
          const placeholders = items.map(item => { values.push(item); return `$${values.length}`; });
          filters.push(`${col} NOT IN (${placeholders.join(',')})`);
        } else {
          values.push(subMatch[2]);
          filters.push(`${col} != $${values.length}`);
        }
      }
    }
  }

  return { filters, values, orderBy, limit, selectFields, offset };
}

// Допустимые таблицы
const ALLOWED_TABLES = [
  'masters', 'categories', 'services', 'schedule', 'day_overrides',
  'bookings', 'clients', 'faq', 'bonus_transactions', 'abonements', 'notifications'
];

const PUBLIC_TABLES = [
  'masters', 'categories', 'services', 'schedule', 'day_overrides',
  'bookings', 'faq', 'abonements', 'notifications'
];

// --- Роутер ---
async function handleRequest(req, res) {
  // Применяем CORS-заголовки для всех ответов
  applyCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${API_PORT}`);
  const pathParts = url.pathname.split('/').filter(Boolean);

  // Health check
  if (url.pathname === '/health') {
    try {
      await pool.query('SELECT 1');
      sendJSON(res, { status: 'ok', db: 'connected' });
    } catch (e) {
      sendJSON(res, { status: 'error', db: e.message }, 500);
    }
    return;
  }

  // /api/v1/auth/* — авторизация по телефону
  if (pathParts[0] === 'api' && pathParts[1] === 'v1' && pathParts[2] === 'auth') {
    const action = pathParts[3];
    try {
      if (req.method === 'POST' && action === 'send-code') {
        const body = await parseBody(req);
        if (!body || !body.phone) { sendError(res, 'phone required'); return; }
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '1.1.1.1';
        const result = await sendCode(body.phone, clientIp);
        sendJSON(res, result, result.status || 200);
        return;
      }
      if (req.method === 'POST' && action === 'verify-code') {
        const body = await parseBody(req);
        if (!body || !body.phone || !body.code) { sendError(res, 'phone and code required'); return; }
        const result = await verifyCode(body.phone, body.code);
        sendJSON(res, result, result.status || 200);
        return;
      }
      if (req.method === 'POST' && action === 'refresh') {
        const body = await parseBody(req);
        if (!body || !body.refresh_token) { sendError(res, 'refresh_token required'); return; }
        const result = refreshAccessToken(body.refresh_token);
        if (!result) { sendError(res, 'Invalid token', 401); return; }
        sendJSON(res, result);
        return;
      }
      if (req.method === 'GET' && action === 'me') {
        const user = getUserFromRequest(req);
        if (!user) { sendError(res, 'Unauthorized', 401); return; }
        sendJSON(res, { phone: user.phone, client_id: user.client_id });
        return;
      }
      if (req.method === 'POST' && action === 'register-master') {
        // Публичный self-service эндпоинт: JWT необязателен.
        // phone берём из JWT (если мастер уже залогинен) либо из тела запроса.
        const user = getUserFromRequest(req);
        const body = await parseBody(req);
        if (!body || !body.name || !body.slug) { sendError(res, 'name and slug required'); return; }
        const phone = (user && user.phone) ? user.phone : (body.phone || '');
        // Проверяем уникальность slug
        const existing = await pool.query('SELECT id FROM masters WHERE slug = $1', [body.slug]);
        if (existing.rows.length > 0) { sendError(res, 'Этот адрес уже занят', 409); return; }
        const masterCode = String(Math.floor(100000 + Math.random() * 900000));
        const result = await pool.query(
          `INSERT INTO masters (name, phone, description, slug, master_code, is_active, welcome_text)
           VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING *`,
          [body.name, phone, body.description || '', body.slug, masterCode,
           'Добро пожаловать! Выберите услугу и запишитесь онлайн.']
        );
        const newMaster = result.rows[0];

        // Дефолтное расписание: Пн-Пт 10:00-20:00, Сб 10:00-18:00, Вс — выходной (не вставляем)
        const defaultSchedule = [
          { day: 1, start: '10:00', end: '20:00' },
          { day: 2, start: '10:00', end: '20:00' },
          { day: 3, start: '10:00', end: '20:00' },
          { day: 4, start: '10:00', end: '20:00' },
          { day: 5, start: '10:00', end: '20:00' },
          { day: 6, start: '10:00', end: '18:00' },
        ];
        for (const s of defaultSchedule) {
          await pool.query(
            `INSERT INTO schedule (master_id, day_of_week, start_time, end_time, slot_interval, is_active)
             VALUES ($1, $2, $3, $4, 30, true) ON CONFLICT DO NOTHING`,
            [newMaster.id, s.day, s.start, s.end]
          );
        }

        sendJSON(res, newMaster, 201);
        return;
      }
      // POST /api/v1/auth/master-code-login — вход мастера по master_id + master_code
      if (req.method === 'POST' && action === 'master-code-login') {
        const body = await parseBody(req);
        if (!body || !body.master_id || typeof body.master_id !== 'string') {
          sendError(res, 'master_id required', 400); return;
        }
        // masters.id — UUID, проверяем формат
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!UUID_RE.test(body.master_id)) {
          sendError(res, 'Invalid credentials', 401); return;
        }
        if (!body.code || typeof body.code !== 'string') {
          sendError(res, 'code required', 400); return;
        }
        const masterResult = await pool.query(
          'SELECT id, phone, name, slug, master_code, is_active FROM masters WHERE id = $1',
          [body.master_id]
        );
        if (masterResult.rows.length === 0 || masterResult.rows[0].master_code !== body.code.trim()) {
          sendError(res, 'Invalid credentials', 401); return;
        }
        const master = masterResult.rows[0];
        if (!master.is_active) { sendError(res, 'Master account is inactive', 403); return; }
        // Выдаём JWT — добавляем master_id в payload, сохраняя совместимость с существующим getUserFromRequest
        const { createJwt } = require('./auth');
        const accessToken = createJwt({ phone: master.phone, client_id: 0, master_id: master.id }, 60 * 60);
        const refreshToken = createJwt({ phone: master.phone, client_id: 0, master_id: master.id, type: 'refresh' }, 30 * 24 * 3600);
        sendJSON(res, {
          ok: true,
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: 3600,
          user: { id: master.id, phone: master.phone, name: master.name, slug: master.slug, role: 'master' },
        });
        return;
      }

      // POST /api/v1/auth/master-phone-login — вход мастера по phone + master_code
      if (req.method === 'POST' && action === 'master-phone-login') {
        const body = await parseBody(req);
        if (!body || !body.phone || typeof body.phone !== 'string') {
          sendError(res, 'phone required', 400); return;
        }
        if (!body.code || typeof body.code !== 'string') {
          sendError(res, 'code required', 400); return;
        }
        // Нормализация: берём последние 10 цифр (8XXX = +7XXX = 7XXX)
        const normalized = body.phone.replace(/\D/g, '').slice(-10);
        if (normalized.length !== 10) {
          sendError(res, 'Invalid credentials', 401); return;
        }
        const masterResult = await pool.query(
          `SELECT id, phone, name, slug, master_code, is_active
           FROM masters
           WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1`,
          [normalized]
        );
        if (masterResult.rows.length === 0 || masterResult.rows[0].master_code !== body.code.trim()) {
          sendError(res, 'Invalid credentials', 401); return;
        }
        const master = masterResult.rows[0];
        if (!master.is_active) { sendError(res, 'Master account is inactive', 403); return; }
        const { createJwt } = require('./auth');
        const accessToken = createJwt({ phone: master.phone, client_id: 0, master_id: master.id }, 60 * 60);
        const refreshToken = createJwt({ phone: master.phone, client_id: 0, master_id: master.id, type: 'refresh' }, 30 * 24 * 3600);
        sendJSON(res, {
          ok: true,
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: 3600,
          user: { id: master.id, phone: master.phone, name: master.name, slug: master.slug, role: 'master' },
        });
        return;
      }

      // POST /api/v1/auth/admin-login — вход в супер-админ панель
      if (req.method === 'POST' && action === 'admin-login') {
        const body = await parseBody(req);
        const adminPwd = process.env.ADMIN_PASSWORD;
        if (!adminPwd) { sendError(res, 'Admin not configured', 503); return; }
        if (!body || body.password !== adminPwd) { sendError(res, 'Invalid password', 401); return; }
        sendJSON(res, { ok: true });
        return;
      }

      // POST /api/v1/auth/delete-master — удалить мастера и все его данные
      if (req.method === 'POST' && action === 'delete-master') {
        const apiKey = req.headers['x-api-key'];
        if (apiKey !== API_SECRET) { sendError(res, 'Forbidden', 403); return; }
        const body = await parseBody(req);
        if (!body || !body.master_id) { sendError(res, 'master_id required', 400); return; }
        const mid = body.master_id;
        // Каскадное удаление всех данных мастера
        await pool.query('DELETE FROM notifications WHERE master_id = $1', [mid]);
        await pool.query('DELETE FROM push_subscriptions WHERE user_phone IN (SELECT phone FROM masters WHERE id = $1)', [mid]);
        await pool.query('DELETE FROM bonus_transactions WHERE master_id = $1', [mid]);
        await pool.query('DELETE FROM bookings WHERE master_id = $1', [mid]);
        await pool.query('DELETE FROM clients WHERE master_id = $1', [mid]);
        await pool.query('DELETE FROM services WHERE master_id = $1', [mid]);
        await pool.query('DELETE FROM categories WHERE master_id = $1', [mid]);
        await pool.query('DELETE FROM schedule WHERE master_id = $1', [mid]);
        await pool.query('DELETE FROM abonements WHERE master_id = $1', [mid]);
        await pool.query('DELETE FROM masters WHERE id = $1', [mid]);
        console.log(`🗑️ Мастер удалён: ${mid}`);
        sendJSON(res, { ok: true });
        return;
      }

      sendError(res, 'Unknown auth action', 404);
    } catch (err) {
      console.error('Auth error:', err.message);
      sendError(res, err.message, 500);
    }
    return;
  }

  // /api/v1/push/* — Web Push подписка
  if (pathParts[0] === 'api' && pathParts[1] === 'v1' && pathParts[2] === 'push') {
    const action = pathParts[3];
    try {
      // GET /api/v1/push/vapid-key — публичный VAPID ключ
      if (req.method === 'GET' && action === 'vapid-key') {
        sendJSON(res, { publicKey: process.env.VAPID_PUBLIC_KEY || '' });
        return;
      }
      // POST /api/v1/push/subscribe — сохранить подписку
      if (req.method === 'POST' && action === 'subscribe') {
        const user = getUserFromRequest(req);
        if (!user) { sendError(res, 'Unauthorized', 401); return; }
        const body = await parseBody(req);
        if (!body || !body.endpoint || !body.keys) { sendError(res, 'Invalid subscription', 400); return; }
        // Upsert: если endpoint уже есть — обновляем
        await pool.query(
          `INSERT INTO push_subscriptions (user_phone, endpoint, p256dh, auth)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (endpoint) DO UPDATE SET user_phone = $1, p256dh = $3, auth = $4`,
          [user.phone, body.endpoint, body.keys.p256dh, body.keys.auth]
        );
        sendJSON(res, { ok: true });
        return;
      }
      // POST /api/v1/push/unsubscribe — удалить подписку
      if (req.method === 'POST' && action === 'unsubscribe') {
        const body = await parseBody(req);
        if (body && body.endpoint) {
          await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [body.endpoint]);
        }
        sendJSON(res, { ok: true });
        return;
      }
      sendError(res, 'Unknown push action', 404);
    } catch (err) {
      console.error('Push error:', err.message);
      sendError(res, err.message, 500);
    }
    return;
  }

  // POST /api/v1/upload — загрузка фото
  if (req.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'v1' && pathParts[2] === 'upload') {
    const user = getUserFromRequest(req);
    if (!user) { sendError(res, 'Unauthorized', 401); return; }

    try {
      const bb = busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024 } });
      let savedUrl = null;
      let fileError = null;

      bb.on('file', (fieldname, file, info) => {
        const { filename, mimeType } = info;
        if (!mimeType.startsWith('image/')) { fileError = 'Only images allowed'; file.resume(); return; }

        const ext = path.extname(filename) || '.jpg';
        const safeName = `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
        const masterId = pathParts[3] || 'general';
        const subDir = path.join(UPLOADS_DIR, masterId);
        if (!fs.existsSync(subDir)) fs.mkdirSync(subDir, { recursive: true });

        const filePath = path.join(subDir, safeName);
        const writeStream = fs.createWriteStream(filePath);
        file.pipe(writeStream);

        writeStream.on('finish', () => {
          savedUrl = `https://api.beautyplatform.ru/uploads/${masterId}/${safeName}`;
        });
        writeStream.on('error', (err) => { fileError = err.message; });
      });

      bb.on('finish', () => {
        if (fileError) { sendError(res, fileError, 400); return; }
        if (!savedUrl) { sendError(res, 'No file received', 400); return; }
        sendJSON(res, { url: savedUrl });
      });

      bb.on('error', (err) => sendError(res, err.message, 500));
      req.pipe(bb);
    } catch (err) {
      sendError(res, err.message, 500);
    }
    return;
  }

  // POST /api/v1/delete-file — удаление фото
  if (req.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'v1' && pathParts[2] === 'delete-file') {
    const user = getUserFromRequest(req);
    if (!user) { sendError(res, 'Unauthorized', 401); return; }

    try {
      const body = await parseBody(req);
      if (!body || !body.url) { sendError(res, 'url required', 400); return; }

      // Извлекаем путь из URL: https://api.beautyplatform.ru/uploads/master-id/file.jpg
      const urlPath = body.url.replace('https://api.beautyplatform.ru/uploads/', '');
      const filePath = path.join(UPLOADS_DIR, urlPath);

      // Защита от path traversal
      if (!filePath.startsWith(UPLOADS_DIR)) { sendError(res, 'Invalid path', 400); return; }

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Фото удалено: ${filePath}`);
      }
      sendJSON(res, { ok: true });
    } catch (err) {
      sendError(res, err.message, 500);
    }
    return;
  }

  // ----------------------------------------------------------------
  // GET /api/v1/bonuses/history?limit=50&offset=0
  // Auth: JWT клиента (client_id из payload)
  // ----------------------------------------------------------------
  if (req.method === 'GET' && pathParts[0] === 'api' && pathParts[1] === 'v1' && pathParts[2] === 'bonuses' && pathParts[3] === 'history') {
    const user = getUserFromRequest(req);
    if (!user) { sendError(res, 'Unauthorized', 401); return; }
    if (!user.client_id) { sendError(res, 'Forbidden: client only', 403); return; }

    try {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const clientId = user.client_id;

      const [txResult, balResult, countResult] = await Promise.all([
        pool.query(
          `SELECT bt.id, bt.amount, bt.type, bt.description, bt.booking_id,
                  bt.created_at, bt.expires_at,
                  b.date AS booking_date, b.time AS booking_time, s.name AS service_name
           FROM bonus_transactions bt
           LEFT JOIN bookings b ON bt.booking_id = b.id
           LEFT JOIN services s ON b.service_id = s.id
           WHERE bt.client_id = $1
           ORDER BY bt.created_at DESC
           LIMIT $2 OFFSET $3`,
          [clientId, limit, offset]
        ),
        pool.query(
          `SELECT COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE -amount END), 0) AS balance
           FROM bonus_transactions WHERE client_id = $1`,
          [clientId]
        ),
        pool.query(
          `SELECT COUNT(*) AS total FROM bonus_transactions WHERE client_id = $1`,
          [clientId]
        ),
      ]);

      sendJSON(res, {
        balance: parseFloat(balResult.rows[0].balance),
        transactions: txResult.rows,
        total: parseInt(countResult.rows[0].total, 10),
        limit,
        offset,
      });
    } catch (err) {
      console.error('bonuses/history error:', err.message);
      sendError(res, err.message, 500);
    }
    return;
  }

  // ----------------------------------------------------------------
  // POST /api/v1/bookings/manual — мастер создаёт запись вручную
  // ----------------------------------------------------------------
  if (req.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'v1' && pathParts[2] === 'bookings' && pathParts[3] === 'manual') {
    const user = getUserFromRequest(req);
    if (!user) { sendError(res, 'Unauthorized', 401); return; }

    try {
      const masterId = await resolveMasterId(user);
      if (!masterId) { sendError(res, 'Forbidden: master only', 403); return; }
      const master = { id: masterId };

      const body = await parseBody(req);
      if (!body) { sendError(res, 'Empty body', 400); return; }

      const { service_id, date, time, client_phone, client_name, price, duration, notes } = body;
      // client_phone необязателен (мастер может не знать телефон при создании вручную)
      if (!service_id || !date || !time || !client_name || price == null || !duration) {
        sendError(res, 'Missing required fields: service_id, date, time, client_name, price, duration', 400);
        return;
      }

      const svcCheck = await pool.query(
        'SELECT id, name FROM services WHERE id = $1 AND master_id = $2 LIMIT 1',
        [service_id, masterId]
      );
      if (!svcCheck.rows.length) { sendError(res, 'Forbidden: service not found or belongs to another master', 403); return; }
      const serviceName = svcCheck.rows[0].name;

      const slotCheck = await pool.query(
        'SELECT id FROM bookings WHERE master_id = $1 AND date = $2 AND time = $3 LIMIT 1',
        [masterId, date, time]
      );
      if (slotCheck.rows.length) { sendError(res, 'Slot already booked', 409); return; }

      let clientId = null;
      const phoneVal = (client_phone || '').trim();
      if (phoneVal) {
        const clientSearch = await pool.query(
          'SELECT id FROM clients WHERE master_id = $1 AND phone = $2 LIMIT 1',
          [masterId, phoneVal]
        );
        if (clientSearch.rows.length) {
          clientId = clientSearch.rows[0].id;
        } else {
          try {
            // tg_user_id NOT NULL → для веб-клиентов используем 0 (плейсхолдер).
            // Реальный TG-id появится только если клиент позже залогинится через бота.
            const clientInsert = await pool.query(
              `INSERT INTO clients (master_id, tg_user_id, phone, first_name, auth_source, created_at)
               VALUES ($1, 0, $2, $3, 'manual', NOW()) RETURNING id`,
              [masterId, phoneVal, client_name]
            );
            clientId = clientInsert.rows[0].id;
          } catch (e) {
            if (e.code === '23505') {
              const retry = await pool.query(
                'SELECT id FROM clients WHERE master_id = $1 AND phone = $2 LIMIT 1',
                [masterId, phoneVal]
              );
              if (retry.rows.length) clientId = retry.rows[0].id;
              else throw e;
            } else {
              throw e;
            }
          }
        }
      } else {
        // Телефон не указан — ищем клиента только по имени, не создаём без телефона
        const nameSearch = await pool.query(
          'SELECT id FROM clients WHERE master_id = $1 AND first_name = $2 LIMIT 1',
          [masterId, client_name]
        );
        if (nameSearch.rows.length) clientId = nameSearch.rows[0].id;
      }

      const bookingResult = await pool.query(
        `INSERT INTO bookings
           (master_id, service_id, client_tg_id, client_name, client_phone, date, time, duration, price, status, notes, created_at)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, 'confirmed', $9, NOW())
         RETURNING *`,
        [masterId, service_id, client_name, client_phone || null, date, time, duration, price, notes || null]
      );
      const booking = bookingResult.rows[0];
      booking.service_name = serviceName;

      // Push клиенту (если у него есть подписка по телефону)
      if (client_phone) {
        sendPushToPhone(client_phone, {
          title: 'Вы записаны',
          body: `${serviceName} · ${formatDateRu(date)} в ${formatTimeRu(time)}`,
          type: 'booking_created',
          masterId,
          bookingId: booking.id,
        }).catch(() => {});
      }

      // Push мастеру о новой ручной записи
      {
        const mRes2 = await pool.query('SELECT phone FROM masters WHERE id = $1', [masterId]);
        const masterPhone = mRes2.rows[0]?.phone;
        if (masterPhone) {
          sendPushToPhone(masterPhone, {
            title: 'Новая запись',
            body: `Услуга: ${serviceName}\nКлиент: ${client_name}${client_phone ? ', ' + client_phone : ''}\nДата: ${formatDateRu(date)}, ${formatTimeRu(time)}`,
            type: 'booking_new',
            masterId,
            bookingId: booking.id,
          }).catch(() => {});
        }
      }

      sendJSON(res, booking, 201);
    } catch (err) {
      console.error('bookings/manual error:', err.message, err.code, err.constraint);
      if (err.code === '23505') {
        sendError(res, `Duplicate key: ${err.constraint || 'unique constraint'}`, 409);
        return;
      }
      sendError(res, err.message, 500);
    }
    return;
  }

  // ----------------------------------------------------------------
  // GET /api/v1/bookings/today — сегодняшние записи мастера
  // ----------------------------------------------------------------
  if (req.method === 'GET' && pathParts[0] === 'api' && pathParts[1] === 'v1' && pathParts[2] === 'bookings' && pathParts[3] === 'today') {
    const user = getUserFromRequest(req);
    if (!user) { sendError(res, 'Unauthorized', 401); return; }

    try {
      const masterId = await resolveMasterId(user);
      if (!masterId) { sendError(res, 'Forbidden: master only', 403); return; }
      const master = { id: masterId };

      const result = await pool.query(
        `SELECT b.id, b.time, b.duration, b.price, b.status,
                s.name AS service_name,
                COALESCE(c.first_name, b.client_name) AS client_name,
                COALESCE(c.phone, b.client_phone) AS client_phone
         FROM bookings b
         LEFT JOIN services s ON b.service_id = s.id
         LEFT JOIN clients c ON c.master_id = b.master_id AND c.phone = b.client_phone
         WHERE b.master_id = $1 AND b.date = CURRENT_DATE
           AND b.status IN ('confirmed','pending','completed')
         ORDER BY b.time ASC`,
        [master.id]
      );

      const bookings = result.rows;
      const totalAmount = bookings.reduce((sum, b) => sum + parseFloat(b.price || 0), 0);

      sendJSON(res, {
        date: new Date().toISOString().slice(0, 10),
        bookings,
        total_count: bookings.length,
        total_amount: totalAmount,
      });
    } catch (err) {
      console.error('bookings/today error:', err.message);
      sendError(res, err.message, 500);
    }
    return;
  }

  // ----------------------------------------------------------------
  // POST /api/v1/bookings/:id/complete — мастер закрывает запись и
  // система автоматически начисляет бонус клиенту (BONUS_PERCENT от цены)
  // Возвращает { ok, bonus_amount, new_balance }
  // ----------------------------------------------------------------
  if (req.method === 'POST'
      && pathParts[0] === 'api' && pathParts[1] === 'v1'
      && pathParts[2] === 'bookings' && pathParts[4] === 'complete') {
    const user = getUserFromRequest(req);
    if (!user) { sendError(res, 'Unauthorized', 401); return; }
    try {
      const masterId = await resolveMasterId(user);
      if (!masterId) { sendError(res, 'Forbidden: master only', 403); return; }
      const bookingId = pathParts[3];
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_RE.test(bookingId)) { sendError(res, 'Invalid booking id', 400); return; }

      // Загружаем booking + проверяем что он принадлежит этому мастеру
      const bRes = await pool.query(
        `SELECT b.*, s.name AS service_name FROM bookings b
         LEFT JOIN services s ON b.service_id = s.id
         WHERE b.id = $1 AND b.master_id = $2 LIMIT 1`,
        [bookingId, masterId]
      );
      if (!bRes.rows.length) { sendError(res, 'Booking not found', 404); return; }
      const booking = bRes.rows[0];
      if (booking.status === 'completed') {
        sendError(res, 'Запись уже завершена', 409);
        return;
      }
      if (booking.status === 'cancelled') {
        sendError(res, 'Нельзя завершить отменённую запись', 409);
        return;
      }

      // Считаем бонус: BONUS_PERCENT% от цены, минимум 0
      const price = parseFloat(booking.price || 0);
      const bonusAmount = Math.floor(price * BONUS_PERCENT / 100);

      // Находим клиента по client_phone (по нормализованному телефону)
      let clientId = null;
      let newBalance = null;
      if (booking.client_phone && bonusAmount > 0) {
        const phoneNorm = String(booking.client_phone).replace(/\D/g, '').slice(-10);
        const cRes = await pool.query(
          `SELECT id, COALESCE(bonus_balance, 0) AS bonus_balance FROM clients
           WHERE master_id = $1
             AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $2
           LIMIT 1`,
          [masterId, phoneNorm]
        );
        if (cRes.rows.length) {
          clientId = cRes.rows[0].id;
          const balance = parseFloat(cRes.rows[0].bonus_balance);
          newBalance = balance + bonusAmount;
          // Транзакция: запись + начисление + обновление баланса
          await pool.query('BEGIN');
          try {
            await pool.query(
              `INSERT INTO bonus_transactions (master_id, client_id, booking_id, amount, type, description, created_at)
               VALUES ($1, $2, $3, $4, 'credit', $5, NOW())`,
              [masterId, clientId, bookingId, bonusAmount, `Бонус ${BONUS_PERCENT}% за «${booking.service_name || 'услугу'}»`]
            );
            await pool.query(
              `UPDATE clients SET bonus_balance = $1 WHERE id = $2`,
              [newBalance, clientId]
            );
            await pool.query(
              `UPDATE bookings SET status = 'completed', bonus_credited = true WHERE id = $1`,
              [bookingId]
            );
            await pool.query('COMMIT');
          } catch (e) {
            await pool.query('ROLLBACK');
            throw e;
          }
        } else {
          // Клиент не найден в clients (например, гостевая запись без регистрации)
          await pool.query(`UPDATE bookings SET status = 'completed' WHERE id = $1`, [bookingId]);
        }
      } else {
        await pool.query(`UPDATE bookings SET status = 'completed' WHERE id = $1`, [bookingId]);
      }

      // Push клиенту: спасибо + начисление
      if (booking.client_phone && bonusAmount > 0) {
        sendPushToPhone(booking.client_phone, {
          title: 'Спасибо за визит!',
          body: `Начислено ${bonusAmount} бонусов · Услуга «${booking.service_name || ''}»`,
          type: 'bonus_credited',
          masterId,
          bookingId,
          data: { bonus_amount: bonusAmount, new_balance: newBalance },
        }).catch(() => {});
      }

      sendJSON(res, {
        ok: true,
        bonus_amount: bonusAmount,
        bonus_percent: BONUS_PERCENT,
        new_balance: newBalance,
        client_phone: booking.client_phone,
        client_name: booking.client_name,
        booking_id: bookingId,
      });
    } catch (err) {
      console.error('bookings/complete error:', err.message);
      sendError(res, err.message, 500);
    }
    return;
  }

  // ----------------------------------------------------------------
  // GET /api/v1/bookings/by-date?date=YYYY-MM-DD
  // ----------------------------------------------------------------
  if (req.method === 'GET' && pathParts[0] === 'api' && pathParts[1] === 'v1' && pathParts[2] === 'bookings' && pathParts[3] === 'by-date') {
    const user = getUserFromRequest(req);
    if (!user) { sendError(res, 'Unauthorized', 401); return; }

    try {
      const masterId = await resolveMasterId(user);
      if (!masterId) { sendError(res, 'Forbidden: master only', 403); return; }
      const master = { id: masterId };

      const dateParam = url.searchParams.get('date') || '';
      if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        sendError(res, 'Invalid date format, expected YYYY-MM-DD', 400);
        return;
      }
      const dateValue = dateParam || new Date().toISOString().slice(0, 10);

      const result = await pool.query(
        `SELECT b.id, b.time, b.duration, b.price, b.status,
                s.name AS service_name,
                COALESCE(c.first_name, b.client_name) AS client_name,
                COALESCE(c.phone, b.client_phone) AS client_phone
         FROM bookings b
         LEFT JOIN services s ON b.service_id = s.id
         LEFT JOIN clients c ON c.master_id = b.master_id AND c.phone = b.client_phone
         WHERE b.master_id = $1 AND b.date = $2
           AND b.status IN ('confirmed','pending','completed','cancelled')
         ORDER BY b.time ASC`,
        [master.id, dateValue]
      );

      const bookings = result.rows;
      let totalAmount = 0, confirmedAmount = 0, completedAmount = 0;
      let confirmedCount = 0, completedCount = 0, cancelledCount = 0;
      for (const b of bookings) {
        const p = parseFloat(b.price || 0);
        if (b.status === 'confirmed') { confirmedCount++; confirmedAmount += p; totalAmount += p; }
        else if (b.status === 'completed') { completedCount++; completedAmount += p; totalAmount += p; }
        else if (b.status === 'pending') { totalAmount += p; }
        else if (b.status === 'cancelled') { cancelledCount++; }
      }

      sendJSON(res, {
        date: dateValue,
        bookings,
        summary: {
          total_count: bookings.length,
          confirmed_count: confirmedCount,
          completed_count: completedCount,
          cancelled_count: cancelledCount,
          total_amount: totalAmount,
          confirmed_amount: confirmedAmount,
          completed_amount: completedAmount,
        },
      });
    } catch (err) {
      console.error('bookings/by-date error:', err.message);
      sendError(res, err.message, 500);
    }
    return;
  }

  // /api/v1/{table}
  if (pathParts[0] !== 'api' || pathParts[1] !== 'v1' || !pathParts[2]) {
    sendError(res, 'Not found', 404);
    return;
  }

  const table = pathParts[2];
  if (!ALLOWED_TABLES.includes(table)) {
    sendError(res, 'Invalid table', 400);
    return;
  }

  const authLevel = getAuthLevel(req);
  const query = Object.fromEntries(url.searchParams);

  try {
    switch (req.method) {
      case 'GET': {
        if (!PUBLIC_TABLES.includes(table) && authLevel !== 'service') {
          sendError(res, 'Unauthorized', 401);
          return;
        }

        const { filters, values, orderBy, limit, selectFields, offset } = parseFilters(query);

        const MASTERS_PUBLIC_FIELDS = 'id, name, description, slug, bot_username, avatar_url, phone, whatsapp_url, welcome_text, is_active, created_at, yandex_maps_url, address, studio_name';
        const baseSelect = (authLevel !== 'service' && table === 'masters')
          ? MASTERS_PUBLIC_FIELDS
          : '*';
        let sql = `SELECT ${baseSelect} FROM "${table}"`;

        // Публичный доступ — фильтр по is_active
        if (authLevel !== 'service') {
          if (['masters', 'categories', 'services', 'schedule', 'faq', 'abonements'].includes(table)) {
            if (!filters.some(f => f.includes('"is_active"'))) {
              filters.push(`"is_active" = true`);
            }
          }
          if (table === 'bookings') {
            if (!filters.some(f => f.includes('"status"'))) {
              filters.push(`"status" IN ('confirmed', 'pending')`);
            }
          }
          // Notifications — только свои (по JWT). Сравниваем нормализованные
          // последние 10 цифр, потому что user_phone в БД может быть в формате
          // '+79886...', '79886...', '89886...', '9886...' (разные хуки писали
          // в разное время) — а JWT содержит один конкретный формат.
          if (table === 'notifications') {
            const jwtUser = getUserFromRequest(req);
            if (!jwtUser || !jwtUser.phone) {
              sendError(res, 'Unauthorized', 401); return;
            }
            const phoneNorm = String(jwtUser.phone).replace(/\D/g, '').slice(-10);
            filters.push(`right(regexp_replace("user_phone", '[^0-9]', '', 'g'), 10) = $${values.length + 1}`);
            values.push(phoneNorm);
          }
        }

        if (filters.length) sql += ` WHERE ${filters.join(' AND ')}`;
        if (orderBy) sql += ` ORDER BY ${orderBy}`;
        if (limit) sql += ` LIMIT ${limit}`;
        if (offset) sql += ` OFFSET ${offset}`;

        const result = await pool.query(sql, values);

        // Вложенные запросы: services(name) → LEFT JOIN
        if (selectFields && selectFields.includes('(')) {
          const joinMatch = selectFields.match(/(\w+)\(([^)]+)\)/);
          if (joinMatch) {
            const [, joinTable, joinCols] = joinMatch;
            const fk = joinTable.replace(/s$/, '') + '_id';
            const fkValues = [...new Set(result.rows.map(r => r[fk]).filter(Boolean))];
            if (fkValues.length > 0) {
              const ph = fkValues.map((_, i) => `$${i + 1}`).join(',');
              const jr = await pool.query(
                `SELECT id, ${joinCols} FROM "${joinTable}" WHERE id IN (${ph})`, fkValues
              );
              const map = {};
              for (const row of jr.rows) map[row.id] = row;
              for (const row of result.rows) {
                if (row[fk] && map[row[fk]]) row[joinTable] = map[row[fk]];
              }
            }
          }
        }

        sendJSON(res, result.rows);
        break;
      }

      case 'POST': {
        if (authLevel !== 'service' && !['bookings', 'clients', 'notifications'].includes(table)) {
          sendError(res, 'Unauthorized', 401);
          return;
        }

        const data = await parseBody(req);
        if (!data) { sendError(res, 'Empty body'); return; }

        // Для публичного POST bookings/clients/notifications — проверяем JWT
        if (authLevel !== 'service') {
          const jwtUser = getUserFromRequest(req);
          if (!jwtUser) { sendError(res, 'Unauthorized', 401); return; }

          if (table === 'bookings' || table === 'notifications') {
            // Мастер, которому принадлежит запись, должен существовать
            if (data.master_id) {
              const masterExists = await pool.query('SELECT id FROM masters WHERE id = $1', [data.master_id]);
              if (!masterExists.rows.length) { sendError(res, 'Forbidden', 403); return; }
            }
          }

          if (table === 'clients') {
            // Клиент может создавать только запись о себе. Нормализуем телефоны
            // (8XXX = +7XXX = 7XXX) — иначе legitimate user блокируется из-за формата.
            if (data.phone) {
              const a = String(data.phone).replace(/\D/g, '').slice(-10);
              const b = String(jwtUser.phone || '').replace(/\D/g, '').slice(-10);
              if (a !== b) { sendError(res, 'Forbidden', 403); return; }
            }
          }
        }

        const keys = Object.keys(data);
        const vals = Object.values(data);
        const placeholders = vals.map((_, i) => `$${i + 1}`);

        const sql = `INSERT INTO "${table}" (${keys.map(k => `"${k}"`).join(',')}) VALUES (${placeholders.join(',')}) RETURNING *`;
        const result = await pool.query(sql, vals);

        // Push при создании записи: и клиенту (подтверждение), и мастеру (новая запись).
        if (table === 'bookings' && result.rows[0]) {
          try {
            const b = result.rows[0];
            const mRes = await pool.query(
              'SELECT phone, name, studio_name, address FROM masters WHERE id = $1',
              [b.master_id]
            );
            const master = mRes.rows[0];
            const dRu = formatDateRu(b.date);
            const tRu = formatTimeRu(b.time);
            const placeName = master?.studio_name || master?.name || '';

            // Push мастеру
            if (master?.phone) {
              // Получаем название услуги для push
              let svcNameForPush = '';
              try {
                const svcRes = await pool.query('SELECT name FROM services WHERE id = $1', [b.service_id]);
                svcNameForPush = svcRes.rows[0]?.name || '';
              } catch (_) {}
              sendPushToPhone(master.phone, {
                title: 'Новая запись',
                body: `Услуга: ${svcNameForPush}\nКлиент: ${b.client_name || 'Клиент'}${b.client_phone ? ', ' + b.client_phone : ''}\nДата: ${dRu}, ${tRu}`,
                type: 'booking_new',
                masterId: b.master_id,
                bookingId: b.id,
              }).catch(() => {});
            }

            // Push клиенту-самому-себе («Вы записаны»)
            if (b.client_phone) {
              const placeTxt = placeName ? `Запись в ${placeName} · ` : '';
              sendPushToPhone(b.client_phone, {
                title: 'Вы записаны',
                body: `${placeTxt}${dRu} в ${tRu}${master?.address ? '. Адрес: ' + master.address : ''}`,
                type: 'booking_confirmed',
                masterId: b.master_id,
                bookingId: b.id,
              }).catch(() => {});
            }
          } catch (e) { /* swallow */ }
        }

        sendJSON(res, result.rows, 201);
        break;
      }

      case 'PATCH': {
        const masterOwnedPatchTables = ['masters', 'categories', 'services', 'schedule', 'day_overrides', 'bookings', 'clients', 'faq', 'abonements', 'notifications'];
        if (authLevel !== 'service' && !masterOwnedPatchTables.includes(table)) {
          sendError(res, 'Unauthorized', 401);
          return;
        }

        const jwtUser = authLevel !== 'service' ? getUserFromRequest(req) : null;
        if (authLevel !== 'service' && !jwtUser) { sendError(res, 'Unauthorized', 401); return; }

        const patchData = await parseBody(req);
        if (!patchData) { sendError(res, 'Empty body'); return; }

        const { filters, values: filterValues } = parseFilters(query);
        if (!filters.length) { sendError(res, 'No filter for PATCH'); return; }

        // Для не-service запросов: добавляем фильтр по владельцу
        if (authLevel !== 'service' && jwtUser) {
          const masterId = await resolveMasterId(jwtUser);
          const master = masterId ? { id: masterId } : null;

          if (['categories', 'services', 'schedule', 'day_overrides', 'faq', 'abonements'].includes(table)) {
            if (!master) { sendError(res, 'Forbidden', 403); return; }
            filterValues.push(master.id);
            filters.push(`"master_id" = $${filterValues.length}`);
          } else if (table === 'masters') {
            if (!master) { sendError(res, 'Forbidden', 403); return; }
            filterValues.push(master.id);
            filters.push(`"id" = $${filterValues.length}`);
          } else if (table === 'bookings') {
            if (master) {
              filterValues.push(master.id);
              filters.push(`"master_id" = $${filterValues.length}`);
            } else if (jwtUser.phone) {
              const phoneNorm = String(jwtUser.phone).replace(/\D/g, '').slice(-10);
              filterValues.push(phoneNorm);
              filters.push(`right(regexp_replace("client_phone", '[^0-9]', '', 'g'), 10) = $${filterValues.length}`);
            } else {
              sendError(res, 'Forbidden', 403); return;
            }
          } else if (table === 'clients') {
            if (!jwtUser.client_id) { sendError(res, 'Forbidden', 403); return; }
            filterValues.push(jwtUser.client_id);
            filters.push(`"id" = $${filterValues.length}`);
          } else if (table === 'notifications') {
            // Уведомления видит только их владелец (по нормализованному телефону)
            if (!jwtUser.phone) { sendError(res, 'Forbidden', 403); return; }
            const phoneNorm = String(jwtUser.phone).replace(/\D/g, '').slice(-10);
            filterValues.push(phoneNorm);
            filters.push(`right(regexp_replace("user_phone", '[^0-9]', '', 'g'), 10) = $${filterValues.length}`);
          }
        }

        const setClauses = [];
        const allValues = [...filterValues];
        for (const [k, v] of Object.entries(patchData)) {
          allValues.push(v);
          setClauses.push(`"${k}" = $${allValues.length}`);
        }

        const sql = `UPDATE "${table}" SET ${setClauses.join(', ')} WHERE ${filters.join(' AND ')} RETURNING *`;
        const result = await pool.query(sql, allValues);

        // Push клиенту при изменении его записи мастером (cancel/reschedule)
        if (table === 'bookings' && authLevel !== 'service') {
          for (const row of result.rows) {
            if (!row.client_phone) continue;
            try {
              if (patchData.status === 'cancelled') {
                const dRu = formatDateRu(row.date);
                sendPushToPhone(row.client_phone, {
                  title: 'Запись отменена',
                  body: dRu ? `Ваша запись на ${dRu} в ${formatTimeRu(row.time)} отменена` : 'Ваша запись отменена',
                  type: 'booking_cancelled',
                  masterId: row.master_id,
                  bookingId: row.id,
                }).catch(() => {});
              } else if (patchData.date || patchData.time) {
                const dRu = formatDateRu(row.date);
                sendPushToPhone(row.client_phone, {
                  title: 'Запись перенесена',
                  body: dRu ? `Новое время: ${dRu} в ${formatTimeRu(row.time)}` : 'Время записи изменено',
                  type: 'booking_rescheduled',
                  masterId: row.master_id,
                  bookingId: row.id,
                }).catch(() => {});
              }
            } catch (e) { /* push errors swallowed */ }
          }
        }

        sendJSON(res, result.rows);
        break;
      }

      case 'DELETE': {
        const masterOwnedDeleteTables = ['bookings', 'categories', 'services', 'schedule', 'day_overrides', 'faq', 'abonements'];
        if (authLevel !== 'service' && !masterOwnedDeleteTables.includes(table)) {
          sendError(res, 'Unauthorized', 401);
          return;
        }

        const jwtUserDel = authLevel !== 'service' ? getUserFromRequest(req) : null;
        if (authLevel !== 'service' && !jwtUserDel) { sendError(res, 'Unauthorized', 401); return; }

        const { filters: delFilters, values: delValues } = parseFilters(query);
        if (!delFilters.length) { sendError(res, 'No filter for DELETE'); return; }

        // Для не-service запросов: добавляем фильтр по владельцу
        if (authLevel !== 'service' && jwtUserDel) {
          const masterIdDel = await resolveMasterId(jwtUserDel);
          const masterDel = masterIdDel ? { id: masterIdDel } : null;

          if (['categories', 'services', 'schedule', 'day_overrides', 'faq', 'abonements'].includes(table)) {
            if (!masterDel) { sendError(res, 'Forbidden', 403); return; }
            delValues.push(masterDel.id);
            delFilters.push(`"master_id" = $${delValues.length}`);
          } else if (table === 'bookings') {
            if (masterDel) {
              delValues.push(masterDel.id);
              delFilters.push(`"master_id" = $${delValues.length}`);
            } else if (jwtUserDel.phone) {
              const phoneNorm = String(jwtUserDel.phone).replace(/\D/g, '').slice(-10);
              delValues.push(phoneNorm);
              delFilters.push(`right(regexp_replace("client_phone", '[^0-9]', '', 'g'), 10) = $${delValues.length}`);
            } else {
              sendError(res, 'Forbidden', 403); return;
            }
          }
        }

        const sql = `DELETE FROM "${table}" WHERE ${delFilters.join(' AND ')}`;
        await pool.query(sql, delValues);
        sendJSON(res, { deleted: true });
        break;
      }

      default:
        sendError(res, 'Method not allowed', 405);
    }
  } catch (err) {
    console.error(`API Error [${req.method} ${table}]:`, err.message);
    if (err.code === '23505') { sendError(res, `Duplicate: ${err.detail}`, 409); return; }
    if (err.code === '23503') {
      // Foreign key violation — например услуга используется в записях
      let msg = 'Нельзя удалить — есть связанные записи';
      if (err.constraint?.includes('service_id')) msg = 'Нельзя удалить услугу — на неё уже есть записи. Сначала отмените или удалите эти записи, либо отключите услугу через флаг "is_active=false"';
      else if (err.constraint?.includes('category_id')) msg = 'Нельзя удалить категорию — в ней есть услуги. Сначала перенесите услуги или удалите их';
      sendError(res, msg, 409);
      return;
    }
    sendError(res, err.message, 500);
  }
}

// --- Запуск ---
const server = http.createServer(handleRequest);
server.listen(API_PORT, '0.0.0.0', () => {
  console.log(`🚀 Beauty API server running on port ${API_PORT}`);
  pool.query('SELECT 1').then(() => {
    console.log('✅ PostgreSQL connected');
  }).catch(err => {
    console.error('❌ PostgreSQL connection failed:', err.message);
  });
});
