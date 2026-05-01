// ============================================================
// Мульти-тенант бот-сервер для каталога бьюти-услуг
// Один сервер обслуживает ВСЕХ мастеров — каждый со своим ботом
// ============================================================

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const webpush = require('web-push');
const { dbFetch, dbInsert, dbPatch, dbDelete, dbQuery } = require('./db');

// --- Форматирование даты: "2026-04-07T00:00:00.000Z" → "7 апреля 2026"  ---
function formatDateRu(raw) {
  const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  // Date object → ISO YYYY-MM-DD (иначе String() даёт "Fri May 01 2026 ...")
  let str;
  if (raw instanceof Date) str = raw.toISOString().slice(0, 10);
  else str = String(raw).slice(0, 10);
  const [y, m, d] = str.split('-').map(Number);
  if (!y || !m || !d) return str;
  return `${d} ${months[m - 1]} ${y}`;
}

// --- Конфиг ---
const WEBAPP_URL    = process.env.WEBAPP_URL || 'https://laser-time-app.vercel.app';
const BOT_API_PORT  = process.env.BOT_API_PORT || 3001;

// --- Web Push ---
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:noreply@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  console.log('📱 Web Push configured');
}

// Отправить push-уведомление всем подпискам пользователя по телефону
async function sendPushToPhone(phone, title, body, data = {}) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  try {
    const subs = await dbFetch('push_subscriptions', `user_phone=eq.${encodeURIComponent(phone)}`);
    if (!subs.length) return;

    const payload = JSON.stringify({ title, body, data });

    for (const sub of subs) {
      const pushSub = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      };
      try {
        await webpush.sendNotification(pushSub, payload);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          // Подписка истекла — удаляем
          await dbDelete('push_subscriptions', `endpoint=eq.${encodeURIComponent(sub.endpoint)}`);
        }
      }
    }
  } catch (err) {
    console.error('Push error:', err.message);
  }
}

// Создать уведомление в БД + отправить push
async function createNotifAndPush(data) {
  try {
    await dbInsert('notifications', data);
    await sendPushToPhone(data.user_phone, data.title, data.body, { type: data.type, booking_id: data.booking_id });
  } catch (e) { /* ignore duplicates */ }
}

// Хранилище активных ботов: { botToken: { bot, master } }
const activeBots = {};

// --- Отправка сообщения с повторными попытками ---
async function sendWithRetry(bot, chatId, text, options = {}, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await bot.sendMessage(chatId, text, options);
    } catch (err) {
      const isLastAttempt = attempt === retries;
      if (err.response && (err.response.statusCode === 403 || err.response.statusCode === 400)) {
        console.error(`❌ Telegram ${err.response.statusCode} для chat=${chatId}: ${err.message}`);
        return null;
      }
      if (isLastAttempt) {
        console.error(`❌ Не удалось отправить после ${retries} попыток (chat=${chatId}): ${err.message}`);
        return null;
      }
      console.warn(`⚠️ Попытка ${attempt}/${retries} неудачна (chat=${chatId}): ${err.message}. Повтор через ${attempt * 2} сек...`);
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
}

// --- Алиасы для совместимости (замена supaFetch/supaInsert) ---
const supaFetch = dbFetch;
const supaInsert = dbInsert;

// --- Загрузка всех мастеров из Supabase ---
async function loadMasters() {
  console.log('📋 Загружаю мастеров из Supabase...');
  const masters = await supaFetch('masters', 'is_active=eq.true&select=*');
  console.log(`   Найдено мастеров: ${masters.length}`);
  return masters;
}

// --- Настройка бота для одного мастера ---
function setupBot(master) {
  const token = master.bot_token;

  // Мастер без бот-токена (веб-регистрация) — пропускаем
  if (!token) {
    return;
  }

  // Если бот уже запущен — пропускаем
  if (activeBots[token]) {
    console.log(`   ⏭️  ${master.name} — уже запущен`);
    return;
  }

  try {
    const bot = new TelegramBot(token, {
      polling: {
        autoStart: true,
        params: { timeout: 30 },
      },
    });

    // Автоматический перезапуск polling при ошибках
    bot.on('polling_error', (err) => {
      console.error(`❌ ${master.bot_username} polling error: ${err.code || err.message}`);
      // ECONNRESET / EFATAL — перезапускаем polling через 5 секунд
      if (err.code === 'EFATAL' || err.code === 'ECONNRESET' || err.code === 'ETELEGRAM') {
        setTimeout(() => {
          try {
            bot.stopPolling().then(() => {
              bot.startPolling();
              console.log(`🔄 ${master.bot_username} polling перезапущен`);
            }).catch(() => {
              bot.startPolling().catch(() => {});
            });
          } catch (e) { /* ignore */ }
        }, 5000);
      }
    });

    activeBots[token] = { bot, master };

    const webappUrl = `${WEBAPP_URL}/?bot=${master.bot_username}`;

    // /start — приветствие с кнопкой каталога
    bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      const firstName = msg.from.first_name || 'друг';

      const welcome = master.welcome_text
        || `Добро пожаловать в ${master.name}! Выберите услугу и запишитесь онлайн.`;

      console.log(`💬 ${master.bot_username}: /start от ${firstName} (${msg.from.id})`);

      // Регистрируем клиента в базе
      try {
        await upsertClient(master.id, msg.from);
      } catch (e) {
        console.error(`   Ошибка регистрации клиента: ${e.message}`);
      }

      await bot.sendMessage(chatId, `Привет, ${firstName}! ${welcome}`, {
        reply_markup: {
          inline_keyboard: [[
            { text: '📋 Открыть каталог', web_app: { url: webappUrl } }
          ]]
        }
      });
    });

    // /broadcast — рассылка клиентам (только для мастера)
    bot.onText(/\/broadcast (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      // Только мастер может рассылать
      if (String(chatId) !== String(master.tg_user_id)) {
        await bot.sendMessage(chatId, '⛔ Рассылка доступна только мастеру.');
        return;
      }

      const text = match[1];
      console.log(`📣 ${master.bot_username}: рассылка от мастера`);

      try {
        const clients = await supaFetch('clients',
          `master_id=eq.${master.id}&select=tg_user_id,first_name`
        );

        if (clients.length === 0) {
          await bot.sendMessage(chatId, '📭 У вас пока нет клиентов для рассылки.');
          return;
        }

        let sent = 0, failed = 0;
        for (const client of clients) {
          if (!client.tg_user_id) continue;
          try {
            await bot.sendMessage(client.tg_user_id,
              `📢 <b>${master.name}</b>\n\n${text}`,
              { parse_mode: 'HTML' }
            );
            sent++;
          } catch (e) {
            failed++;
          }
        }

        await bot.sendMessage(chatId,
          `✅ Рассылка завершена!\n📩 Отправлено: ${sent}\n❌ Не доставлено: ${failed}`
        );
      } catch (err) {
        console.error(`❌ Ошибка рассылки: ${err.message}`);
        await bot.sendMessage(chatId, '❌ Ошибка при рассылке.');
      }
    });

    // /help
    bot.onText(/\/help/, async (msg) => {
      await bot.sendMessage(msg.chat.id,
        `ℹ️ <b>${master.name}</b>\n\n` +
        `Нажмите кнопку ниже, чтобы открыть каталог услуг и записаться.\n\n` +
        `${master.phone ? '📞 Телефон: ' + master.phone : ''}`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: '📋 Открыть каталог', web_app: { url: webappUrl } }
            ]]
          }
        }
      );
    });

    // Любое текстовое сообщение (не команда) — направляем в каталог
    bot.on('message', async (msg) => {
      if (msg.text && msg.text.startsWith('/')) return; // команды обработаны выше
      if (msg.web_app_data) return; // данные от Mini App

      await bot.sendMessage(msg.chat.id,
        'Нажмите кнопку ниже, чтобы открыть каталог и записаться 👇',
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '📋 Открыть каталог', web_app: { url: webappUrl } }
            ]]
          }
        }
      );
    });

    // Обработка нажатий на кнопки (подтвердить / отменить / перенести)
    bot.on('callback_query', async (query) => {
      const data = query.data;
      if (!data) return;

      const [action, bookingId] = data.split(':');
      if (!bookingId) return;

      try {
        // Загружаем запись
        const bookings = await supaFetch('bookings',
          `id=eq.${bookingId}&select=*,services(name)`
        );
        if (!bookings.length) {
          await bot.answerCallbackQuery(query.id, { text: 'Запись не найдена' });
          return;
        }

        const booking = bookings[0];
        const serviceName = booking.services?.name || 'Услуга';
        const timeShort = booking.time ? booking.time.substring(0, 5) : '';

        if (action === 'confirm') {
          await updateBookingStatus(bookingId, 'confirmed');
          await bot.editMessageText(
            `✅ <b>Запись подтверждена!</b>\n\n` +
            `📋 ${serviceName}\n` +
            `📅 ${formatDateRu(booking.date)} в ${timeShort}\n` +
            `📍 <b>${master.name}</b>\n\n` +
            `Ждём вас!`,
            { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'HTML' }
          );
          await notifyMasterAboutChange(master.id, booking, 'confirmed');
          // Колокольчик мастеру
          if (master.phone) {
            await createNotifAndPush({ user_phone: master.phone, master_id: master.id, type: 'status_change', title: 'Клиент подтвердил запись', body: `${booking.client_name || 'Клиент'} — ${serviceName}, ${formatDateRu(booking.date)} в ${timeShort}`, booking_id: bookingId });
          }

        } else if (action === 'cancel') {
          await updateBookingStatus(bookingId, 'cancelled');
          await bot.editMessageText(
            `❌ <b>Запись отменена</b>\n\n` +
            `📋 ${serviceName}\n` +
            `📅 ${formatDateRu(booking.date)} в ${timeShort}\n\n` +
            `Вы можете записаться снова в любое время.`,
            {
              chat_id: query.message.chat.id,
              message_id: query.message.message_id,
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[
                  { text: '📋 Открыть каталог', web_app: { url: `${WEBAPP_URL}/?bot=${master.bot_username}` } }
                ]]
              }
            }
          );
          await notifyMasterAboutChange(master.id, booking, 'cancelled');
          // Колокольчик мастеру
          if (master.phone) {
            await createNotifAndPush({ user_phone: master.phone, master_id: master.id, type: 'status_change', title: 'Клиент отменил запись', body: `${booking.client_name || 'Клиент'} — ${serviceName}, ${formatDateRu(booking.date)} в ${timeShort}`, booking_id: bookingId });
          }

        } else if (action === 'reschedule') {
          // Отменяем старую запись и открываем каталог для новой
          await updateBookingStatus(bookingId, 'cancelled');
          await bot.editMessageText(
            `🔄 <b>Перенос записи</b>\n\n` +
            `Старая запись отменена:\n` +
            `📋 ${serviceName}\n` +
            `📅 <s>${formatDateRu(booking.date)} в ${timeShort}</s>\n\n` +
            `Выберите новую дату и время:`,
            {
              chat_id: query.message.chat.id,
              message_id: query.message.message_id,
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[
                  { text: '📅 Выбрать новую дату', web_app: { url: `${WEBAPP_URL}/?bot=${master.bot_username}` } }
                ]]
              }
            }
          );
          await notifyMasterAboutChange(master.id, booking, 'reschedule');
          // Колокольчик мастеру
          if (master.phone) {
            await createNotifAndPush({ user_phone: master.phone, master_id: master.id, type: 'status_change', title: 'Клиент просит перенести запись', body: `${booking.client_name || 'Клиент'} — ${serviceName}, ${formatDateRu(booking.date)} в ${timeShort}`, booking_id: bookingId });
          }
        }

        await bot.answerCallbackQuery(query.id);
      } catch (err) {
        console.error(`❌ Ошибка обработки кнопки: ${err.message}`);
        await bot.answerCallbackQuery(query.id, { text: 'Произошла ошибка' });
      }
    });

    // Обработка ошибок polling
    bot.on('polling_error', (err) => {
      console.error(`❌ ${master.bot_username} polling error: ${err.message}`);
      // Если токен невалидный — убираем бота
      if (err.message.includes('401') || err.message.includes('404')) {
        console.log(`   🗑️  Удаляю бота ${master.bot_username} — невалидный токен`);
        bot.stopPolling();
        delete activeBots[token];
      }
    });

    console.log(`   ✅ ${master.name} (@${master.bot_username}) — запущен`);

  } catch (err) {
    console.error(`   ❌ Ошибка запуска ${master.name}: ${err.message}`);
  }
}

// --- Регистрация / обновление клиента ---
async function upsertClient(masterId, tgUser) {
  // Проверяем есть ли клиент
  const existing = await supaFetch('clients',
    `master_id=eq.${masterId}&tg_user_id=eq.${tgUser.id}&select=id`
  );

  if (existing.length > 0) {
    // Обновляем last_visit
    await dbPatch('clients', `id=eq.${existing[0].id}`, {
      first_name: tgUser.first_name,
      username: tgUser.username || null,
      last_visit: new Date().toISOString(),
    });
  } else {
    // Новый клиент
    await supaInsert('clients', {
      master_id: masterId,
      tg_user_id: tgUser.id,
      first_name: tgUser.first_name,
      username: tgUser.username || null,
      bonus_balance: 0,
      visits_count: 0,
    });
  }
}

// --- Уведомление мастеру о новой записи ---
async function notifyMasterAboutBooking(masterId, booking) {
  // Находим мастера и его бота
  const entry = Object.values(activeBots).find(e => e.master.id === masterId);
  if (!entry) {
    console.error(`⚠️ Уведомление мастеру: бот не найден для master_id=${masterId}`);
    return;
  }

  const { bot, master } = entry;
  const masterChatId = master.tg_user_id;

  if (!masterChatId) {
    console.error(`⚠️ Уведомление мастеру ${master.name}: нет tg_user_id в базе`);
    return;
  }

  const text =
    `🆕 <b>Новая запись!</b>\n\n` +
    `👤 ${booking.client_name || 'Клиент'}` +
    `${booking.client_username ? ' (@' + booking.client_username + ')' : ''}\n` +
    `${booking.client_phone ? '📞 ' + booking.client_phone + '\n' : ''}` +
    `📋 ${booking.service_name || 'Услуга'}\n` +
    `📅 ${formatDateRu(booking.date)} в ${booking.time}\n` +
    `💰 ${booking.price ? booking.price + ' ₽' : '—'}`;

  const result = await sendWithRetry(bot, masterChatId, text, { parse_mode: 'HTML' });
  if (result) {
    console.log(`📩 Уведомление мастеру ${master.name} отправлено`);
  }
}

// --- Уведомление клиенту о записи (с кнопками) ---
async function notifyClientAboutBooking(masterId, booking) {
  const entry = Object.values(activeBots).find(e => e.master.id === masterId);
  if (!entry) {
    console.error(`⚠️ Уведомление клиенту: бот не найден для master_id=${masterId}`);
    return;
  }
  if (!booking.client_tg_id) {
    console.error(`⚠️ Уведомление клиенту: нет client_tg_id для записи ${booking.booking_id}`);
    return;
  }

  const { bot, master } = entry;
  const serviceName = booking.service_name || 'Услуга';

  const text =
    `✅ <b>Вы записаны!</b>\n\n` +
    `📋 ${serviceName}\n` +
    `📅 ${formatDateRu(booking.date)} в ${booking.time}\n` +
    `💰 ${booking.price ? booking.price + ' ₽' : '—'}\n\n` +
    `📍 <b>${master.name}</b>` +
    `${master.phone ? '\n📞 ' + master.phone : ''}\n\n` +
    `Напоминание с кнопками подтверждения придёт за 24 часа.`;

  const result = await sendWithRetry(bot, booking.client_tg_id, text, { parse_mode: 'HTML' });
  if (result) {
    console.log(`📩 Уведомление клиенту ${booking.client_name || booking.client_tg_id} отправлено`);
  }
}

// --- Обновить статус записи ---
async function updateBookingStatus(bookingId, status) {
  return dbPatch('bookings', `id=eq.${bookingId}`, { status });
}

// --- Уведомить мастера об изменении записи клиентом ---
async function notifyMasterAboutChange(masterId, booking, action) {
  const entry = Object.values(activeBots).find(e => e.master.id === masterId);
  if (!entry) {
    console.error(`⚠️ Уведомление мастеру (${action}): бот не найден для master_id=${masterId}`);
    return;
  }

  const { bot, master } = entry;
  const masterChatId = master.tg_user_id;
  if (!masterChatId) {
    console.error(`⚠️ Уведомление мастеру ${master.name} (${action}): нет tg_user_id`);
    return;
  }

  const labels = {
    confirmed: '✅ Клиент подтвердил запись',
    cancelled: '❌ Клиент отменил запись',
    reschedule: '🔄 Клиент просит перенести запись',
  };

  const serviceName = booking.services?.name || 'Услуга';
  const timeShort = booking.time ? booking.time.substring(0, 5) : '';

  const text =
    `${labels[action] || action}\n\n` +
    `👤 ${booking.client_name || 'Клиент'}` +
    `${booking.client_username ? ' (@' + booking.client_username + ')' : ''}\n` +
    `📋 ${serviceName}\n` +
    `📅 ${formatDateRu(booking.date)} в ${timeShort}`;

  await sendWithRetry(bot, masterChatId, text, { parse_mode: 'HTML' });
}

// --- Напоминание клиенту за 24 часа ---
async function checkReminders() {
  try {
    // Завтрашняя дата
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowKey = tomorrow.toISOString().split('T')[0];

    // Записи на завтра, которым ещё не отправляли напоминание
    const bookings = await supaFetch('bookings',
      `date=eq.${tomorrowKey}&status=in.(pending,confirmed)&reminded=eq.false&select=*,services(name,category_id)`
    );

    if (bookings.length === 0) return;

    console.log(`🔔 Напоминаний на завтра: ${bookings.length}`);

    for (const booking of bookings) {
      const svcName = booking.services?.name || 'Услуга';
      const categoryId = booking.services?.category_id;
      let categoryName = '';
      if (categoryId) {
        try {
          const cats = await supaFetch('categories', `id=eq.${categoryId}&select=name`);
          if (cats.length > 0) categoryName = cats[0].name || '';
        } catch(e) {}
      }
      const serviceName = categoryName ? `${categoryName}. ${svcName}` : svcName;
      const timeShort = booking.time ? booking.time.substring(0, 5) : '';

      // Находим мастера (может не быть бота — для веб-мастеров)
      const entry = Object.values(activeBots).find(e => e.master.id === booking.master_id);
      let masterName = 'Мастер';
      let masterPhone = '';
      if (entry) {
        masterName = entry.master.name;
        masterPhone = entry.master.phone || '';
      } else {
        // Мастер без бота — берём из БД
        try {
          const masters = await supaFetch('masters', `id=eq.${booking.master_id}&select=name,phone`);
          if (masters.length > 0) { masterName = masters[0].name; masterPhone = masters[0].phone || ''; }
        } catch (e) { /* ignore */ }
      }

      try {
        let sent = false;

        // 1) Telegram-клиент — отправляем через бота
        if (booking.client_tg_id && entry) {
          const { bot } = entry;
          const text =
            `🔔 <b>Напоминание о записи!</b>\n\n` +
            `Завтра у вас:\n` +
            `📋 ${serviceName}\n` +
            `🕐 ${timeShort}\n` +
            `📍 <b>${masterName}</b>` +
            `${masterPhone ? '\n📞 ' + masterPhone : ''}\n\n` +
            `Ждём вас!`;

          const result = await sendWithRetry(bot, booking.client_tg_id, text, {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Подтверждаю', callback_data: `confirm:${booking.id}` },
                  { text: '❌ Отменить', callback_data: `cancel:${booking.id}` },
                ],
                [
                  { text: '🔄 Перенести', callback_data: `reschedule:${booking.id}` },
                ],
              ],
            },
          });
          if (result) sent = true;
        }

        // 2) Веб-клиент (есть телефон) — уведомление + push
        if (booking.client_phone) {
          try {
            await createNotifAndPush({
              user_phone: booking.client_phone,
              master_id: booking.master_id,
              type: 'reminder',
              title: `Напоминание: ${serviceName}`,
              body: `Завтра в ${timeShort} у ${masterName}. Подтвердите, отмените или перенесите запись.`,
              booking_id: booking.id,
            });
            sent = true;
            console.log(`🔔 Веб-уведомление + push: ${booking.client_phone} — ${serviceName} в ${timeShort}`);
          } catch (e) {
            console.error(`❌ Ошибка веб-уведомления: ${e.message}`);
          }
        }

        // 3) Уведомление мастеру + push
        if (masterPhone) {
          await createNotifAndPush({
            user_phone: masterPhone,
            master_id: booking.master_id,
            type: 'reminder',
            title: `Запись завтра: ${serviceName}`,
            body: `${booking.client_name || 'Клиент'} в ${timeShort}`,
            booking_id: booking.id,
          });
        }

        if (sent) {
          await dbPatch('bookings', `id=eq.${booking.id}`, { reminded: true });
          console.log(`🔔 Напоминание отправлено: ${booking.client_name || booking.client_phone || booking.client_tg_id}`);
        }
      } catch (err) {
        console.error(`❌ Ошибка напоминания: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`❌ Ошибка проверки напоминаний: ${err.message}`);
  }
}

// --- Опрос новых записей и отправка уведомлений ---
// При старте НЕ проверяем старые записи — только новые с момента запуска (предотвращает дубли при рестарте)
let lastBookingCheck = new Date().toISOString();
let _checkingBookings = false; // защита от параллельных вызовов
// Множество уже отправленных уведомлений (по booking.id) — защита от дублей
const notifiedBookings = new Set();

async function checkNewBookings() {
  if (_checkingBookings) return;
  _checkingBookings = true;
  try {
    const bookings = await supaFetch('bookings',
      `created_at=gt.${encodeURIComponent(lastBookingCheck)}&status=in.(pending,confirmed)&select=*,services(name,category_id)&order=created_at.asc`
    );

    if (bookings.length === 0) return;

    // Фильтруем уже отправленные (защита от дублей при перезапуске)
    const newBookings = bookings.filter(b => !notifiedBookings.has(b.id));
    if (newBookings.length === 0) return;

    console.log(`📬 Новых записей: ${newBookings.length}`);

    for (const booking of newBookings) {
      // Помечаем сразу, чтобы при ошибке не было повторной отправки
      notifiedBookings.add(booking.id);

      const svcName = booking.services?.name || 'Услуга';
      const categoryId = booking.services?.category_id;
      let categoryName = '';
      if (categoryId) {
        try {
          const cats = await supaFetch('categories', `id=eq.${categoryId}&select=name`);
          if (cats.length > 0) categoryName = cats[0].name || '';
        } catch(e) {}
      }
      const serviceName = categoryName ? `${categoryName}. ${svcName}` : svcName;
      const timeShort = booking.time ? booking.time.substring(0, 5) : '';

      // Подтягиваем телефон клиента
      let clientPhone = '';
      try {
        const clients = await supaFetch('clients',
          `master_id=eq.${booking.master_id}&tg_user_id=eq.${booking.client_tg_id}&select=phone`
        );
        if (clients.length > 0 && clients[0].phone) {
          clientPhone = clients[0].phone;
        }
      } catch (e) { /* ignore */ }

      // Уведомляем мастера через Telegram
      await notifyMasterAboutBooking(booking.master_id, {
        client_name: booking.client_name,
        client_username: booking.client_username,
        client_phone: clientPhone || booking.client_phone || '',
        service_name: serviceName,
        date: booking.date,
        time: timeShort,
        price: booking.price,
      });

      // Уведомляем клиента через Telegram (с кнопками подтвердить/отменить/перенести)
      if (booking.client_tg_id) {
        await notifyClientAboutBooking(booking.master_id, {
          booking_id: booking.id,
          client_tg_id: booking.client_tg_id,
          client_name: booking.client_name,
          service_name: serviceName,
          date: booking.date,
          time: timeShort,
          price: booking.price,
        });
      }

      // --- Уведомления в колокольчик + push ---
      // Мастеру — о новой записи
      try {
        let masterPhone = '';
        const mEntry = Object.values(activeBots).find(e => e.master.id === booking.master_id);
        if (mEntry) masterPhone = mEntry.master.phone || '';
        if (!masterPhone) {
          const ms = await supaFetch('masters', `id=eq.${booking.master_id}&select=phone`);
          if (ms.length > 0) masterPhone = ms[0].phone || '';
        }
        if (masterPhone) {
          await createNotifAndPush({
            user_phone: masterPhone,
            master_id: booking.master_id,
            type: 'new_booking',
            title: '📋 Новая запись: ' + serviceName,
            body: '👤 ' + (booking.client_name || 'Клиент') + (booking.client_phone ? ' · ' + booking.client_phone : '') + '\n📅 ' + formatDateRu(booking.date) + ' в ' + timeShort + (booking.price ? ' · ' + booking.price + ' ₽' : ''),
            booking_id: booking.id,
          });
        }
      } catch (e) { /* ignore */ }

      // Клиенту (веб) — подтверждение записи + push
      const cPhone = clientPhone || booking.client_phone;
      if (cPhone) {
        const dateStr = formatDateRu(booking.date);
        // Получаем имя, телефон и адрес мастера для уведомления клиенту
        let mName = '';
        let mPhoneC = '';
        let mAddress = '';
        let mMapsUrl = '';
        if (mEntry) {
          mName = mEntry.master.name || '';
          mPhoneC = mEntry.master.phone || '';
        }
        try {
          const ms = await supaFetch('masters', `id=eq.${booking.master_id}&select=name,phone,address,maps_url`);
          if (ms.length > 0) {
            if (!mName) mName = ms[0].name || '';
            if (!mPhoneC) mPhoneC = ms[0].phone || '';
            mAddress = ms[0].address || '';
            mMapsUrl = ms[0].maps_url || '';
          }
        } catch(e) {}
        // Получаем имя клиента
        let clientDisplayName = booking.client_name || '';
        if (!clientDisplayName && cPhone) {
          try {
            const cls = await supaFetch('clients', `phone=eq.${cPhone}&master_id=eq.${booking.master_id}&select=first_name`);
            if (cls.length > 0) clientDisplayName = cls[0].first_name || '';
          } catch(e) {}
        }
        const greeting = clientDisplayName ? clientDisplayName + ', до встречи! 🌸' : 'До встречи! 🌸';
        let notifBody = '📋 ' + serviceName + '\n📅 ' + dateStr + ' в ' + timeShort + '\n💰 ' + (booking.price ? booking.price + ' ₽' : '—');
        notifBody += '\n\n' + greeting;
        if (mAddress) notifBody += '\n📍 ' + mAddress;
        notifBody += '\n\n📍 ' + mName + (mPhoneC ? '\n📞 ' + mPhoneC : '');
        await createNotifAndPush({
          user_phone: cPhone,
          master_id: booking.master_id,
          type: 'booking_confirmed',
          title: '✅ Вы записаны!',
          body: notifBody,
          booking_id: booking.id,
        });
      }

    }

    // Чистим старые ID (больше 500 — чтобы память не росла)
    if (notifiedBookings.size > 500) {
      const arr = [...notifiedBookings];
      arr.slice(0, arr.length - 200).forEach(id => notifiedBookings.delete(id));
    }

    // Обновляем метку времени на последнюю запись
    // Ensure ISO format for next query
    const lastTs = newBookings[newBookings.length - 1].created_at;
    lastBookingCheck = new Date(lastTs).toISOString();
  } catch (err) {
    console.error(`❌ Ошибка проверки записей: ${err.message}`);
  } finally {
    _checkingBookings = false;
  }
}

// --- Watchdog: перезапуск зависших ботов каждые 5 минут ---
function watchdog() {
  for (const [token, entry] of Object.entries(activeBots)) {
    const bot = entry.bot;
    const name = entry.master.bot_username;
    // Проверяем что polling активен
    if (!bot.isPolling || !bot.isPolling()) {
      console.warn(`🐕 Watchdog: ${name} не опрашивает — перезапускаю`);
      try {
        bot.stopPolling().catch(() => {});
        setTimeout(() => {
          bot.startPolling();
          console.log(`🔄 Watchdog: ${name} polling перезапущен`);
        }, 2000);
      } catch (e) {
        console.error(`❌ Watchdog: не удалось перезапустить ${name}: ${e.message}`);
      }
    }
  }
}

// --- Периодическая проверка новых мастеров (каждые 60 сек) ---
async function refreshMasters() {
  try {
    const masters = await loadMasters();
    for (const master of masters) {
      setupBot(master);
    }
  } catch (err) {
    console.error(`❌ Ошибка обновления мастеров: ${err.message}`);
  }
}

// --- HTTP API для рассылки из админ-панели ---
function startApiServer() {
  const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/api/broadcast') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { master_id, master_code, message } = JSON.parse(body);

          if (!master_id || !master_code || !message) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing master_id, master_code, or message' }));
            return;
          }

          // Проверяем master_code
          const entry = Object.values(activeBots).find(e => e.master.id === master_id);
          if (!entry || String(entry.master.master_code) !== String(master_code)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid master_code' }));
            return;
          }

          const { bot, master } = entry;

          // Загружаем клиентов
          const clients = await supaFetch('clients',
            `master_id=eq.${master_id}&select=tg_user_id,first_name`
          );

          let sent = 0, failed = 0;
          for (const client of clients) {
            if (!client.tg_user_id) continue;
            try {
              await bot.sendMessage(client.tg_user_id,
                `📢 <b>${master.name}</b>\n\n${message}`,
                { parse_mode: 'HTML' }
              );
              sent++;
            } catch (e) {
              failed++;
            }
          }

          console.log(`📣 Рассылка ${master.name}: ${sent} отправлено, ${failed} ошибок`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ sent, failed, total: clients.length }));
        } catch (err) {
          console.error(`❌ API broadcast error: ${err.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // --- Уведомление клиенту о начислении бонусов ---
    if (req.method === 'POST' && req.url === '/api/notify-bonus') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { master_id, client_tg_id, bonus_amount } = JSON.parse(body);
          const entry = Object.values(activeBots).find(e => e.master.id === master_id);
          if (!entry || !client_tg_id) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Bot or client not found' }));
            return;
          }

          const { bot, master } = entry;
          try {
            await bot.sendMessage(client_tg_id,
              `💎 <b>Вам начислены бонусы!</b>\n\n` +
              `+${bonus_amount} ₽ за визит в <b>${master.name}</b>\n\n` +
              `Бонусы можно использовать при следующей записи. Действуют 3 месяца.`,
              { parse_mode: 'HTML' }
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // --- Завершение визита (обновление статуса + бонусы) ---
    if (req.method === 'POST' && req.url === '/api/complete-visit') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { master_id, master_code, booking_id, client_tg_id, price, action } = JSON.parse(body);

          // Проверяем master_code
          const entry = Object.values(activeBots).find(e => e.master.id === master_id);
          if (!entry || String(entry.master.master_code) !== String(master_code)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid master_code' }));
            return;
          }

          const newStatus = action === 'no_show' ? 'no_show' : 'completed';

          // Обновляем статус записи
          try {
            await dbPatch('bookings', `id=eq.${booking_id}`, { status: newStatus });
          } catch (patchErr) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `PATCH failed: ${patchErr.message}` }));
            return;
          }

          let bonusAmount = 0;

          // Начисляем бонусы только для completed
          if (newStatus === 'completed' && client_tg_id && price > 0) {
            try {
              // Находим клиента
              const clients = await supaFetch('clients',
                `master_id=eq.${master_id}&tg_user_id=eq.${client_tg_id}&select=id,bonus_balance`
              );

              if (clients.length > 0) {
                const client = clients[0];
                bonusAmount = Math.round(price * 0.03 * 100) / 100; // 3%
                const expiresAt = new Date();
                expiresAt.setMonth(expiresAt.getMonth() + 3);

                // Создаём транзакцию бонуса
                await supaInsert('bonus_transactions', {
                  master_id: master_id,
                  client_id: client.id,
                  booking_id: booking_id,
                  amount: bonusAmount,
                  type: 'credit',
                  description: 'Начисление 3% за визит',
                  expires_at: expiresAt.toISOString(),
                });

                // Обновляем баланс клиента
                const newBalance = parseFloat(client.bonus_balance || 0) + bonusAmount;
                await dbPatch('clients', `id=eq.${client.id}`, { bonus_balance: newBalance });

                // Помечаем запись как bonus_credited
                await dbPatch('bookings', `id=eq.${booking_id}`, { bonus_credited: true });

                // Уведомляем клиента через бота
                const { bot, master } = entry;
                try {
                  await bot.sendMessage(client_tg_id,
                    `💎 <b>Вам начислены бонусы!</b>\n\n` +
                    `+${bonusAmount} ₽ за визит в <b>${master.name}</b>\n\n` +
                    `Бонусы можно использовать при следующей записи. Действуют 3 месяца.`,
                    { parse_mode: 'HTML' }
                  );
                } catch (e) { /* ignore send error */ }

                console.log(`💎 Бонус ${bonusAmount} ₽ начислен клиенту tg:${client_tg_id}`);
              }
            } catch (e) {
              console.error(`❌ Ошибка начисления бонуса: ${e.message}`);
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, status: newStatus, bonus: bonusAmount }));
        } catch (err) {
          console.error(`❌ API complete-visit error: ${err.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(BOT_API_PORT, () => {
    console.log(`   📡 API сервер: http://localhost:${BOT_API_PORT}`);
  });
}

// --- Запуск ---
async function main() {
  console.log('');
  console.log('🚀 Beauty Bot Server запускается...');
  console.log(`   Database: PostgreSQL (localhost)`);
  console.log(`   WebApp:   ${WEBAPP_URL}`);
  console.log('');

  // Первый запуск — загрузить всех мастеров
  await refreshMasters();

  // Каждые 60 секунд — проверяем новых мастеров
  setInterval(refreshMasters, 60_000);

  // Каждые 15 секунд — проверяем новые записи и уведомляем мастеров
  setInterval(checkNewBookings, 15_000);

  // Каждые 10 минут — проверяем напоминания на завтра
  setInterval(checkReminders, 10 * 60_000);

  // Каждые 5 минут — watchdog проверяет что polling живой
  setInterval(watchdog, 5 * 60_000);

  // Запускаем HTTP API для рассылки
  startApiServer();

  console.log('');
  console.log('✅ Сервер работает. Нажмите Ctrl+C для остановки.');
  console.log('   Уведомления — 15 сек. Напоминания — 10 мин. Мастера — 60 сек.');
}

main().catch(err => {
  console.error('💀 Фатальная ошибка:', err);
  process.exit(1);
});

// --- Защита от необработанных ошибок (процесс не падает) ---
process.on('uncaughtException', (err) => {
  console.error('🔥 Необработанная ошибка (процесс продолжает работу):', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('🔥 Необработанный промис:', reason);
});

// Экспорт для использования из других модулей (уведомления)
module.exports = { notifyMasterAboutBooking, activeBots };
