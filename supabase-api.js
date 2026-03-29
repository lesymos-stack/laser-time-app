/**
 * api.js — Загрузка данных из REST API (PostgreSQL на VPS, Россия)
 *
 * Этот файл — «курьер» между приложением и базой данных.
 * Он знает, куда идти за данными и как их принести.
 *
 * Как работает мультитенант (много мастеров в одном приложении):
 * 1. Клиент открывает Mini App из бота мастера
 * 2. В URL есть параметр ?bot=lasertime_prilo_bot
 * 3. По этому username мы находим мастера в базе
 * 4. Все данные фильтруются по master_id — клиент видит только «свой» каталог
 */

// === REST API клиент ===

const API = {
  url: API_BASE_URL,  // из config.js
  key: API_KEY,       // из config.js

  // Базовый GET-запрос (с таймаутом 10 сек)
  async fetch(table, query = '') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`${this.url}/api/v1/${table}?${query}`, {
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': this.key,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        console.error(`API error: ${response.status} ${response.statusText}`);
        return null;
      }

      return response.json();
    } catch (e) {
      clearTimeout(timer);
      console.error('API fetch failed:', e.message);
      throw e;
    }
  },

  // POST-запрос (для создания записей)
  async post(table, data) {
    const response = await fetch(`${this.url}/api/v1/${table}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': this.key,
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error(`API POST ${table} error: ${response.status} ${response.statusText}`, errText);
      window.__lastApiError = `POST ${table}: ${response.status} — ${errText}`;
      return null;
    }

    window.__lastApiError = null;
    return response.json();
  },

  // PATCH-запрос (для обновления записей)
  async patch(table, query, data) {
    const response = await fetch(`${this.url}/api/v1/${table}?${query}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': this.key,
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      console.error('API PATCH error:', response.status);
      return null;
    }

    return response.json();
  },

  // DELETE-запрос
  async delete(table, query) {
    const response = await fetch(`${this.url}/api/v1/${table}?${query}`, {
      method: 'DELETE',
      headers: {
        'X-Api-Key': this.key,
      },
    });

    if (!response.ok) {
      console.error('API DELETE error:', response.status);
      return false;
    }

    return true;
  },

  // Загрузка файла на VPS
  async uploadFile(bucket, filePath, file) {
    const auth = typeof getStoredAuth === 'function' ? getStoredAuth() : null;
    if (!auth) return null;
    try {
      const masterId = filePath.split('/')[0] || 'general';
      const formData = new FormData();
      formData.append('file', file, file.name || 'photo.jpg');
      const res = await fetch(`${API_BASE_URL}/api/v1/upload/${masterId}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${auth.access_token}` },
        body: formData,
      });
      if (!res.ok) { console.error('Upload failed:', await res.text()); return null; }
      const data = await res.json();
      return data.url || null;
    } catch (err) {
      console.error('Upload error:', err.message);
      return null;
    }
  },

  // Удаление файла
  async deleteFile(bucket, paths) {
    console.warn('deleteFile: file storage not yet migrated to VPS');
    return false;
  },
};


// === Определение мастера ===

// Получаем идентификатор мастера из URL (?bot=xxx или ?master=slug)
function getMasterIdentifier() {
  const params = new URLSearchParams(window.location.search);
  return {
    bot: params.get('bot'),
    master: params.get('master'),
  };
}

// Обратная совместимость
function getBotUsername() {
  return getMasterIdentifier().bot;
}

// Загружаем мастера по bot_username или slug
async function loadMaster(identifier) {
  // Строка — старый формат (bot_username)
  if (typeof identifier === 'string') {
    identifier = { bot: identifier };
  }

  if (identifier && identifier.bot) {
    const masters = await API.fetch('masters', `bot_username=eq.${identifier.bot}&is_active=eq.true`);
    return masters && masters[0] ? masters[0] : null;
  }

  if (identifier && identifier.master) {
    const masters = await API.fetch('masters', `slug=eq.${identifier.master}&is_active=eq.true`);
    return masters && masters[0] ? masters[0] : null;
  }

  // Нет параметра — мастер не определён, возвращаем null
  console.warn('Нет параметра ?bot= или ?master= в URL');
  return null;
}


// === Загрузка данных для конкретного мастера ===

async function loadCategories(masterId) {
  return API.fetch('categories',
    `master_id=eq.${masterId}&is_active=eq.true&order=sort_order.asc`
  ) || [];
}

async function loadServices(masterId) {
  return API.fetch('services',
    `master_id=eq.${masterId}&is_active=eq.true&order=sort_order.asc`
  ) || [];
}

async function loadSchedule(masterId) {
  return API.fetch('schedule',
    `master_id=eq.${masterId}&is_active=eq.true&order=day_of_week.asc`
  ) || [];
}

async function loadAllSchedule(masterId) {
  return API.fetch('schedule',
    `master_id=eq.${masterId}&order=day_of_week.asc`
  ) || [];
}

async function saveScheduleDay(data) {
  return API.post('schedule', data);
}

async function updateScheduleDay(id, data) {
  return API.patch('schedule', `id=eq.${id}`, data);
}

async function deleteScheduleDay(id) {
  return API.delete('schedule', `id=eq.${id}`);
}

async function saveDayOverride(data) {
  return API.post('day_overrides', data);
}

async function updateDayOverride(id, data) {
  return API.patch('day_overrides', `id=eq.${id}`, data);
}

async function deleteDayOverride(id) {
  return API.delete('day_overrides', `id=eq.${id}`);
}

async function loadDayOverrides(masterId, fromDate, toDate) {
  return API.fetch('day_overrides',
    `master_id=eq.${masterId}&date=gte.${fromDate}&date=lte.${toDate}`
  ) || [];
}

async function loadBookedSlots(masterId, fromDate, toDate) {
  return API.fetch('bookings',
    `master_id=eq.${masterId}&date=gte.${fromDate}&date=lte.${toDate}&status=in.(confirmed,pending,completed)&select=date,time,duration`
  ) || [];
}

async function loadFaq(masterId) {
  return API.fetch('faq',
    `master_id=eq.${masterId}&is_active=eq.true&order=sort_order.asc`
  ) || [];
}

// Загрузить клиента по Telegram ID (для бонусов и истории)
async function loadClient(masterId, tgUserId, phone) {
  // Поиск по tg_user_id (Telegram) или по phone (веб)
  if (tgUserId) {
    const clients = await API.fetch('clients',
      `master_id=eq.${masterId}&tg_user_id=eq.${tgUserId}`
    );
    if (clients && clients[0]) return clients[0];
  }
  if (phone) {
    const clients = await API.fetch('clients',
      `master_id=eq.${masterId}&phone=eq.${encodeURIComponent(phone)}`
    );
    if (clients && clients[0]) return clients[0];
  }
  return null;
}

// Загрузить записи клиента (для экрана «Мои записи»)
async function loadClientBookings(masterId, tgUserId, phone) {
  if (tgUserId) {
    return API.fetch('bookings',
      `master_id=eq.${masterId}&client_tg_id=eq.${tgUserId}&order=date.desc,time.desc&select=*,services(name)`
    ) || [];
  }
  if (phone) {
    return API.fetch('bookings',
      `master_id=eq.${masterId}&client_phone=eq.${encodeURIComponent(phone)}&order=date.desc,time.desc&select=*,services(name)`
    ) || [];
  }
  return [];
}


// === Создание записи ===

async function createBooking(bookingData) {
  console.log('📤 createBooking отправляем:', JSON.stringify(bookingData));
  // Удаляем отменённые записи на этот же слот (иначе unique constraint не даст создать)
  await API.delete('bookings',
    `master_id=eq.${bookingData.master_id}&date=eq.${bookingData.date}&time=eq.${bookingData.time}&status=in.(cancelled,no_show)`
  );
  const result = await API.post('bookings', bookingData);
  console.log('📥 createBooking ответ:', result);
  return result;
}

// === Создание/обновление клиента ===

async function upsertClient(masterId, tgUser, phone) {
  // Проверяем, есть ли уже клиент (по tg_user_id или phone)
  const existing = await loadClient(masterId, tgUser.id || 0, phone);

  if (existing) {
    const updates = {};
    if (phone && !existing.phone) updates.phone = phone;
    if (tgUser.id && !existing.tg_user_id) updates.tg_user_id = tgUser.id;
    if (Object.keys(updates).length > 0) {
      await API.patch('clients', `id=eq.${existing.id}`, updates);
    }
    return existing;
  }

  // Создаём нового клиента
  const data = {
    master_id: masterId,
    tg_user_id: tgUser.id || 0,
    first_name: tgUser.first_name || '',
    username: tgUser.username || '',
    auth_source: tgUser.id ? 'telegram' : 'web',
  };
  if (phone) data.phone = phone;
  return API.post('clients', data);
}


// === Обновление профиля мастера ===

async function updateMaster(masterId, data) {
  return API.patch('masters', `id=eq.${masterId}`, data);
}

// === Вычисление свободных слотов ===
// Берём шаблон расписания + исключения + занятые слоты → возвращаем свободные

// Перевод "HH:MM" в минуты от полуночи
function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function computeAvailableSlots(scheduleRows, overrides, bookedSlots, daysAhead = 14) {
  const slots = {};
  const today = new Date();

  // Подготовка: занятые интервалы по дням { "2026-03-20": [{start: 600, end: 660}, ...] }
  const busyByDate = {};
  for (const b of bookedSlots) {
    const startMin = timeToMinutes(b.time.substring(0, 5));
    const dur = b.duration || 30;
    if (!busyByDate[b.date]) busyByDate[b.date] = [];
    busyByDate[b.date].push({ start: startMin, end: startMin + dur });
  }

  for (let i = 0; i < daysAhead; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);

    const dateKey = formatDateKey(date);
    const dayOfWeek = date.getDay();

    const override = overrides.find(o => o.date === dateKey);
    if (override && override.is_day_off) continue;

    const scheduleRow = scheduleRows.find(s => s.day_of_week === dayOfWeek);
    if (!scheduleRow) continue;

    const startTime = override && override.start_time ? override.start_time : scheduleRow.start_time;
    const endTime = override && override.end_time ? override.end_time : scheduleRow.end_time;
    const interval = scheduleRow.slot_interval;

    const daySlots = generateTimeSlots(startTime, endTime, interval);
    const busy = busyByDate[dateKey] || [];

    // Фильтруем: слот свободен, если ни одна запись не перекрывает его
    slots[dateKey] = daySlots.filter(slotTime => {
      const slotMin = timeToMinutes(slotTime);
      // Проверяем: этот слот попадает внутрь какой-то занятой записи?
      return !busy.some(b => slotMin >= b.start && slotMin < b.end);
    });
  }

  return slots;
}

// Глобально доступные занятые интервалы (для проверки длительности на клиенте)
let BUSY_INTERVALS = {};

function computeBusyIntervals(bookedSlots) {
  const busy = {};
  for (const b of bookedSlots) {
    const startMin = timeToMinutes(b.time.substring(0, 5));
    const dur = b.duration || 30;
    if (!busy[b.date]) busy[b.date] = [];
    busy[b.date].push({ start: startMin, end: startMin + dur });
  }
  return busy;
}

// Генерация массива слотов: "10:00", "10:30", "11:00", ...
function generateTimeSlots(startTime, endTime, intervalMinutes) {
  const slots = [];
  const [startH, startM] = startTime.split(':').map(Number);
  const [endH, endM] = endTime.split(':').map(Number);

  let current = startH * 60 + startM;
  const end = endH * 60 + endM;

  while (current < end) {
    const h = String(Math.floor(current / 60)).padStart(2, '0');
    const m = String(current % 60).padStart(2, '0');
    slots.push(`${h}:${m}`);
    current += intervalMinutes;
  }

  return slots;
}

// Формат даты: "2026-03-17"
function formatDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}


// === Админ-функции для панели мастера ===

// Все записи мастера (будущие + сегодня)
async function loadMasterBookings(masterId) {
  const today = formatDateKey(new Date());
  return API.fetch('bookings',
    `master_id=eq.${masterId}&date=gte.${today}&order=date.asc,time.asc&select=*,services(name)`
  ) || [];
}

// Обновить статус записи
async function updateBookingStatus(bookingId, status) {
  return API.patch('bookings', `id=eq.${bookingId}`, { status });
}

// ВСЕ услуги мастера (включая неактивные)
async function loadAllServices(masterId) {
  return API.fetch('services',
    `master_id=eq.${masterId}&order=sort_order.asc&select=*`
  ) || [];
}

// Создать услугу
async function addService(data) {
  return API.post('services', data);
}

// Обновить услугу
async function updateService(serviceId, data) {
  return API.patch('services', `id=eq.${serviceId}`, data);
}

// Удалить услугу
async function deleteService(serviceId) {
  return API.delete('services', `id=eq.${serviceId}`);
}

// Загрузить фото услуги
async function uploadServicePhoto(file, masterId) {
  const ext = file.name.split('.').pop() || 'jpg';
  const fileName = `${masterId}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  return API.uploadFile('photos', fileName, file);
}

// ВСЕ категории мастера (включая неактивные)
async function loadAllCategories(masterId) {
  return API.fetch('categories',
    `master_id=eq.${masterId}&order=sort_order.asc&select=*`
  ) || [];
}

// Создать категорию
async function addCategory(data) {
  return API.post('categories', data);
}

// Обновить категорию
async function updateCategory(categoryId, data) {
  return API.patch('categories', `id=eq.${categoryId}`, data);
}

// Удалить категорию
async function deleteCategory(categoryId) {
  return API.delete('categories', `id=eq.${categoryId}`);
}

// === Абонементы ===

async function loadAbonements(masterId) {
  return API.fetch('abonements',
    `master_id=eq.${masterId}&is_active=eq.true&order=sort_order.asc,sessions.asc&select=*`
  ) || [];
}

async function addAbonement(data) {
  return API.post('abonements', data);
}

async function updateAbonement(id, data) {
  return API.patch('abonements', `id=eq.${id}`, data);
}

async function deleteAbonement(id) {
  return API.delete('abonements', `id=eq.${id}`);
}

// Все клиенты мастера
async function loadMasterClients(masterId) {
  return API.fetch('clients',
    `master_id=eq.${masterId}&order=created_at.desc&select=*`
  ) || [];
}

// === Бонусная система ===

// Начислить бонусы за визит (3% от суммы)
async function creditBonus(masterId, clientTgId, bookingId, amount) {
  // Находим клиента
  const clients = await API.fetch('clients',
    `master_id=eq.${masterId}&tg_user_id=eq.${clientTgId}&select=id,bonus_balance`
  );
  if (!clients || !clients[0]) return null;

  const client = clients[0];
  const bonusAmount = Math.round(amount * 0.03 * 100) / 100; // 3%
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + 3); // через 3 месяца

  // Создаём транзакцию
  await API.post('bonus_transactions', {
    master_id: masterId,
    client_id: client.id,
    booking_id: bookingId,
    amount: bonusAmount,
    type: 'credit',
    description: `Начисление 3% за визит`,
    expires_at: expiresAt.toISOString(),
  });

  // Обновляем баланс клиента
  const newBalance = parseFloat(client.bonus_balance || 0) + bonusAmount;
  await API.patch('clients', `id=eq.${client.id}`, { bonus_balance: newBalance });

  // Помечаем запись как bonus_credited
  await API.patch('bookings', `id=eq.${bookingId}`, { bonus_credited: true });

  return bonusAmount;
}

// Списать бонусы при записи
async function debitBonus(masterId, clientTgId, amount, phone) {
  let clients;
  if (clientTgId) {
    clients = await API.fetch('clients',
      `master_id=eq.${masterId}&tg_user_id=eq.${clientTgId}&select=id,bonus_balance`
    );
  }
  if ((!clients || !clients[0]) && phone) {
    clients = await API.fetch('clients',
      `master_id=eq.${masterId}&phone=eq.${encodeURIComponent(phone)}&select=id,bonus_balance`
    );
  }
  if (!clients || !clients[0]) return false;

  const client = clients[0];
  const balance = parseFloat(client.bonus_balance || 0);
  if (amount > balance) return false;

  // Создаём транзакцию списания
  await API.post('bonus_transactions', {
    master_id: masterId,
    client_id: client.id,
    amount: -amount,
    type: 'debit',
    description: `Списание бонусов за услугу`,
  });

  // Обновляем баланс
  const newBalance = balance - amount;
  await API.patch('clients', `id=eq.${client.id}`, { bonus_balance: newBalance });

  return true;
}

// Сгорание бонусов (вызывается при загрузке данных)
async function expireOldBonuses(masterId, clientId) {
  const now = new Date().toISOString();
  // Находим просроченные начисления, которые ещё не сгорели
  const expired = await API.fetch('bonus_transactions',
    `client_id=eq.${clientId}&type=eq.credit&expires_at=lt.${now}&select=id,amount`
  );
  if (!expired || expired.length === 0) return 0;

  // Проверяем, не было ли уже записи о сгорании для этих транзакций
  let totalExpired = 0;
  for (const tx of expired) {
    // Помечаем как сгоревшее через создание транзакции expire
    const existing = await API.fetch('bonus_transactions',
      `client_id=eq.${clientId}&type=eq.expire&description=eq.ref:${tx.id}&select=id`
    );
    if (existing && existing.length > 0) continue;

    await API.post('bonus_transactions', {
      master_id: masterId,
      client_id: clientId,
      amount: -tx.amount,
      type: 'expire',
      description: `ref:${tx.id}`,
    });
    totalExpired += parseFloat(tx.amount);
  }

  if (totalExpired > 0) {
    // Обновляем баланс
    const clients = await API.fetch('clients', `id=eq.${clientId}&select=bonus_balance`);
    if (clients && clients[0]) {
      const newBalance = Math.max(0, parseFloat(clients[0].bonus_balance || 0) - totalExpired);
      await API.patch('clients', `id=eq.${clientId}`, { bonus_balance: newBalance });
    }
  }

  return totalExpired;
}

// Загрузить историю бонусов клиента
async function loadBonusHistory(clientId) {
  return API.fetch('bonus_transactions',
    `client_id=eq.${clientId}&order=created_at.desc&limit=20`
  ) || [];
}

// Загрузить бонусный баланс клиента
async function loadClientBonus(masterId, tgUserId, phone) {
  let clients;
  if (tgUserId) {
    clients = await API.fetch('clients',
      `master_id=eq.${masterId}&tg_user_id=eq.${tgUserId}&select=id,bonus_balance`
    );
  }
  if ((!clients || !clients[0]) && phone) {
    clients = await API.fetch('clients',
      `master_id=eq.${masterId}&phone=eq.${encodeURIComponent(phone)}&select=id,bonus_balance`
    );
  }
  if (!clients || !clients[0]) return { balance: 0, clientId: null };

  // Проверяем сгорание
  await expireOldBonuses(masterId, clients[0].id);

  // Перечитываем баланс после сгорания
  const updated = await API.fetch('clients', `id=eq.${clients[0].id}&select=bonus_balance`);
  return {
    balance: parseFloat(updated?.[0]?.bonus_balance || 0),
    clientId: clients[0].id,
  };
}

// === Главная функция загрузки всех данных ===

async function loadAllData() {
  // 1. Определяем мастера (по ?bot= или ?master=)
  const identifier = getMasterIdentifier();
  const master = await loadMaster(identifier);

  if (!master) {
    console.error('Мастер не найден!');
    return null;
  }

  // 2. Загружаем все данные параллельно (быстрее!)
  const today = formatDateKey(new Date());
  const twoWeeks = new Date();
  twoWeeks.setDate(twoWeeks.getDate() + 14);
  const toDate = formatDateKey(twoWeeks);

  const [categories, services, scheduleRows, overrides, bookedSlots] = await Promise.all([
    loadCategories(master.id),
    loadServices(master.id),
    loadSchedule(master.id),
    loadDayOverrides(master.id, today, toDate),
    loadBookedSlots(master.id, today, toDate),
  ]);

  // 3. Вычисляем свободные слоты
  const schedule = computeAvailableSlots(scheduleRows, overrides, bookedSlots);

  // 4. Вычисляем занятые интервалы (для проверки длительности на клиенте)
  BUSY_INTERVALS = computeBusyIntervals(bookedSlots);

  // 5. Возвращаем всё в формате, совместимом с текущим app.js
  return {
    master: {
      id: master.id,
      name: master.name,
      description: master.description,
      avatar: master.avatar_url,
      phone: master.phone,
      welcome_text: master.welcome_text,
      master_code: master.master_code,
    },
    categories: categories.map(c => ({
      id: c.id,
      name: c.name,
      icon: c.icon,
      sort: c.sort_order,
    })),
    services: services.map(s => ({
      id: s.id,
      category: s.category_id,
      name: s.name,
      description: s.description,
      duration: s.duration,
      price: s.price,
      salePrice: s.sale_price,
      photos: s.photos || [],
      active: s.is_active,
      sort: s.sort_order,
    })),
    schedule: schedule,
    bookedSlots: bookedSlots.map(b => `${b.date}_${b.time.substring(0, 5)}`),
    busyIntervals: BUSY_INTERVALS,
  };
}

// === Уведомления ===

async function loadNotifications() {
  const auth = typeof getStoredAuth === 'function' ? getStoredAuth() : null;
  if (!auth || !auth.access_token) return [];
  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/notifications?order=created_at.desc&limit=50`, {
      headers: { 'Authorization': `Bearer ${auth.access_token}` }
    });
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

async function getUnreadNotifCount() {
  const auth = typeof getStoredAuth === 'function' ? getStoredAuth() : null;
  if (!auth || !auth.access_token) return 0;
  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/notifications?read=eq.false&order=created_at.desc`, {
      headers: { 'Authorization': `Bearer ${auth.access_token}` }
    });
    if (!res.ok) return 0;
    const data = await res.json();
    return data.length;
  } catch { return 0; }
}

async function markNotificationRead(id) {
  return API.patch('notifications', `id=eq.${id}`, { read: true });
}

async function markAllNotificationsRead() {
  const auth = typeof getStoredAuth === 'function' ? getStoredAuth() : null;
  if (!auth) return;
  const phone = JSON.parse(atob(auth.access_token.split('.')[1])).phone;
  return API.patch('notifications', `user_phone=eq.${phone}&read=eq.false`, { read: true });
}

async function createNotification(userPhone, masterId, type, title, body) {
  return API.post('notifications', {
    user_phone: userPhone,
    master_id: masterId,
    type: type,
    title: title,
    body: body,
  });
}

// === Супер-админ ===

async function loadAllMasters() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/masters?order=created_at.desc&select=*`, {
      headers: { 'X-API-Key': API_KEY },
    });
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

async function toggleMasterActive(masterId, isActive) {
  return API.patch('masters', `id=eq.${masterId}`, { is_active: isActive });
}

async function deleteMasterAdmin(masterId) {
  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/auth/delete-master`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
      },
      body: JSON.stringify({ master_id: masterId }),
    });
    return res.ok;
  } catch { return false; }
}
