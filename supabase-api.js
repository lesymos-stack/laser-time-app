/**
 * supabase-api.js — Загрузка данных из Supabase
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

// === Supabase клиент (используем REST API напрямую, без SDK) ===
// Это проще и не требует npm/сборки — работает в обычном HTML

const API = {
  url: SUPABASE_URL,     // из config.js
  key: SUPABASE_ANON_KEY, // из config.js

  // Базовый запрос к Supabase REST API
  async fetch(table, query = '') {
    const response = await fetch(`${this.url}/rest/v1/${table}?${query}`, {
      headers: {
        'apikey': this.key,
        'Authorization': `Bearer ${this.key}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.error(`API error: ${response.status} ${response.statusText}`);
      return null;
    }

    return response.json();
  },

  // POST-запрос (для создания записей)
  async post(table, data) {
    const response = await fetch(`${this.url}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'apikey': this.key,
        'Authorization': `Bearer ${this.key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('API POST error:', response.status, err);
      return null;
    }

    return response.json();
  },

  // PATCH-запрос (для обновления записей)
  async patch(table, query, data) {
    const response = await fetch(`${this.url}/rest/v1/${table}?${query}`, {
      method: 'PATCH',
      headers: {
        'apikey': this.key,
        'Authorization': `Bearer ${this.key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      console.error('API PATCH error:', response.status);
      return null;
    }

    return response.json();
  },
};


// === Определение мастера ===

// Получаем bot_username из URL-параметра ?bot=xxx
function getBotUsername() {
  const params = new URLSearchParams(window.location.search);
  return params.get('bot');
}

// Загружаем мастера по bot_username
async function loadMaster(botUsername) {
  if (!botUsername) {
    console.warn('Нет параметра ?bot= в URL, используем первого мастера');
    const masters = await API.fetch('masters', 'is_active=eq.true&limit=1');
    return masters && masters[0] ? masters[0] : null;
  }

  const masters = await API.fetch('masters', `bot_username=eq.${botUsername}&is_active=eq.true`);
  return masters && masters[0] ? masters[0] : null;
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

async function loadDayOverrides(masterId, fromDate, toDate) {
  return API.fetch('day_overrides',
    `master_id=eq.${masterId}&date=gte.${fromDate}&date=lte.${toDate}`
  ) || [];
}

async function loadBookedSlots(masterId, fromDate, toDate) {
  return API.fetch('bookings',
    `master_id=eq.${masterId}&date=gte.${fromDate}&date=lte.${toDate}&status=in.(confirmed,pending)&select=date,time`
  ) || [];
}

async function loadFaq(masterId) {
  return API.fetch('faq',
    `master_id=eq.${masterId}&is_active=eq.true&order=sort_order.asc`
  ) || [];
}

// Загрузить клиента по Telegram ID (для бонусов и истории)
async function loadClient(masterId, tgUserId) {
  const clients = await API.fetch('clients',
    `master_id=eq.${masterId}&tg_user_id=eq.${tgUserId}`
  );
  return clients && clients[0] ? clients[0] : null;
}

// Загрузить записи клиента (для экрана «Мои записи»)
async function loadClientBookings(masterId, tgUserId) {
  return API.fetch('bookings',
    `master_id=eq.${masterId}&client_tg_id=eq.${tgUserId}&order=date.desc,time.desc&select=*,services(name)`
  ) || [];
}


// === Создание записи ===

async function createBooking(bookingData) {
  return API.post('bookings', bookingData);
}

// === Создание/обновление клиента ===

async function upsertClient(masterId, tgUser) {
  // Проверяем, есть ли уже клиент
  const existing = await loadClient(masterId, tgUser.id);

  if (existing) {
    return existing;
  }

  // Создаём нового клиента
  return API.post('clients', {
    master_id: masterId,
    tg_user_id: tgUser.id,
    first_name: tgUser.first_name || '',
    username: tgUser.username || '',
  });
}


// === Вычисление свободных слотов ===
// Берём шаблон расписания + исключения + занятые слоты → возвращаем свободные

function computeAvailableSlots(scheduleRows, overrides, bookedSlots, daysAhead = 14) {
  const slots = {};
  const today = new Date();

  for (let i = 0; i < daysAhead; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);

    const dateKey = formatDateKey(date);
    const dayOfWeek = date.getDay(); // 0=Вс, 1=Пн, ..., 6=Сб

    // Проверяем override (выходной или особый график)
    const override = overrides.find(o => o.date === dateKey);

    if (override && override.is_day_off) {
      // Выходной — пропускаем
      continue;
    }

    // Находим расписание для этого дня недели
    const scheduleRow = scheduleRows.find(s => s.day_of_week === dayOfWeek);

    if (!scheduleRow) {
      // Нет расписания на этот день (например, воскресенье)
      continue;
    }

    // Определяем часы работы (override может менять время)
    const startTime = override && override.start_time ? override.start_time : scheduleRow.start_time;
    const endTime = override && override.end_time ? override.end_time : scheduleRow.end_time;
    const interval = scheduleRow.slot_interval;

    // Генерируем слоты
    const daySlots = generateTimeSlots(startTime, endTime, interval);

    // Убираем занятые
    const bookedTimes = bookedSlots
      .filter(b => b.date === dateKey)
      .map(b => b.time.substring(0, 5)); // "10:00:00" → "10:00"

    slots[dateKey] = daySlots.filter(s => !bookedTimes.includes(s));
  }

  return slots;
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


// === Главная функция загрузки всех данных ===

async function loadAllData() {
  // 1. Определяем мастера
  const botUsername = getBotUsername();
  const master = await loadMaster(botUsername);

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

  // 4. Возвращаем всё в формате, совместимом с текущим app.js
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
  };
}
