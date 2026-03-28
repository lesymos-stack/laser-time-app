/**
 * app.js — Главный файл приложения
 *
 * Содержит:
 * - Инициализация Telegram WebApp
 * - Роутер (переключение экранов)
 * - Рендер всех 5 экранов
 * - Обработчики действий
 *
 * НАВИГАЦИЯ ЭКРАНОВ:
 * home → catalog → service → booking → success
 *
 * Telegram WebApp API:
 * - MainButton: основная кнопка внизу
 * - BackButton: кнопка «Назад» в шапке
 * - HapticFeedback: тактильный отклик
 */

// ============================================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================================

const tg = window.Telegram?.WebApp;

// Текущий пользователь (Telegram или веб)
function getCurrentUser() {
  if (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) {
    const u = tg.initDataUnsafe.user;
    return { id: u.id, name: u.first_name || '', username: u.username || '', phone: '', source: 'telegram' };
  }
  const webUser = typeof getWebUser === 'function' ? getWebUser() : null;
  if (webUser) {
    return { id: webUser.id, name: webUser.name || '', username: '', phone: webUser.phone, source: 'web' };
  }
  return null;
}

// Код доступа мастера (перезапишется из Supabase)
let MASTER_CODE = '5638';

// ID мастера из Supabase (для записей и API-запросов)
let CURRENT_MASTER_ID = null;

// Бонусный баланс текущего клиента
let CLIENT_BONUS = 0;

// Состояние приложения
const state = {
  currentScreen: 'home',
  screenHistory: [],          // стек для навигации «назад»
  selectedCategory: null,     // выбранная категория
  selectedService: null,      // выбранная услуга
  selectedDate: null,         // выбранная дата (ключ "2026-03-10")
  selectedTime: null,         // выбранное время ("14:30")
  galleryIndex: 0,            // текущий слайд галереи
  masterUnlocked: false,      // разблокирована ли панель мастера
  masterTab: 'bookings',      // текущая вкладка панели мастера
  editingService: null,       // услуга, которую редактируем (null = новая)
  editingCategory: null,      // категория, которую редактируем (null = новая)
  masterBookings: [],         // записи мастера (загружаются из Supabase)
  masterServices: [],         // все услуги мастера
  masterCategories: [],       // все категории мастера
  masterClients: [],          // клиенты мастера
  clientPhone: '',            // телефон клиента для записи
};

// Экраны, на которых виден таб-бар
const TAB_SCREENS = ['home', 'bonus', 'history'];

// Маппинг таб → экран
const TAB_MAP = {
  catalog: 'home',
  bonus: 'bonus',
  history: 'history',
};

// Запуск при загрузке страницы
document.addEventListener('DOMContentLoaded', async () => {
  initTelegram();
  createTabBar();

  // Показываем skeleton пока грузим данные
  document.getElementById('app').innerHTML = `
    <div style="padding: 20px; text-align: center; margin-top: 40vh;">
      <div style="font-size: 24px; margin-bottom: 12px;">✨</div>
      <div style="color: var(--tg-theme-hint-color, #999);">Загружаем каталог...</div>
    </div>
  `;

  // Пытаемся загрузить данные из Supabase
  try {
    const data = await loadAllData();
    if (data) {
      // Перезаписываем глобальные переменные данными из базы
      MASTER = data.master;
      CATEGORIES = data.categories;
      SERVICES = data.services;
      SCHEDULE = data.schedule;
      BOOKED_SLOTS = data.bookedSlots;
      BUSY_INTERVALS = data.busyIntervals || {};
      CURRENT_MASTER_ID = data.master.id;
      MASTER_CODE = data.master.master_code || '0000';

      // Загружаем бонусный баланс клиента
      const currentUser = getCurrentUser();
      if (currentUser && CURRENT_MASTER_ID) {
        try {
          const tgId = currentUser.source === 'telegram' ? currentUser.id : 0;
          const bonusData = await loadClientBonus(CURRENT_MASTER_ID, tgId, currentUser.phone);
          CLIENT_BONUS = bonusData.balance;
        } catch (e) { CLIENT_BONUS = 0; }
      }

      // Автовход мастера — если телефон совпадает
      if (currentUser && currentUser.phone && MASTER && MASTER.phone) {
        const userPhone = currentUser.phone.replace(/\D/g, '');
        const masterPhone = MASTER.phone.replace(/\D/g, '');
        if (userPhone.length >= 10 && masterPhone.length >= 10 &&
            (userPhone === masterPhone || userPhone.endsWith(masterPhone.slice(-10)) || masterPhone.endsWith(userPhone.slice(-10)))) {
          state.masterUnlocked = true;
          console.log('🔓 Мастер авторизован по телефону');
        }
      }

      console.log('✅ Данные загружены');
    } else {
      console.warn('⚠️ API недоступен, используем локальные данные');
    }
  } catch (err) {
    console.warn('⚠️ Ошибка загрузки, используем локальные данные:', err);
  }

  // Проверяем URL-параметр ?page= ДО проверки авторизации
  const pageParam = new URLSearchParams(window.location.search).get('page');
  if (pageParam === 'register') {
    renderScreen('register');
    return;
  }
  if (pageParam === 'superadmin') {
    renderScreen('superadmin');
    return;
  }

  // Запускаем приложение
  // Веб-пользователь без авторизации — показываем логин
  if (!tg && !getCurrentUser() && typeof renderLoginScreen === 'function') {
    document.getElementById('app').innerHTML = renderLoginScreen();
    initLoginHandlers((user) => {
      // Успешный вход — перезагружаем
      location.reload();
    });
    return;
  }

  // Создаём колокольчик уведомлений
  createNotificationBell();

  // Push запрашивается при первом нажатии "Начать" (нужен жест пользователя)
  // Для повторных визитов — запрашиваем сразу если уже был онбординг
  if (localStorage.getItem('onboardingDone')) requestPushPermission();

  if (!localStorage.getItem('onboardingDone')) {
    showOnboarding();
  } else {
    renderScreen('home');
    showOfferIfNeeded();
  }
});

// Инициализация Telegram WebApp
function initTelegram() {
  if (!tg) {
    console.warn('Telegram WebApp SDK не найден. Работаем в режиме браузера.');
    return;
  }

  tg.ready();
  tg.expand();

  // Цвет шапки = фон приложения
  if (tg.headerColor !== undefined) {
    tg.headerColor = tg.themeParams?.bg_color || '#ffffff';
  }

  // Обработчик кнопки «Назад»
  tg.BackButton.onClick(() => goBack());
}

// ============================================================
// РОУТЕР
// ============================================================

/**
 * Переход на экран
 * @param {string} screenName — имя экрана (home, catalog, service, booking, success)
 * @param {boolean} pushHistory — добавлять ли в историю (false для goBack)
 */
function navigateTo(screenName, pushHistory = true) {
  if (state.currentScreen === screenName) return;

  if (pushHistory && state.currentScreen) {
    state.screenHistory.push(state.currentScreen);
  }

  state.currentScreen = screenName;
  renderScreen(screenName);
  updateTelegramButtons(screenName);
  haptic('impact', 'light');
}

// Назад
function goBack() {
  if (state.screenHistory.length === 0) return;
  const prev = state.screenHistory.pop();
  state.currentScreen = prev;
  renderScreen(prev, true);
  updateTelegramButtons(prev);
}

// Рендер экрана
function renderScreen(screenName, isBack = false) {
  const app = document.getElementById('app');
  const oldScreen = app.querySelector('.screen.active');

  // Убираем skeleton-загрузку (если осталась)
  const skeleton = app.querySelector(':scope > :not(.screen)');
  if (skeleton) skeleton.remove();

  // Создаём новый экран
  let html = '';
  switch (screenName) {
    case 'home':     html = renderHome(); break;
    case 'catalog':  html = renderCatalog(); break;
    case 'service':  html = renderService(); break;
    case 'booking':  html = renderBooking(); break;
    case 'success':  html = renderSuccess(); break;
    case 'history':  html = renderHistory(); break;
    case 'bonus':    html = renderBonus(); break;
    case 'abonement': html = renderAbonement(); break;
    case 'masterLogin': html = renderMasterLogin(); break;
    case 'masterPanel': html = renderMasterPanel(); break;
    case 'register': html = renderRegisterMaster(); break;
    case 'superadmin': html = renderSuperAdmin(); break;
  }

  const newScreen = document.createElement('div');
  newScreen.className = 'screen';
  newScreen.innerHTML = html;

  // Направление анимации
  if (isBack) {
    newScreen.style.transform = 'translateX(-30px)';
  } else {
    newScreen.style.transform = 'translateX(30px)';
  }

  app.appendChild(newScreen);

  // Запускаем анимацию
  requestAnimationFrame(() => {
    if (oldScreen) {
      oldScreen.classList.remove('active');
      oldScreen.style.transform = isBack ? 'translateX(30px)' : 'translateX(-30px)';
      oldScreen.style.opacity = '0';
      oldScreen.style.pointerEvents = 'none';
      // Удаляем старый экран после анимации
      setTimeout(() => oldScreen.remove(), 300);
    }

    newScreen.classList.add('active');
    newScreen.style.transform = 'translateX(0)';
  });

  // Привязываем обработчики событий после рендера
  requestAnimationFrame(() => {
    bindEvents(screenName, newScreen);
  });

  // Обновляем таб-бар
  updateTabBar(screenName);

  // Скроллим наверх
  window.scrollTo(0, 0);
}

// Обновление кнопок Telegram
function updateTelegramButtons(screenName) {
  // Fallback-кнопка «Назад» для браузера (когда нет Telegram SDK)
  updateFallbackBackButton(screenName);

  if (!tg) return;

  // BackButton — скрываем на табовых экранах и success
  if (TAB_SCREENS.includes(screenName) || screenName === 'success') {
    tg.BackButton.hide();
  } else {
    tg.BackButton.show();
  }

  // MainButton
  tg.MainButton.offClick(mainButtonHandler);
  switch (screenName) {
    case 'home':
    case 'catalog':
    case 'history':
    case 'bonus':
    case 'abonement':
    case 'masterLogin':
    case 'masterPanel':
    case 'booking':
      tg.MainButton.hide();
      break;
    case 'service':
      tg.MainButton.setText('ЗАПИСАТЬСЯ');
      tg.MainButton.show();
      tg.MainButton.onClick(mainButtonHandler);
      break;
    case 'success':
      tg.MainButton.setText('ЗАКРЫТЬ');
      tg.MainButton.show();
      tg.MainButton.onClick(mainButtonHandler);
      break;
  }
}

// Обработчик MainButton
function mainButtonHandler() {
  switch (state.currentScreen) {
    case 'service':
      // Сбрасываем выбор даты/времени при новом переходе
      state.selectedDate = null;
      state.selectedTime = null;
      navigateTo('booking');
      break;
    case 'booking':
      if (state.selectedDate && state.selectedTime) {
        const consent = document.querySelector('#consentCheckbox');
        if (!consent || !consent.checked) return;
        submitBooking();
      }
      break;
    case 'success':
      if (tg) tg.close();
      else navigateTo('home');
      break;
  }
}

// ============================================================
// ЭКРАН 1: ГЛАВНАЯ (КАТЕГОРИИ)
// ============================================================

function renderHome() {
  // Считаем количество услуг в каждой категории
  const counts = {};
  CATEGORIES.forEach(c => {
    counts[c.id] = SERVICES.filter(s => s.category === c.id && s.active).length;
  });

  // Есть ли акционные услуги
  const saleServices = SERVICES.filter(s => s.salePrice && s.active);
  const hasSale = saleServices.length > 0;

  const categoriesHTML = CATEGORIES
    .sort((a, b) => a.sort - b.sort)
    .map(c => `
      <div class="category-card" data-category="${c.id}">
        <span class="category-icon">${c.icon}</span>
        <div class="category-name">${c.name}</div>
        <div class="category-count">${formatCount(counts[c.id] || 0)}</div>
      </div>
    `).join('');

  const promoHTML = hasSale ? `
    <div class="promo-banner" data-action="show-sales">
      <div class="promo-badge">АКЦИЯ</div>
      <div class="promo-title">Скидка до 20% на первый визит</div>
      <div class="promo-text">Успейте записаться по выгодной цене</div>
    </div>
  ` : '';

  // Инициалы для аватара
  const initials = MASTER.name.split(' ').map(w => w[0]).join('').slice(0, 2);

  return `
    <div class="role-tabs">
      <button class="role-tab active" id="roleClient">Клиент</button>
      <button class="role-tab" id="roleMaster">Мастер</button>
    </div>

    <div class="master-header">
      <div class="master-avatar">
        ${MASTER.avatar
          ? `<img src="${MASTER.avatar}" alt="${MASTER.name}">`
          : initials}
      </div>
      <div class="master-info">
        <div class="master-name">${MASTER.name}</div>
        <div class="master-desc">${MASTER.description}</div>
      </div>
    </div>

    <div class="contact-buttons">
      <a href="tel:${MASTER.phone}" class="contact-btn contact-btn-call">
        <span class="contact-btn-icon">📞</span> Позвонить
      </a>
      <a href="${MASTER.whatsapp_url || 'https://wa.me/' + (MASTER.phone || '').replace(/[^0-9]/g, '')}" class="contact-btn contact-btn-write" target="_blank">
        <span class="contact-btn-icon">💬</span> Написать
      </a>
    </div>

    <div class="section-title">Услуги</div>
    <div class="categories-grid">
      ${categoriesHTML}
    </div>

    ${promoHTML}

    <div class="home-booking-section">
      <button class="home-booking-btn" id="homeBookingBtn">
        <span class="home-booking-btn-icon">📅</span> Выбрать дату
      </button>
      <div class="home-calendar hidden" id="homeCalendar">
        <div class="booking-section-title">Выберите дату</div>
        <div class="date-picker" id="homeDatePicker">
          ${renderHomeDates()}
        </div>
        <div class="booking-section-title">Выберите время</div>
        <div id="homeTimeContainer">
          <div class="no-slots">Выберите дату</div>
        </div>
      </div>
    </div>

    <button class="home-history-btn home-abonement-btn" id="homeAbonementBtn">
      <span class="home-booking-btn-icon">🏷️</span> Абонементы
    </button>

    <button class="home-history-btn home-share-btn" id="homeShareBtn">
      <span class="home-booking-btn-icon">💌</span> Поделиться с другом
    </button>

    ${(typeof Notification !== 'undefined' && Notification.permission !== 'granted' && !isIosInBrowser()) ? `
    <button class="home-history-btn" id="enablePushBtn" style="background:var(--tg-theme-button-color,#2196F3);color:var(--tg-theme-button-text-color,#fff)">
      <span class="home-booking-btn-icon">🔔</span> Включить уведомления
    </button>
    ` : ''}

  `;
}

// ============================================================
// БОНУСЫ
// ============================================================

function getBonusBalance() {
  return parseFloat(localStorage.getItem('bonusBalance') || '0').toFixed(0);
}

function addBonus(price) {
  const current = parseFloat(localStorage.getItem('bonusBalance') || '0');
  const bonus = price * 0.03;
  localStorage.setItem('bonusBalance', (current + bonus).toFixed(2));
}

function renderBonus() {
  const balance = CLIENT_BONUS || 0;

  return `
    <div class="history-screen">
      <div class="history-title">Бонусы</div>
      <div class="bonus-balance-card">
        <div class="bonus-balance-label">Ваш баланс</div>
        <div class="bonus-balance-value">${balance} ₽</div>
        <div class="bonus-balance-hint">3% с каждого посещения · сгорают через 3 месяца</div>
      </div>
      <div class="bonus-history-title">Как это работает</div>
      <div class="history-empty">
        💎 За каждый визит вам начисляется 3% от стоимости услуги.<br><br>
        ✅ Бонусы начисляются после того, как мастер подтвердит ваш визит.<br><br>
        🛒 Бонусы можно списать при следующей записи — в счёт оплаты услуги.<br><br>
        ⏰ Бонусы сгорают через 3 месяца, если их не использовать.
      </div>
    </div>
  `;
}

// ============================================================
// ЭКРАН: АБОНЕМЕНТЫ
// ============================================================

function renderAbonement() {
  const abonements = state.abonements || [];

  if (!abonements.length) {
    return `
      <div class="history-screen">
        <div class="history-title">Абонементы</div>
        <div class="history-empty">Пока нет абонементов</div>
      </div>
    `;
  }

  // Группируем по complex_name
  const grouped = {};
  abonements.forEach(a => {
    if (!grouped[a.complex_name]) grouped[a.complex_name] = [];
    grouped[a.complex_name].push(a);
  });

  let cardsHTML = '';
  Object.keys(grouped).forEach(complexName => {
    const items = grouped[complexName];
    const basePrice = items[0].base_price;

    cardsHTML += `
      <div class="abonement-section-title">${complexName}</div>
      <div class="abonement-section-sub">По комплексу у нас ${basePrice.toLocaleString()} ₽</div>
    `;

    items.forEach(a => {
      const oldPrice = a.base_price * a.sessions;
      const newPrice = Math.round(oldPrice * (1 - a.discount / 100));
      const saving = oldPrice - newPrice;

      cardsHTML += `
        <div class="abonement-card">
          <div class="abonement-card-header">
            <span class="abonement-card-name">${a.sessions} процедур</span>
            <span class="abonement-card-badge">-${a.discount}%</span>
          </div>
          <div class="abonement-card-prices">
            <span class="abonement-old-price">${oldPrice.toLocaleString()} ₽</span>
            <span class="abonement-new-price">${newPrice.toLocaleString()} ₽</span>
          </div>
          <div class="abonement-card-saving">Экономия ${saving.toLocaleString()} ₽</div>
        </div>
      `;
    });
  });

  return `
    <div class="history-screen">
      <div class="history-title">Абонементы</div>
      ${cardsHTML}
      <div class="abonement-hint">Можно оформить рассрочку</div>
    </div>
  `;
}

// ============================================================
// ЭКРАН: ВХОД МАСТЕРА (КОД ДОСТУПА)
// ============================================================

function renderMasterLogin() {
  return `
    <div class="history-screen">
      <div class="role-tabs">
        <button class="role-tab" id="roleClientFromLogin">Клиент</button>
        <button class="role-tab active">Мастер</button>
      </div>

      <div class="master-login">
        <div class="master-login-icon">🔒</div>
        <div class="master-login-title">Вход для мастера</div>
        <div class="master-login-hint">Введите код доступа</div>
        <input type="password" class="master-login-input" id="masterCodeInput" maxlength="10" placeholder="Код доступа" inputmode="numeric">
        <div class="master-login-error hidden" id="masterLoginError">Неверный код доступа</div>
        <button class="master-login-btn" id="masterLoginBtn">Войти</button>
      </div>
    </div>
  `;
}

// ============================================================
// ЭКРАН: ПАНЕЛЬ МАСТЕРА
// ============================================================

function renderMasterPanel() {
  const tab = state.masterTab || 'bookings';

  const tabsHTML = `
    <div class="role-tabs">
      <button class="role-tab" id="roleClientFromMaster">Клиент</button>
      <button class="role-tab active" id="roleMasterFromMaster">Мастер</button>
    </div>
    <div class="admin-tabs">
      <button class="admin-tab ${tab === 'bookings' ? 'active' : ''}" data-tab="bookings">Записи</button>
      <button class="admin-tab ${tab === 'services' ? 'active' : ''}" data-tab="services">Услуги</button>
      <button class="admin-tab ${tab === 'categories' ? 'active' : ''}" data-tab="categories">Категории</button>
      <button class="admin-tab ${tab === 'clients' ? 'active' : ''}" data-tab="clients">Клиенты</button>
      <button class="admin-tab ${tab === 'abonements' ? 'active' : ''}" data-tab="abonements">Абонементы</button>
      <button class="admin-tab ${tab === 'schedule' ? 'active' : ''}" data-tab="schedule">График</button>
      <button class="admin-tab ${tab === 'broadcast' ? 'active' : ''}" data-tab="broadcast">Рассылка</button>
      <button class="admin-tab ${tab === 'profile' ? 'active' : ''}" data-tab="profile">Профиль</button>
    </div>
  `;

  let contentHTML = '';
  switch (tab) {
    case 'bookings': contentHTML = renderMasterBookings(); break;
    case 'services': contentHTML = renderMasterServicesList(); break;
    case 'categories': contentHTML = renderMasterCategoriesList(); break;
    case 'abonements': contentHTML = renderMasterAbonements(); break;
    case 'clients':  contentHTML = renderMasterClientsList(); break;
    case 'schedule': contentHTML = renderMasterSchedule(); break;
    case 'broadcast': contentHTML = renderBroadcastForm(); break;
    case 'profile': contentHTML = renderMasterProfile(); break;
    case 'serviceForm': contentHTML = renderServiceForm(); break;
    case 'categoryForm': contentHTML = renderCategoryForm(); break;
    case 'abonementForm': contentHTML = renderAbonementForm(); break;
    case 'scheduleForm': contentHTML = renderScheduleForm(); break;
  }

  return `
    <div class="history-screen admin-panel">
      ${tab === 'serviceForm' ? `
        <div class="admin-back-row">
          <button class="admin-back-btn" id="backToServices">← Назад к услугам</button>
        </div>
      ` : tab === 'categoryForm' ? `
        <div class="admin-back-row">
          <button class="admin-back-btn" id="backToCategories">← Назад к категориям</button>
        </div>
      ` : tab === 'abonementForm' ? `
        <div class="admin-back-row">
          <button class="admin-back-btn" id="backToAbonements">← Назад к абонементам</button>
        </div>
      ` : tabsHTML}
      <div id="adminContent">${contentHTML}</div>
    </div>
  `;
}

// --- Вкладка «Записи» ---
function renderMasterBookings() {
  const bookings = state.masterBookings;
  const today = formatDateKey ? formatDateKey(new Date()) : new Date().toISOString().split('T')[0];
  const todayBookings = bookings.filter(b => b.date === today);
  const totalRevenue = bookings.reduce((sum, b) => sum + (b.price || 0), 0);

  const statsHTML = `
    <div class="master-stats">
      <div class="master-stat-card">
        <div class="master-stat-value">${todayBookings.length}</div>
        <div class="master-stat-label">Сегодня</div>
      </div>
      <div class="master-stat-card">
        <div class="master-stat-value">${bookings.length}</div>
        <div class="master-stat-label">Всего</div>
      </div>
      <div class="master-stat-card">
        <div class="master-stat-value">${totalRevenue.toLocaleString('ru-RU')}</div>
        <div class="master-stat-label">Выручка, ₽</div>
      </div>
    </div>
  `;

  const listHTML = bookings.length
    ? bookings.map(b => {
        const serviceName = b.services?.name || 'Услуга';
        const timeShort = b.time ? b.time.substring(0, 5) : '';
        const statusMap = {
          confirmed: { cls: 'confirmed', label: 'Подтверждено' },
          pending: { cls: 'pending', label: 'Ожидает' },
          cancelled: { cls: 'cancelled', label: 'Отменено' },
          completed: { cls: 'completed', label: 'Завершено ✅' },
          no_show: { cls: 'no-show', label: 'Не пришёл ❌' },
        };
        const st = statusMap[b.status] || { cls: 'pending', label: b.status };
        const bonusInfo = b.bonus_credited ? ' · 💎 бонус начислен' : '';

        return `
        <div class="admin-booking-card">
          <div class="admin-booking-header">
            <span class="admin-booking-name">${b.client_name || 'Клиент'}${b.client_username ? ' @' + b.client_username : ''}</span>
            <span class="admin-booking-status ${st.cls}">${st.label}</span>
          </div>
          <div class="admin-booking-details">
            <span>${serviceName}</span>
            <span>${b.date}, ${timeShort}</span>
            <span>${b.price ? b.price + ' ₽' : ''}${bonusInfo}</span>
          </div>
          ${b.status === 'pending' ? `
            <div class="admin-booking-actions">
              <button class="admin-btn confirm" data-booking-id="${b.id}">Подтвердить</button>
              <button class="admin-btn cancel" data-booking-id="${b.id}">Отменить</button>
            </div>
          ` : ''}
          ${b.status === 'confirmed' ? `
            <div class="admin-booking-actions">
              <button class="admin-btn completed" data-booking-id="${b.id}" data-client-tg="${b.client_tg_id}" data-price="${b.price || 0}">✅ Визит состоялся</button>
              <button class="admin-btn no-show" data-booking-id="${b.id}" data-client-tg="${b.client_tg_id}">❌ Не пришёл</button>
            </div>
          ` : ''}
        </div>
      `;
      }).join('')
    : '<div class="history-empty">Нет предстоящих записей</div>';

  return `${statsHTML}<div class="master-section-title">Предстоящие записи</div>${listHTML}`;
}

// --- Вкладка «Услуги» ---
function renderMasterServicesList() {
  const services = state.masterServices;

  if (!services.length) {
    return `
      <button class="admin-add-btn" id="addServiceBtn">+ Добавить услугу</button>
      <div class="history-empty">Нет услуг</div>
    `;
  }

  // Группируем услуги по категориям
  const grouped = {};
  const noCategory = [];

  services.forEach(s => {
    if (s.category_id) {
      if (!grouped[s.category_id]) grouped[s.category_id] = [];
      grouped[s.category_id].push(s);
    } else {
      noCategory.push(s);
    }
  });

  function renderServiceCard(s) {
    const cat = CATEGORIES.find(c => c.id === s.category_id);
    const photoThumb = s.photos && s.photos.length > 0
      ? `<img src="${s.photos[0]}" class="admin-service-thumb">`
      : `<div class="admin-service-thumb-placeholder">${cat ? cat.icon : '✨'}</div>`;

    return `
      <div class="admin-service-card" data-service-id="${s.id}">
        ${photoThumb}
        <div class="admin-service-info">
          <div class="admin-service-name">${s.name}</div>
          <div class="admin-service-meta">${s.duration} мин · ${s.price} ₽${s.sale_price ? ' / ' + s.sale_price + ' ₽' : ''}</div>
        </div>
        <div class="admin-service-actions">
          <button class="admin-icon-btn edit" data-service-id="${s.id}" title="Редактировать">✏️</button>
          <button class="admin-icon-btn delete" data-service-id="${s.id}" title="Удалить">🗑️</button>
        </div>
      </div>
    `;
  }

  // Выводим по категориям в порядке CATEGORIES
  let listHTML = '';
  CATEGORIES.forEach(cat => {
    const catServices = grouped[cat.id];
    if (catServices && catServices.length > 0) {
      listHTML += `<div class="admin-category-group">
        <div class="admin-category-title">${cat.icon} ${cat.name}</div>
        ${catServices.map(renderServiceCard).join('')}
      </div>`;
    }
  });

  // Услуги без категории
  if (noCategory.length > 0) {
    listHTML += `<div class="admin-category-group">
      <div class="admin-category-title">Без категории</div>
      ${noCategory.map(renderServiceCard).join('')}
    </div>`;
  }

  return `
    <button class="admin-add-btn" id="addServiceBtn">+ Добавить услугу</button>
    ${listHTML}
  `;
}

// --- Вкладка «Клиенты» ---
function renderMasterClientsList() {
  const clients = state.masterClients;

  const listHTML = clients.length
    ? clients.map(c => {
        const date = c.created_at ? new Date(c.created_at).toLocaleDateString('ru-RU') : '';
        return `
        <div class="admin-client-card">
          <div class="admin-client-name">${c.first_name || 'Клиент'}${c.username ? ' @' + c.username : ''}</div>
          ${c.phone ? '<div class="admin-client-phone">📞 ' + c.phone + '</div>' : ''}
          <div class="admin-client-meta">
            <span>Визитов: ${c.visits_count || 0}</span>
            <span>Бонусы: ${c.bonus_balance || 0} ₽</span>
            <span>С ${date}</span>
          </div>
        </div>
      `;
      }).join('')
    : '<div class="history-empty">Пока нет клиентов</div>';

  return `<div class="master-section-title">Клиенты (${clients.length})</div>${listHTML}`;
}

// --- Вкладка «Абонементы» (мастер) ---
function renderMasterAbonements() {
  const abonements = state.masterAbonements || [];

  if (!abonements.length) {
    return `
      <button class="admin-add-btn" id="addAbonementBtn">+ Добавить абонемент</button>
      <div class="history-empty">Нет абонементов</div>
    `;
  }

  // Группируем по complex_name
  const grouped = {};
  abonements.forEach(a => {
    if (!grouped[a.complex_name]) grouped[a.complex_name] = [];
    grouped[a.complex_name].push(a);
  });

  let html = '<button class="admin-add-btn" id="addAbonementBtn">+ Добавить абонемент</button>';

  Object.keys(grouped).forEach(complexName => {
    const items = grouped[complexName];
    const basePrice = items[0].base_price;
    html += `<div class="admin-category-group">
      <div class="admin-category-title">🏷️ ${complexName}</div>
      <div class="admin-abonement-base">Цена за процедуру: ${basePrice} ₽</div>`;

    items.forEach(a => {
      const oldPrice = a.base_price * a.sessions;
      const newPrice = Math.round(oldPrice * (1 - a.discount / 100));
      const saving = oldPrice - newPrice;
      html += `
        <div class="admin-service-card" data-abon-id="${a.id}">
          <div class="admin-service-info">
            <div class="admin-service-name">${a.sessions} процедур · −${a.discount}%</div>
            <div class="admin-service-meta">${oldPrice.toLocaleString()} → ${newPrice.toLocaleString()} ₽ (экономия ${saving.toLocaleString()} ₽)</div>
          </div>
          <div class="admin-service-actions">
            <button class="admin-icon-btn edit-abon" data-abon-id="${a.id}" title="Редактировать">✏️</button>
            <button class="admin-icon-btn delete-abon" data-abon-id="${a.id}" title="Удалить">🗑️</button>
          </div>
        </div>`;
    });

    html += '</div>';
  });

  return html;
}

function renderAbonementForm() {
  const isEdit = !!state.editingAbonement?.id;
  const a = state.editingAbonement || {};
  return `
    <div class="admin-form">
      <div class="admin-form-title">${isEdit ? 'Редактировать абонемент' : 'Новый абонемент'}</div>
      <label class="admin-label">Название комплекса</label>
      <input class="admin-input" id="abonComplexName" value="${a.complex_name || ''}" placeholder="Комплекс XS: Глубокое бикини + подмышки">
      <label class="admin-label">Цена за 1 процедуру, ₽</label>
      <input class="admin-input" id="abonBasePrice" type="number" value="${a.base_price || ''}" placeholder="3250">
      <label class="admin-label">Кол-во процедур</label>
      <input class="admin-input" id="abonSessions" type="number" value="${a.sessions || ''}" placeholder="10">
      <label class="admin-label">Скидка, %</label>
      <input class="admin-input" id="abonDiscount" type="number" value="${a.discount || 0}" placeholder="12">
      <label class="admin-label">Порядок сортировки</label>
      <input class="admin-input" id="abonSort" type="number" value="${a.sort_order || 0}">
      <button class="admin-save-btn" id="saveAbonementBtn">${isEdit ? 'Сохранить' : 'Создать абонемент'}</button>
    </div>
  `;
}

// --- Вкладка «Рассылка» ---
function renderBroadcastForm() {
  const clients = state.masterClients || [];
  const clientListHTML = clients.length
    ? `<div class="broadcast-select-all">
         <label><input type="checkbox" id="selectAllClients" checked> Выбрать всех (${clients.length})</label>
       </div>` +
      clients.map(c => {
        const name = c.first_name || 'Клиент';
        const info = c.phone ? ` (${c.phone})` : c.username ? ` (@${c.username})` : '';
        return `<label class="broadcast-client-row">
          <input type="checkbox" class="broadcast-client-check" data-phone="${c.phone || ''}" data-tg="${c.tg_user_id || ''}" checked>
          <span>${name}${info}</span>
        </label>`;
      }).join('')
    : '<div class="history-empty">Нет клиентов для рассылки</div>';

  return `
    <div class="master-section-title">Рассылка клиентам</div>
    <div class="broadcast-info">Выберите клиентов и напишите сообщение.</div>
    ${clientListHTML}
    <textarea id="broadcastText" class="broadcast-textarea" placeholder="Введите текст сообщения..." rows="5"></textarea>
    <button class="booking-confirm-btn" id="sendBroadcastBtn">Отправить рассылку</button>
    <div id="broadcastResult" class="broadcast-result"></div>
  `;
}

// --- Вкладка «График работы» ---
const DAY_NAMES = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const DAY_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

function renderMasterSchedule() {
  const schedule = state.masterSchedule || [];

  // Создаём массив 7 дней (0=Вс, 1=Пн ... 6=Сб), отображаем с Пн
  const dayOrder = [1, 2, 3, 4, 5, 6, 0]; // Пн-Вс

  let html = '<div class="master-section-title">График работы</div>';
  html += '<div class="schedule-info">Настройте рабочие дни и время приёма клиентов</div>';

  html += '<div class="schedule-days-list">';
  dayOrder.forEach(dayNum => {
    const row = schedule.find(s => s.day_of_week === dayNum);
    const isActive = row && row.is_active;
    const startTime = row ? row.start_time?.substring(0, 5) : '';
    const endTime = row ? row.end_time?.substring(0, 5) : '';
    const interval = row ? row.slot_interval : 30;

    html += `
      <div class="schedule-day-card ${isActive ? 'active' : 'inactive'}">
        <div class="schedule-day-header">
          <label class="schedule-day-toggle">
            <input type="checkbox" class="schedule-day-check" data-day="${dayNum}" ${isActive ? 'checked' : ''}>
            <span class="schedule-day-name">${DAY_NAMES[dayNum]}</span>
          </label>
          ${isActive ? `<span class="schedule-day-time">${startTime} — ${endTime}</span>` : '<span class="schedule-day-off">Выходной</span>'}
        </div>
        ${isActive ? `
          <div class="schedule-day-details">
            <div class="schedule-time-row">
              <label>С: <input type="time" class="schedule-start" data-day="${dayNum}" value="${startTime}"></label>
              <label>До: <input type="time" class="schedule-end" data-day="${dayNum}" value="${endTime}"></label>
              <label>Шаг: <select class="schedule-interval" data-day="${dayNum}">
                <option value="15" ${interval === 15 ? 'selected' : ''}>15 мин</option>
                <option value="30" ${interval === 30 ? 'selected' : ''}>30 мин</option>
                <option value="60" ${interval === 60 ? 'selected' : ''}>1 час</option>
                <option value="90" ${interval === 90 ? 'selected' : ''}>1.5 часа</option>
                <option value="120" ${interval === 120 ? 'selected' : ''}>2 часа</option>
              </select></label>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  });
  html += '</div>';

  html += '<button class="booking-confirm-btn" id="saveScheduleBtn">Сохранить график</button>';
  html += '<div id="scheduleResult" class="broadcast-result"></div>';

  return html;
}

// --- Вкладка «Профиль» ---
function renderMasterProfile() {
  const m = MASTER || {};
  return `
    <div class="master-section-title">Профиль мастера</div>
    <div class="admin-form">
      <label class="admin-label">Название салона / имя мастера</label>
      <input type="text" id="profileName" class="admin-input" value="${(m.name || '').replace(/"/g, '&quot;')}" placeholder="Например: Студия Анны" />

      <label class="admin-label">Описание</label>
      <textarea id="profileDescription" class="admin-input admin-textarea" rows="3" placeholder="Краткое описание вашей деятельности">${m.description || ''}</textarea>

      <label class="admin-label">Телефон</label>
      <input type="tel" id="profilePhone" class="admin-input" value="${(m.phone || '').replace(/"/g, '&quot;')}" placeholder="+7 (999) 123-45-67" />

      <label class="admin-label">WhatsApp</label>
      <input type="text" id="profileWhatsapp" class="admin-input" value="${(m.whatsapp_url || '').replace(/"/g, '&quot;')}" placeholder="https://wa.me/79991234567" />
      <div class="admin-form-hint" style="font-size:12px;color:var(--tg-theme-hint-color,#999);margin:4px 0 8px;">Формат: https://wa.me/79991234567 (без +, без пробелов)</div>

      <label class="admin-label">Приветственное сообщение (в боте)</label>
      <textarea id="profileWelcome" class="admin-input admin-textarea" rows="2" placeholder="Текст при нажатии /start в боте">${m.welcome_text || ''}</textarea>

      <label class="admin-label">Код доступа к панели мастера</label>
      <input type="text" id="profileCode" class="admin-input" value="${(m.master_code || '').replace(/"/g, '&quot;')}" placeholder="4 цифры" maxlength="4" />

      <button class="booking-confirm-btn" id="saveProfileBtn" style="margin-top:16px;">Сохранить профиль</button>
      <div id="profileResult" class="broadcast-result"></div>
    </div>
  `;
}

// --- Вкладка «Категории» ---
function renderMasterCategoriesList() {
  const categories = state.masterCategories;

  const listHTML = categories.length
    ? categories.map(c => `
        <div class="admin-service-card" data-cat-id="${c.id}">
          <div class="admin-service-thumb-placeholder">${c.icon || '📁'}</div>
          <div class="admin-service-info">
            <div class="admin-service-name">${c.name}</div>
            <div class="admin-service-meta">Порядок: ${c.sort_order || 0}</div>
          </div>
          <div class="admin-service-actions">
            <button class="admin-icon-btn edit-cat" data-cat-id="${c.id}" title="Редактировать">✏️</button>
            <button class="admin-icon-btn delete-cat" data-cat-id="${c.id}" title="Удалить">🗑️</button>
          </div>
        </div>
      `).join('')
    : '<div class="history-empty">Нет категорий</div>';

  return `
    <button class="admin-add-btn" id="addCategoryBtn">+ Добавить категорию</button>
    ${listHTML}
  `;
}

// --- Форма добавления/редактирования категории ---
function renderCategoryForm() {
  const c = state.editingCategory;
  const isEdit = !!c;
  const title = isEdit ? 'Редактировать категорию' : 'Новая категория';

  const currentPhoto = isEdit && c.photo_url ? `<div class="admin-cat-photo-preview"><img src="${c.photo_url}" style="width:100%;max-height:140px;object-fit:cover;border-radius:10px;margin-bottom:8px;"></div>` : '';

  return `
    <div class="admin-form">
      <div class="master-section-title">${title}</div>

      <label class="admin-label">Фото категории</label>
      ${currentPhoto}
      <label class="admin-upload-btn" for="catPhotoInput">+ Загрузить фото</label>
      <input type="file" id="catPhotoInput" accept="image/*" style="display:none">
      <div id="catPhotoPreview" style="margin-top:6px;font-size:13px;color:var(--tg-theme-hint-color)"></div>

      <label class="admin-label">Иконка (эмодзи)</label>
      <input class="admin-input" id="catIcon" value="${isEdit ? (c.icon || '') : '✨'}" placeholder="✨">

      <label class="admin-label">Название</label>
      <input class="admin-input" id="catName" value="${isEdit ? c.name : ''}" placeholder="Лазерная эпиляция">

      <label class="admin-label">Порядок сортировки</label>
      <input class="admin-input" id="catSort" type="number" value="${isEdit ? (c.sort_order || 0) : '0'}" placeholder="0">

      <button class="admin-save-btn" id="saveCategoryBtn">${isEdit ? 'Сохранить' : 'Создать категорию'}</button>
    </div>
  `;
}

// --- Форма добавления/редактирования услуги ---
function renderServiceForm() {
  const s = state.editingService;
  const isEdit = !!s;
  const title = isEdit ? 'Редактировать услугу' : 'Новая услуга';

  const categoriesOptions = CATEGORIES.map(c =>
    `<option value="${c.id}" ${s && s.category_id === c.id ? 'selected' : ''}>${c.icon} ${c.name}</option>`
  ).join('');

  const photosHTML = (s && s.photos && s.photos.length > 0)
    ? s.photos.map((url, i) => `
        <div class="admin-photo-item" data-index="${i}">
          <img src="${url}">
          <button class="admin-photo-delete" data-index="${i}">×</button>
        </div>
      `).join('')
    : '';

  return `
    <div class="admin-form">
      <div class="master-section-title">${title}</div>

      <label class="admin-label">Название</label>
      <input class="admin-input" id="svcName" value="${isEdit ? s.name : ''}" placeholder="Лазерная эпиляция ног">

      <label class="admin-label">Категория</label>
      <select class="admin-input" id="svcCategory">${categoriesOptions}</select>

      <div class="admin-row">
        <div class="admin-col">
          <label class="admin-label">Цена, ₽</label>
          <input class="admin-input" id="svcPrice" type="number" value="${isEdit ? s.price : ''}" placeholder="2000">
        </div>
        <div class="admin-col">
          <label class="admin-label">Акция, ₽</label>
          <input class="admin-input" id="svcSalePrice" type="number" value="${isEdit && s.sale_price ? s.sale_price : ''}" placeholder="">
        </div>
      </div>

      <div class="admin-row">
        <div class="admin-col">
          <label class="admin-label">Длительность, мин</label>
          <input class="admin-input" id="svcDuration" type="number" value="${isEdit ? s.duration : '60'}" placeholder="60">
        </div>
        <div class="admin-col">
          <label class="admin-label">Порядок</label>
          <input class="admin-input" id="svcSort" type="number" value="${isEdit ? s.sort_order : '0'}" placeholder="0">
        </div>
      </div>

      <label class="admin-label">Описание</label>
      <textarea class="admin-input admin-textarea" id="svcDescription" placeholder="Описание услуги...">${isEdit ? (s.description || '') : ''}</textarea>

      <label class="admin-label">Фото</label>
      <div class="admin-photos" id="svcPhotos">${photosHTML}</div>
      <label class="admin-upload-btn" for="svcPhotoInput">+ Загрузить фото</label>
      <input type="file" id="svcPhotoInput" accept="image/*" multiple style="display:none">

      <button class="admin-save-btn" id="saveServiceBtn">${isEdit ? 'Сохранить' : 'Создать услугу'}</button>
    </div>
  `;
}

// ============================================================
// ЭКРАН: ИСТОРИЯ ПОСЕЩЕНИЙ
// ============================================================

function renderHistory() {
  const bookings = JSON.parse(localStorage.getItem('bookingHistory') || '[]');

  const listHTML = bookings.length
    ? bookings.map(b => `
      <div class="history-card">
        <div class="history-card-header">
          <span class="history-card-name">${b.serviceName}</span>
          <span class="history-card-price">${b.price} ₽</span>
        </div>
        <div class="history-card-details">
          <span>${b.date}, ${b.time}</span>
        </div>
      </div>
    `).join('')
    : '<div class="history-empty">Пока нет записей. После первого визита здесь появится история.</div>';

  return `
    <div class="history-screen">
      <div class="history-title">История посещений</div>
      ${listHTML}
    </div>
  `;
}

// Генерация чипов дат для главного экрана
function renderHomeDates() {
  const dates = Object.keys(SCHEDULE).sort();
  return dates.map(dateKey => {
    const date = parseDate(dateKey);
    return `
      <div class="date-chip" data-date="${dateKey}">
        <div class="date-chip-day">${getDayName(date)}</div>
        <div class="date-chip-num">${date.getDate()}</div>
        <div class="date-chip-month">${getMonthShort(date)}</div>
      </div>
    `;
  }).join('');
}

// ============================================================
// ЭКРАН 2: КАТАЛОГ (СПИСОК УСЛУГ)
// ============================================================

function renderCatalog() {
  // Специальная категория — акционные услуги
  if (state.selectedCategory === '__sale') {
    const saleServices = SERVICES.filter(s => s.salePrice && s.active);
    const cardsHTML = saleServices.map(s => {
      const cat = CATEGORIES.find(c => c.id === s.category);
      return renderServiceCard(s, cat ? cat.icon : '✨');
    }).join('');

    return `
      <div class="catalog-header">🔥 Акции</div>
      <div class="services-list">${cardsHTML}</div>
    `;
  }

  const category = CATEGORIES.find(c => c.id === state.selectedCategory);
  if (!category) return '<p>Категория не найдена</p>';

  const services = SERVICES
    .filter(s => s.category === category.id && s.active)
    .sort((a, b) => a.sort - b.sort);

  const cardsHTML = services.map(s => renderServiceCard(s, category.icon)).join('');

  return `
    <div class="catalog-header">${category.icon} ${category.name}</div>
    <div class="services-list">
      ${cardsHTML}
    </div>
  `;
}

function renderServiceCard(service, categoryIcon) {
  const saleHTML = service.salePrice
    ? `<span class="sale-badge">-${Math.round((1 - service.salePrice / service.price) * 100)}%</span>`
    : '';

  const priceHTML = service.salePrice
    ? `<span class="service-price">${formatPrice(service.salePrice)}</span>
       <span class="service-old-price">${formatPrice(service.price)}</span>`
    : `<span class="service-price">${formatPrice(service.price)}</span>`;

  return `
    <div class="service-card" data-service-id="${service.id}">
      <div class="service-thumb">${categoryIcon}</div>
      <div class="service-info">
        <div class="service-name">${service.name}</div>
        <div class="service-duration">${formatDuration(service.duration)}</div>
        <div class="service-price-row">${priceHTML}</div>
      </div>
      ${saleHTML}
    </div>
  `;
}

// ============================================================
// ЭКРАН 3: ДЕТАЛИ УСЛУГИ
// ============================================================

function renderService() {
  const service = state.selectedService;
  if (!service) return '<p>Услуга не найдена</p>';

  const category = CATEGORIES.find(c => c.id === service.category);
  const icon = category ? category.icon : '✨';
  state.galleryIndex = 0;

  // Галерея: фото или иконка-заглушка
  const slides = service.photos.length > 0
    ? service.photos.map(url => `<div class="gallery-slide"><img src="${url}" alt="${service.name}"></div>`).join('')
    : `<div class="gallery-slide">${icon}</div>`;

  const dotsCount = Math.max(service.photos.length, 1);
  const dotsHTML = dotsCount > 1
    ? `<div class="gallery-dots">
        ${Array.from({length: dotsCount}, (_, i) =>
          `<div class="gallery-dot ${i === 0 ? 'active' : ''}" data-index="${i}"></div>`
        ).join('')}
       </div>`
    : '';

  // Цена
  let priceHTML = '';
  if (service.salePrice) {
    priceHTML = `
      <div class="detail-meta-item">
        <span class="detail-meta-icon">💰</span>
        <span class="detail-meta-value price sale">
          ${formatPrice(service.salePrice)}
          <span class="old-price">${formatPrice(service.price)}</span>
        </span>
      </div>
    `;
  } else {
    priceHTML = `
      <div class="detail-meta-item">
        <span class="detail-meta-icon">💰</span>
        <span class="detail-meta-value price">${formatPrice(service.price)}</span>
      </div>
    `;
  }

  return `
    <div class="detail-gallery" id="gallery">
      <div class="gallery-container" id="galleryContainer">
        ${slides}
      </div>
    </div>
    ${dotsHTML}

    <div class="detail-title">${service.name}</div>

    <div class="detail-meta">
      <div class="detail-meta-item">
        <span class="detail-meta-icon">🕐</span>
        <span class="detail-meta-value">${formatDuration(service.duration)}</span>
      </div>
      ${priceHTML}
    </div>

    <div class="detail-description-title">Описание</div>
    <div class="detail-description">${service.description}</div>

    ${!tg ? '<button class="booking-confirm-btn" id="serviceBookBtn">Записаться</button>' : ''}
  `;
}

// ============================================================
// ЭКРАН 4: ЗАПИСЬ (ДАТА/ВРЕМЯ)
// ============================================================

// Проверяет, помещается ли услуга длительностью duration минут в слот startTime
// без пересечения с занятыми интервалами в этот день
function isSlotAvailableForDuration(dateKey, startTime, duration) {
  const busy = BUSY_INTERVALS[dateKey] || [];
  if (busy.length === 0) return true;

  const slotStart = timeToMinutes(startTime);
  const slotEnd = slotStart + duration;

  // Проверяем: интервал [slotStart, slotEnd) не пересекается ни с одним занятым
  return !busy.some(b => slotStart < b.end && slotEnd > b.start);
}

function showConsentPopup() {
  const masterName = MASTER?.name || 'Индивидуальный предприниматель';
  const overlay = document.createElement('div');
  overlay.className = 'consent-overlay';
  overlay.innerHTML = `
    <div class="consent-popup">
      <div class="consent-popup-title">Политика обработки персональных данных</div>
      <div class="consent-popup-body">
        <p>Нажимая кнопку «Записаться», вы даёте согласие <b>${masterName}</b> на обработку ваших персональных данных в соответствии с Федеральным законом №152-ФЗ «О персональных данных».</p>
        <p><b>Какие данные обрабатываются:</b></p>
        <ul>
          <li>Имя и фамилия (из профиля Telegram)</li>
          <li>Номер телефона (если указан)</li>
          <li>Имя пользователя Telegram</li>
          <li>Данные о записях (дата, время, услуга)</li>
        </ul>
        <p><b>Цели обработки:</b></p>
        <ul>
          <li>Запись на услуги и управление расписанием</li>
          <li>Связь с вами для подтверждения или изменения записи</li>
          <li>Отправка напоминаний о предстоящих записях</li>
          <li>Начисление и списание бонусов</li>
        </ul>
        <p><b>Хранение данных:</b> ваши данные хранятся на серверах, расположенных на территории Российской Федерации.</p>
        <p><b>Срок хранения:</b> данные хранятся до момента отзыва согласия. Для отзыва согласия напишите мастеру в чат бота.</p>
        <p>Согласие может быть отозвано в любой момент путём направления соответствующего запроса.</p>
      </div>
      <button class="consent-popup-btn" id="consentPopupClose">Понятно</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#consentPopupClose').addEventListener('click', () => {
    overlay.remove();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

function renderBooking() {
  const service = state.selectedService;
  if (!service) return '';

  const displayPrice = service.salePrice || service.price;

  // Генерируем чипы дат
  const dates = Object.keys(SCHEDULE).sort();
  const datesHTML = dates.map(dateKey => {
    const date = parseDate(dateKey);
    const isSelected = state.selectedDate === dateKey;
    return `
      <div class="date-chip ${isSelected ? 'selected' : ''}" data-date="${dateKey}">
        <div class="date-chip-day">${getDayName(date)}</div>
        <div class="date-chip-num">${date.getDate()}</div>
        <div class="date-chip-month">${getMonthShort(date)}</div>
      </div>
    `;
  }).join('');

  // Слоты времени для выбранной даты
  let timeSlotsHTML = '<div class="no-slots">Выберите дату</div>';
  if (state.selectedDate && SCHEDULE[state.selectedDate]) {
    const slots = SCHEDULE[state.selectedDate];
    if (slots.length === 0) {
      timeSlotsHTML = '<div class="no-slots">Нет свободных слотов</div>';
    } else {
      const serviceDuration = service.duration || 30;
      timeSlotsHTML = '<div class="time-slots">' + slots.map(time => {
        const isBooked = BOOKED_SLOTS.includes(`${state.selectedDate}_${time}`);
        const isFits = isSlotAvailableForDuration(state.selectedDate, time, serviceDuration);
        const isSelected = state.selectedTime === time;
        const cls = (isBooked || !isFits) ? 'booked' : (isSelected ? 'selected' : '');
        return `<div class="time-slot ${cls}" data-time="${time}">${time}</div>`;
      }).join('') + '</div>';
    }
  }

  return `
    <div class="booking-summary">
      <div class="booking-summary-name">${service.name}</div>
      <div class="booking-summary-meta">${formatDuration(service.duration)} · ${formatPrice(displayPrice)}</div>
    </div>

    <div class="booking-section-title">Выберите дату</div>
    <div class="date-picker" id="datePicker">
      ${datesHTML}
    </div>

    <div class="booking-section-title">Выберите время</div>
    <div id="timeContainer">
      ${timeSlotsHTML}
    </div>

    ${getCurrentUser()?.source === 'web' ? `
    <div class="booking-section-title">Ваш телефон</div>
    <div class="booking-phone-display">${getCurrentUser().phone}</div>
    ` : `
    <div class="booking-section-title">Ваш телефон</div>
    <input type="tel" id="bookingPhone" class="booking-phone-input" placeholder="+7 (___) ___-__-__" value="${state.clientPhone || ''}" />
    `}

    ${CLIENT_BONUS > 0 ? `
      <div class="bonus-block">
        <div class="bonus-balance">💎 Ваши бонусы: <b>${CLIENT_BONUS} ₽</b></div>
        <label class="bonus-checkbox-label">
          <input type="checkbox" id="useBonusCheckbox" />
          <span>Списать бонусы</span>
        </label>
        <div class="bonus-input-row" id="bonusInputRow" style="display:none">
          <input type="number" id="bonusAmount" class="bonus-input" min="1" max="${Math.min(CLIENT_BONUS, displayPrice)}" placeholder="Сумма" />
          <span class="bonus-max">макс. ${Math.min(CLIENT_BONUS, displayPrice)} ₽</span>
        </div>
      </div>
    ` : ''}

    <div class="consent-block">
      <label class="consent-label">
        <input type="checkbox" id="consentCheckbox" />
        <span>Я соглашаюсь на <a href="#" id="consentLink">обработку персональных данных</a></span>
      </label>
    </div>

    <button class="booking-confirm-btn disabled" id="bookingConfirmBtn" disabled>Выберите дату и время</button>
  `;
}

// Обновить слоты времени (без перерендера всего экрана)
function updateTimeSlots() {
  const container = document.getElementById('timeContainer');
  if (!container) return;

  if (!state.selectedDate || !SCHEDULE[state.selectedDate]) {
    container.innerHTML = '<div class="no-slots">Выберите дату</div>';
    return;
  }

  const slots = SCHEDULE[state.selectedDate];
  if (slots.length === 0) {
    container.innerHTML = '<div class="no-slots">Нет свободных слотов</div>';
    return;
  }

  const serviceDuration = state.selectedService ? (state.selectedService.duration || 30) : 30;
  container.innerHTML = '<div class="time-slots">' + slots.map(time => {
    const isBooked = BOOKED_SLOTS.includes(`${state.selectedDate}_${time}`);
    const isFits = isSlotAvailableForDuration(state.selectedDate, time, serviceDuration);
    const isSelected = state.selectedTime === time;
    const cls = (isBooked || !isFits) ? 'booked' : (isSelected ? 'selected' : '');
    return `<div class="time-slot ${cls}" data-time="${time}">${time}</div>`;
  }).join('') + '</div>';

  // Привязываем обработчики на новые слоты
  container.querySelectorAll('.time-slot:not(.booked)').forEach(slot => {
    slot.addEventListener('click', () => {
      state.selectedTime = slot.dataset.time;
      haptic('selection');

      // Обновляем визуал
      container.querySelectorAll('.time-slot').forEach(s => s.classList.remove('selected'));
      slot.classList.add('selected');

      // Активируем кнопку «Записаться» только если есть согласие
      const confirmBtn = document.querySelector('#bookingConfirmBtn');
      const consent = document.querySelector('#consentCheckbox');
      if (confirmBtn) {
        if (consent && consent.checked) {
          confirmBtn.disabled = false;
          confirmBtn.classList.remove('disabled');
          confirmBtn.textContent = 'Записаться';
        } else {
          confirmBtn.disabled = true;
          confirmBtn.classList.add('disabled');
          confirmBtn.textContent = 'Дайте согласие';
        }
      }

      // Активируем MainButton
      updateTelegramButtons('booking');
    });
  });
}

// ============================================================
// ЭКРАН 5: УСПЕХ
// ============================================================

function renderSuccess() {
  const service = state.selectedService;
  const dateObj = parseDate(state.selectedDate);
  const displayPrice = service.salePrice || service.price;

  haptic('notification', 'success');

  return `
    <div class="success-screen">
      <div class="success-icon">
        <svg class="success-checkmark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </div>

      <div class="success-title">Вы записаны!</div>

      <div class="success-card">
        <div class="success-card-title">${service.name}</div>
        <div class="success-card-row">
          <span class="success-card-icon">📅</span>
          <span>${formatDateFull(dateObj)}</span>
        </div>
        <div class="success-card-row">
          <span class="success-card-icon">🕐</span>
          <span>${state.selectedTime}</span>
        </div>
        <div class="success-card-row">
          <span class="success-card-icon">⏱️</span>
          <span>${formatDuration(service.duration)}</span>
        </div>
        <div class="success-card-row">
          <span class="success-card-icon">💰</span>
          <span>${formatPrice(displayPrice)}</span>
        </div>
      </div>

      <div class="success-hint">Напоминание придёт за 24 часа в этот чат</div>
      <div class="success-hint">Нужно перенести? Напишите в чат бота.</div>

      ${''/* debug removed */}

      ${!tg ? '<button class="booking-confirm-btn" id="successHomeBtn">На главную</button>' : ''}
    </div>
  `;
}

// ============================================================
// ОТПРАВКА ЗАПИСИ
// ============================================================

let _bookingInProgress = false;
async function submitBooking() {
  // Защита от двойного нажатия
  if (_bookingInProgress) return;
  _bookingInProgress = true;

  try {
  const service = state.selectedService;
  const user = getCurrentUser();

  // Считываем телефон из инпута (для Telegram-юзеров — ручной ввод)
  const phoneInput = document.getElementById('bookingPhone');
  const phone = user?.source === 'web' ? user.phone : (phoneInput ? phoneInput.value.trim() : '');
  state.clientPhone = phone;

  // Считываем бонусы
  const useBonusCheckbox = document.getElementById('useBonusCheckbox');
  const bonusAmountInput = document.getElementById('bonusAmount');
  let bonusToUse = 0;
  if (useBonusCheckbox && useBonusCheckbox.checked && bonusAmountInput) {
    bonusToUse = Math.min(parseFloat(bonusAmountInput.value) || 0, CLIENT_BONUS);
  }

  const originalPrice = service.salePrice || service.price;
  const finalPrice = Math.max(0, originalPrice - bonusToUse);

  // Помечаем слот как занятый (сразу, чтобы UI обновился)
  BOOKED_SLOTS.push(`${state.selectedDate}_${state.selectedTime}`);
  if (CURRENT_MASTER_ID) {
    try {
      const bookingData = {
        master_id: CURRENT_MASTER_ID,
        service_id: service.id,
        client_tg_id: user?.source === 'telegram' ? user.id : 0,
        client_name: user?.name || '',
        client_username: user?.username || '',
        client_phone: phone || '',
        date: state.selectedDate,
        time: state.selectedTime,
        price: finalPrice,
        duration: service.duration,
      };
      const result = await createBooking(bookingData);

      if (result) {
        console.log('✅ Запись сохранена:', result);
        // Создаём/обновляем клиента
        if (user) {
          const clientData = user.source === 'telegram'
            ? { id: user.id, first_name: user.name, username: user.username }
            : { id: user.id, first_name: user.name, username: '' };
          upsertClient(CURRENT_MASTER_ID, clientData, phone);
        }
        // Списываем бонусы
        const tgIdForBonus = user?.source === 'telegram' ? user.id : 0;
        if (bonusToUse > 0 && user) {
          await debitBonus(CURRENT_MASTER_ID, tgIdForBonus, bonusToUse, user.phone);
          CLIENT_BONUS = Math.max(0, CLIENT_BONUS - bonusToUse);
          console.log(`💎 Списано бонусов: ${bonusToUse} ₽`);
        }
      } else {
        console.warn('⚠️ Не удалось сохранить в Supabase');
        state.bookingError = window.__lastApiError || 'Неизвестная ошибка сохранения';
      }
    } catch (err) {
      console.warn('⚠️ Ошибка сохранения в Supabase:', err);
      state.bookingError = `Исключение: ${err.message}`;
    }
  } else {
    state.bookingError = `CURRENT_MASTER_ID не задан (=${CURRENT_MASTER_ID})`;
  }

  // Сохраняем в localStorage (fallback + для офлайн-истории)
  const history = JSON.parse(localStorage.getItem('bookingHistory') || '[]');
  history.unshift({
    serviceName: service.name,
    date: state.selectedDate,
    time: state.selectedTime,
    price: service.salePrice || service.price,
    confirmed: false,
  });
  localStorage.setItem('bookingHistory', JSON.stringify(history));

  // Переходим на экран успеха
  navigateTo('success');
  } finally {
    _bookingInProgress = false;
  }
}

// ============================================================
// АДМИН-ХЕЛПЕРЫ
// ============================================================

// Загрузка данных для вкладки панели мастера
async function loadMasterTabData(tab) {
  if (!CURRENT_MASTER_ID) return;
  try {
    if (tab === 'bookings') {
      state.masterBookings = await loadMasterBookings(CURRENT_MASTER_ID) || [];
    } else if (tab === 'services') {
      state.masterServices = await loadAllServices(CURRENT_MASTER_ID) || [];
    } else if (tab === 'categories') {
      state.masterCategories = await loadAllCategories(CURRENT_MASTER_ID) || [];
    } else if (tab === 'clients') {
      state.masterClients = await loadMasterClients(CURRENT_MASTER_ID) || [];
    } else if (tab === 'abonements') {
      state.masterAbonements = await loadAbonements(CURRENT_MASTER_ID) || [];
    } else if (tab === 'schedule') {
      state.masterSchedule = await loadAllSchedule(CURRENT_MASTER_ID) || [];
    }
  } catch (err) {
    console.error('Ошибка загрузки данных панели:', err);
  }
}

// Перезагрузить глобальный CATEGORIES (для клиентского каталога)
async function reloadGlobalCategories() {
  if (!CURRENT_MASTER_ID) return;
  const categories = await loadCategories(CURRENT_MASTER_ID);
  if (categories) {
    CATEGORIES = categories.map(c => ({
      id: c.id,
      name: c.name,
      icon: c.icon,
      sort: c.sort_order,
    }));
  }
}

// Перезагрузить глобальный SERVICES (для клиентского каталога)
async function reloadGlobalServices() {
  if (!CURRENT_MASTER_ID) return;
  const services = await loadServices(CURRENT_MASTER_ID);
  if (services) {
    SERVICES = services.map(s => ({
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
    }));
  }
}

// Обновить содержимое админ-панели без полной перерисовки
function refreshAdminContent(container) {
  const content = container.querySelector('#adminContent');
  if (!content) return;
  switch (state.masterTab) {
    case 'bookings': content.innerHTML = renderMasterBookings(); break;
    case 'services': content.innerHTML = renderMasterServicesList(); break;
    case 'categories': content.innerHTML = renderMasterCategoriesList(); break;
    case 'clients':  content.innerHTML = renderMasterClientsList(); break;
    case 'abonements': content.innerHTML = renderMasterAbonements(); break;
    case 'schedule': content.innerHTML = renderMasterSchedule(); break;
    case 'broadcast': content.innerHTML = renderBroadcastForm(); break;
    case 'profile': content.innerHTML = renderMasterProfile(); break;
  }
  // Перепривязываем обработчики
  bindEvents('masterPanel', container);
}

// Привязка кнопок удаления фото
function bindPhotoDeleteButtons(container) {
  container.querySelectorAll('.admin-photo-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const idx = parseInt(btn.dataset.index);
      if (state.editingService?.photos) {
        const url = state.editingService.photos[idx];
        state.editingService.photos.splice(idx, 1);
        const photosContainer = container.querySelector('#svcPhotos');
        if (photosContainer) {
          photosContainer.innerHTML = state.editingService.photos.map((u, i) => `
            <div class="admin-photo-item" data-index="${i}">
              <img src="${u}">
              <button class="admin-photo-delete" data-index="${i}">×</button>
            </div>
          `).join('');
          bindPhotoDeleteButtons(container);
        }
        // Удаляем файл с сервера если это наш VPS
        if (url && url.includes('api.beautyplatform.ru/uploads/')) {
          const auth = typeof getStoredAuth === 'function' ? getStoredAuth() : null;
          if (auth) {
            fetch(`${API_BASE_URL}/api/v1/delete-file`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${auth.access_token}` },
              body: JSON.stringify({ url }),
            }).catch(() => {});
          }
        }
      }
    });
  });
}

// ============================================================
// ПРИВЯЗКА СОБЫТИЙ
// ============================================================

function bindEvents(screenName, container) {
  switch (screenName) {
    case 'home':
      // Тап по категории
      container.querySelectorAll('.category-card').forEach(card => {
        card.addEventListener('click', () => {
          state.selectedCategory = card.dataset.category;
          navigateTo('catalog');
        });
      });
      // Тап по баннеру акции → показать акционные услуги
      const promoBanner = container.querySelector('.promo-banner');
      if (promoBanner) {
        promoBanner.addEventListener('click', () => {
          state.selectedCategory = '__sale';
          navigateTo('catalog');
        });
      }

      // Кнопка «Выбрать дату» — раскрытие календаря
      const homeBookingBtn = container.querySelector('#homeBookingBtn');
      const homeCalendar = container.querySelector('#homeCalendar');
      if (homeBookingBtn && homeCalendar) {
        homeBookingBtn.addEventListener('click', () => {
          homeCalendar.classList.toggle('hidden');
          homeBookingBtn.classList.toggle('active');
          haptic('impact', 'light');
          // Прокрутка к календарю
          if (!homeCalendar.classList.contains('hidden')) {
            setTimeout(() => homeCalendar.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
          }
        });

        // Тап по дате
        container.querySelectorAll('#homeDatePicker .date-chip').forEach(chip => {
          chip.addEventListener('click', () => {
            state.selectedDate = chip.dataset.date;
            state.selectedTime = null;
            haptic('selection');

            container.querySelectorAll('#homeDatePicker .date-chip').forEach(c => c.classList.remove('selected'));
            chip.classList.add('selected');

            updateHomeTimeSlots(container);
          });
        });
      }

      // Кнопка «История посещений»
      const historyBtn = container.querySelector('#homeHistoryBtn');
      if (historyBtn) {
        historyBtn.addEventListener('click', () => {
          navigateTo('history');
        });
      }

      // Кнопка «Бонусы»
      const bonusBtn = container.querySelector('#homeBonusBtn');
      if (bonusBtn) {
        bonusBtn.addEventListener('click', () => {
          navigateTo('bonus');
        });
      }

      // Кнопка «Абонементы»
      const abonementBtn = container.querySelector('#homeAbonementBtn');
      if (abonementBtn) {
        abonementBtn.addEventListener('click', async () => {
          if (CURRENT_MASTER_ID) {
            state.abonements = await loadAbonements(CURRENT_MASTER_ID) || [];
          }
          navigateTo('abonement');
        });
      }

      // Кнопка «Поделиться с другом»
      const shareBtn = container.querySelector('#homeShareBtn');
      if (shareBtn) {
        shareBtn.addEventListener('click', () => {
          const shareText = 'Привет! Посмотри Лазер Тайм — лазерная эпиляция и косметология. Записаться можно прямо в Telegram:';
          const shareUrl = 'https://t.me/lasertime_prilo_bot';
          if (tg) {
            tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(shareText)}`);
          } else {
            window.open(`https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(shareText)}`, '_blank');
          }
          haptic('impact', 'light');
        });
      }

      // Кнопка «Включить уведомления»
      const enablePushBtn = container.querySelector('#enablePushBtn');
      if (enablePushBtn) {
        enablePushBtn.addEventListener('click', async () => {
          enablePushBtn.disabled = true;
          enablePushBtn.textContent = 'Подключаем...';
          await requestPushPermission();
          // Убираем кнопку после нажатия
          enablePushBtn.remove();
        });
      }

      // Вкладка «Мастер»
      const roleMasterBtn = container.querySelector('#roleMaster');
      if (roleMasterBtn) {
        roleMasterBtn.addEventListener('click', async () => {
          if (state.masterUnlocked) {
            await loadMasterTabData(state.masterTab || 'bookings');
            navigateTo('masterPanel');
          } else {
            navigateTo('masterLogin');
          }
        });
      }
      break;

    case 'masterLogin':
      // Кнопка «Войти»
      const loginBtn = container.querySelector('#masterLoginBtn');
      const codeInput = container.querySelector('#masterCodeInput');
      const loginError = container.querySelector('#masterLoginError');

      if (loginBtn && codeInput) {
        const tryLogin = async () => {
          if (codeInput.value === MASTER_CODE) {
            // Получаем JWT для мастера → фото, уведомления и push заработают
            try {
              const res = await fetch(`${API_BASE_URL}/api/v1/auth/master-code-login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ master_id: CURRENT_MASTER_ID, code: codeInput.value }),
              });
              if (res.ok) {
                const data = await res.json();
                if (data.ok && typeof saveAuth === 'function') saveAuth(data);
              }
            } catch(e) { console.warn('master-code-login error:', e.message); }

            state.masterUnlocked = true;
            state.masterTab = 'bookings';
            haptic('notification', 'success');
            // Запускаем колокольчик и push после получения JWT
            createNotificationBell();
            requestPushPermission();
            await loadMasterTabData('bookings');
            navigateTo('masterPanel');
          } else {
            loginError.classList.remove('hidden');
            codeInput.value = '';
            codeInput.focus();
            haptic('notification', 'error');
          }
        };
        loginBtn.addEventListener('click', tryLogin);
        codeInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') tryLogin();
        });
        // Автофокус на поле ввода
        setTimeout(() => codeInput.focus(), 300);
      }

      // Вкладка «Клиент» из экрана входа
      const backFromLogin = container.querySelector('#roleClientFromLogin');
      if (backFromLogin) {
        backFromLogin.addEventListener('click', () => {
          navigateTo('home');
        });
      }
      break;

    case 'register':
      const slugInput = container.querySelector('#regSlug');
      const slugPreview = container.querySelector('#slugPreview');
      const nameInput = container.querySelector('#regName');

      // Функция генерации slug из имени
      function nameToSlug(name) {
        const map = {'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',' ':'-'};
        return name.toLowerCase().split('').map(c => map[c] !== undefined ? map[c] : /[a-z0-9-]/.test(c) ? c : '').join('').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
      }

      // При вводе имени — автогенерация slug (только если пользователь ещё не менял вручную)
      let slugManuallyEdited = false;
      if (nameInput && slugInput && slugPreview) {
        nameInput.addEventListener('input', () => {
          if (!slugManuallyEdited) {
            const generated = nameToSlug(nameInput.value);
            slugInput.value = generated;
            slugPreview.textContent = generated || '...';
          }
        });
        slugInput.addEventListener('input', () => {
          slugManuallyEdited = true;
          const val = slugInput.value.replace(/[^a-z0-9-]/gi, '').toLowerCase();
          slugInput.value = val;
          slugPreview.textContent = val || '...';
        });
      }
      // Submit
      const regSubmitBtn = container.querySelector('#regSubmitBtn');
      if (regSubmitBtn) {
        regSubmitBtn.addEventListener('click', async () => {
          const name = container.querySelector('#regName')?.value.trim();
          const slug = container.querySelector('#regSlug')?.value.trim();
          const description = container.querySelector('#regDescription')?.value.trim();
          const resultDiv = container.querySelector('#regResult');

          if (!name || !slug) {
            if (resultDiv) resultDiv.innerHTML = '<span style="color:red">Заполните название и URL-адрес</span>';
            return;
          }
          if (slug.length < 3) {
            if (resultDiv) resultDiv.innerHTML = '<span style="color:red">URL-адрес минимум 3 символа</span>';
            return;
          }

          regSubmitBtn.disabled = true;
          regSubmitBtn.textContent = 'Регистрация...';

          try {
            const auth = typeof getStoredAuth === 'function' ? getStoredAuth() : null;
            const res = await fetch(`${API_BASE_URL}/api/v1/auth/register-master`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': auth ? `Bearer ${auth.access_token}` : '',
              },
              body: JSON.stringify({ name, slug, description, phone: container.querySelector('#regPhone')?.value.trim() }),
            });
            const data = await res.json();
            if (res.ok) {
              const masterUrl = `https://app.beautyplatform.ru/?master=${slug}`;
              if (resultDiv) resultDiv.innerHTML = `<span style="color:green">
  ✅ Мастер зарегистрирован!<br><br>
  🔗 Ссылка:<br>
  <a href="${masterUrl}" target="_blank" style="display:inline-block;margin:8px 0;padding:12px 18px;background:#2196F3;color:#fff;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px;word-break:break-all">${masterUrl}</a><br><br>
  🔐 Код доступа в кабинет мастера: <b style="font-size:20px">${data.master_code}</b><br><br>
  <small>Нажмите на ссылку выше → вкладка "Мастер" → введите код</small>
</span>`;
              regSubmitBtn.textContent = 'Зарегистрирован';
            } else {
              if (resultDiv) resultDiv.innerHTML = `<span style="color:red">${data.error || 'Ошибка регистрации'}</span>`;
              regSubmitBtn.disabled = false;
              regSubmitBtn.textContent = 'Зарегистрироваться';
            }
          } catch (err) {
            if (resultDiv) resultDiv.innerHTML = `<span style="color:red">Ошибка сети: ${err.message}</span>`;
            regSubmitBtn.disabled = false;
            regSubmitBtn.textContent = 'Зарегистрироваться';
          }
        });
      }
      break;

    case 'superadmin':
      // Логин
      const adminLoginBtn = container.querySelector('#adminLoginBtn');
      if (adminLoginBtn) {
        const doLogin = async () => {
          const pwd = container.querySelector('#adminPasswordInput')?.value;
          const errDiv = container.querySelector('#adminLoginError');
          if (!pwd) return;
          // Проверяем пароль через API
          try {
            const res = await fetch(`${API_BASE_URL}/api/v1/auth/admin-login`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password: pwd }),
            });
            if (res.ok) {
              sessionStorage.setItem(SUPERADMIN_KEY, '1');
              state.adminMasters = await loadAllMasters();
              state.currentScreen = '_refresh';
              navigateTo('superadmin', false);
            } else {
              if (errDiv) errDiv.textContent = 'Неверный пароль';
            }
          } catch (e) {
            if (errDiv) errDiv.textContent = 'Ошибка сети';
          }
        };
        adminLoginBtn.addEventListener('click', doLogin);
        container.querySelector('#adminPasswordInput')?.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') doLogin();
        });
      }

      // Обновить список
      container.querySelector('#sadminRefresh')?.addEventListener('click', async () => {
        state.adminMasters = await loadAllMasters();
        state.currentScreen = '_refresh';
        navigateTo('superadmin', false);
      });

      // Выход
      container.querySelector('#sadminLogout')?.addEventListener('click', () => {
        sessionStorage.removeItem(SUPERADMIN_KEY);
        state.currentScreen = '_refresh';
        navigateTo('superadmin', false);
      });

      // Пауза / Включить
      container.querySelectorAll('.sadmin-btn.pause, .sadmin-btn.resume').forEach(btn => {
        btn.addEventListener('click', async () => {
          const masterId = btn.dataset.masterId;
          const isActive = btn.dataset.active === 'true';
          btn.disabled = true;
          btn.textContent = '...';
          await toggleMasterActive(masterId, !isActive);
          state.adminMasters = await loadAllMasters();
          state.currentScreen = '_refresh';
          navigateTo('superadmin', false);
        });
      });

      // Удалить
      container.querySelectorAll('.sadmin-btn.delete').forEach(btn => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.masterName;
          if (!confirm(`Удалить мастера "${name}"?\n\nВсе услуги, категории и записи тоже будут удалены.`)) return;
          btn.disabled = true;
          btn.textContent = '...';
          await deleteMasterAdmin(btn.dataset.masterId);
          state.adminMasters = await loadAllMasters();
          state.currentScreen = '_refresh';
          navigateTo('superadmin', false);
        });
      });

      // Добавить мастера — переход на регистрацию
      container.querySelector('#sadminAddBtn')?.addEventListener('click', () => {
        window.open('/?page=register', '_blank');
      });

      break;

    case 'masterPanel':
      // Вкладка «Клиент»
      const roleClientBtn = container.querySelector('#roleClientFromMaster');
      if (roleClientBtn) {
        roleClientBtn.addEventListener('click', () => {
          state.masterUnlocked = false;
          navigateTo('home');
        });
      }

      // Вкладки админки
      container.querySelectorAll('.admin-tab').forEach(tab => {
        tab.addEventListener('click', async () => {
          state.masterTab = tab.dataset.tab;
          haptic('selection');
          await loadMasterTabData(state.masterTab);
          state.currentScreen = '_refresh';
          navigateTo('masterPanel', false);
        });
      });

      // Кнопка «Назад к услугам»
      const backToServices = container.querySelector('#backToServices');
      if (backToServices) {
        backToServices.addEventListener('click', () => {
          state.masterTab = 'services';
          state.editingService = null;
          state.currentScreen = '_refresh';
          navigateTo('masterPanel', false);
        });
      }

      // Кнопка «Назад к категориям»
      const backToCategories = container.querySelector('#backToCategories');
      if (backToCategories) {
        backToCategories.addEventListener('click', () => {
          state.masterTab = 'categories';
          state.editingCategory = null;
          state.currentScreen = '_refresh';
          navigateTo('masterPanel', false);
        });
      }

      // --- Абонементы: назад ---
      const backToAbonements = container.querySelector('#backToAbonements');
      if (backToAbonements) {
        backToAbonements.addEventListener('click', () => {
          state.masterTab = 'abonements';
          state.editingAbonement = null;
          state.currentScreen = '_refresh';
          navigateTo('masterPanel', false);
        });
      }

      // --- Абонементы: добавить ---
      const addAbonementBtn = container.querySelector('#addAbonementBtn');
      if (addAbonementBtn) {
        addAbonementBtn.addEventListener('click', () => {
          state.editingAbonement = null;
          state.masterTab = 'abonementForm';
          state.currentScreen = '_refresh';
          navigateTo('masterPanel', false);
        });
      }

      // --- Абонементы: редактировать ---
      container.querySelectorAll('.admin-icon-btn.edit-abon').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const abon = (state.masterAbonements || []).find(a => a.id === btn.dataset.abonId);
          state.editingAbonement = { ...abon };
          state.masterTab = 'abonementForm';
          state.currentScreen = '_refresh';
          navigateTo('masterPanel', false);
        });
      });

      // --- Абонементы: удалить ---
      container.querySelectorAll('.admin-icon-btn.delete-abon').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm('Удалить абонемент?')) return;
          await deleteAbonement(btn.dataset.abonId);
          haptic('notification', 'success');
          await loadMasterTabData('abonements');
          refreshAdminContent(container);
        });
      });

      // --- Абонементы: сохранить ---
      const saveAbonementBtn = container.querySelector('#saveAbonementBtn');
      if (saveAbonementBtn) {
        saveAbonementBtn.addEventListener('click', async () => {
          const complexName = container.querySelector('#abonComplexName')?.value.trim();
          const basePrice = parseInt(container.querySelector('#abonBasePrice')?.value) || 0;
          const sessions = parseInt(container.querySelector('#abonSessions')?.value) || 0;
          const discount = parseInt(container.querySelector('#abonDiscount')?.value) || 0;
          const sortOrder = parseInt(container.querySelector('#abonSort')?.value) || 0;

          if (!complexName || !basePrice || !sessions) {
            alert('Заполните название, цену и кол-во процедур');
            return;
          }

          const data = {
            master_id: CURRENT_MASTER_ID,
            complex_name: complexName,
            base_price: basePrice,
            sessions,
            discount,
            sort_order: sortOrder,
            is_active: true,
          };

          saveAbonementBtn.disabled = true;
          saveAbonementBtn.textContent = 'Сохраняем...';

          if (state.editingAbonement?.id) {
            await updateAbonement(state.editingAbonement.id, data);
          } else {
            await addAbonement(data);
          }

          haptic('notification', 'success');
          state.editingAbonement = null;
          state.masterTab = 'abonements';
          await loadMasterTabData('abonements');
          state.currentScreen = '_refresh';
          navigateTo('masterPanel', false);
        });
      }

      // --- Рассылка ---
      // "Выбрать всех" чекбокс
      const selectAllBox = container.querySelector('#selectAllClients');
      if (selectAllBox) {
        selectAllBox.addEventListener('change', () => {
          container.querySelectorAll('.broadcast-client-check').forEach(cb => { cb.checked = selectAllBox.checked; });
        });
      }

      const sendBroadcastBtn = container.querySelector('#sendBroadcastBtn');
      if (sendBroadcastBtn) {
        sendBroadcastBtn.addEventListener('click', async () => {
          const textarea = container.querySelector('#broadcastText');
          const resultDiv = container.querySelector('#broadcastResult');
          const message = textarea ? textarea.value.trim() : '';

          if (!message) {
            if (resultDiv) resultDiv.innerHTML = '<span style="color:red">Введите текст сообщения</span>';
            return;
          }

          const selected = container.querySelectorAll('.broadcast-client-check:checked');
          if (selected.length === 0) {
            if (resultDiv) resultDiv.innerHTML = '<span style="color:red">Выберите хотя бы одного клиента</span>';
            return;
          }

          sendBroadcastBtn.disabled = true;
          sendBroadcastBtn.textContent = 'Отправка...';

          let sentCount = 0;
          try {
            // Сохраняем уведомления для клиентов с телефоном
            for (const cb of selected) {
              const phone = cb.dataset.phone;
              if (phone && typeof createNotification === 'function') {
                await createNotification(phone.replace(/\D/g, ''), CURRENT_MASTER_ID, 'broadcast', MASTER.name || 'Рассылка', message);
                sentCount++;
              }
            }

            // Также отправляем через Telegram-бот (для TG-клиентов)
            try {
              await fetch(`${API_BASE_URL}/api/broadcast`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  master_id: CURRENT_MASTER_ID,
                  master_code: MASTER_CODE,
                  message: message,
                }),
              });
            } catch (e) { /* бот-рассылка опциональна */ }

            if (resultDiv) resultDiv.innerHTML = `<span style="color:green">Отправлено: ${sentCount} уведомлений</span>`;
            if (textarea) textarea.value = '';
            haptic('notification', 'success');
          } catch (err) {
            if (resultDiv) resultDiv.innerHTML = `<span style="color:red">Ошибка: ${err.message}</span>`;
          }

          sendBroadcastBtn.disabled = false;
          sendBroadcastBtn.textContent = 'Отправить рассылку';
        });
      }

      // --- Профиль: сохранить ---
      const saveProfileBtn = container.querySelector('#saveProfileBtn');
      if (saveProfileBtn) {
        saveProfileBtn.addEventListener('click', async () => {
          const name = container.querySelector('#profileName')?.value.trim();
          const description = container.querySelector('#profileDescription')?.value.trim();
          const phone = container.querySelector('#profilePhone')?.value.trim();
          const whatsapp_url = container.querySelector('#profileWhatsapp')?.value.trim();
          const welcome_text = container.querySelector('#profileWelcome')?.value.trim();
          const master_code = container.querySelector('#profileCode')?.value.trim();

          if (!name) {
            const res = container.querySelector('#profileResult');
            if (res) { res.textContent = '❌ Название не может быть пустым'; res.style.color = '#c00'; }
            return;
          }

          saveProfileBtn.disabled = true;
          saveProfileBtn.textContent = 'Сохранение...';

          try {
            const data = { name, description, phone, whatsapp_url, welcome_text };
            if (master_code && master_code.length === 4) {
              data.master_code = master_code;
            }

            const result = await updateMaster(CURRENT_MASTER_ID, data);
            const res = container.querySelector('#profileResult');

            if (result) {
              // Обновляем глобальный объект MASTER
              MASTER.name = name;
              MASTER.description = description;
              MASTER.phone = phone;
              MASTER.whatsapp_url = whatsapp_url;
              MASTER.welcome_text = welcome_text;
              if (master_code && master_code.length === 4) {
                MASTER.master_code = master_code;
                MASTER_CODE = master_code;
              }
              if (res) { res.textContent = '✅ Профиль сохранён'; res.style.color = '#2a2'; }
              haptic('notification', 'success');
            } else {
              if (res) { res.textContent = '❌ Ошибка сохранения'; res.style.color = '#c00'; }
            }
          } catch (err) {
            const res = container.querySelector('#profileResult');
            if (res) { res.textContent = '❌ ' + err.message; res.style.color = '#c00'; }
          }

          saveProfileBtn.disabled = false;
          saveProfileBtn.textContent = 'Сохранить профиль';
        });
      }

      // --- График: сохранить ---
      const saveScheduleBtn = container.querySelector('#saveScheduleBtn');
      if (saveScheduleBtn) {
        // Галочки дней — переключение активности
        container.querySelectorAll('.schedule-day-check').forEach(chk => {
          chk.addEventListener('change', async () => {
            const dayNum = parseInt(chk.dataset.day);
            const existing = (state.masterSchedule || []).find(s => s.day_of_week === dayNum);
            if (existing) {
              await updateScheduleDay(existing.id, { is_active: chk.checked });
            } else if (chk.checked) {
              await saveScheduleDay({
                master_id: CURRENT_MASTER_ID,
                day_of_week: dayNum,
                start_time: '09:00',
                end_time: '20:00',
                slot_interval: 30,
                is_active: true
              });
            }
            state.masterSchedule = await loadAllSchedule(CURRENT_MASTER_ID) || [];
            refreshAdminContent(container);
          });
        });

        saveScheduleBtn.addEventListener('click', async () => {
          saveScheduleBtn.disabled = true;
          saveScheduleBtn.textContent = 'Сохранение...';
          const resultEl = container.querySelector('#scheduleResult');

          try {
            const dayOrder = [1, 2, 3, 4, 5, 6, 0];
            for (const dayNum of dayOrder) {
              const chk = container.querySelector(`.schedule-day-check[data-day="${dayNum}"]`);
              if (!chk) continue;

              const isActive = chk.checked;
              const startInput = container.querySelector(`.schedule-start[data-day="${dayNum}"]`);
              const endInput = container.querySelector(`.schedule-end[data-day="${dayNum}"]`);
              const intervalSelect = container.querySelector(`.schedule-interval[data-day="${dayNum}"]`);

              const startTime = startInput ? startInput.value : '09:00';
              const endTime = endInput ? endInput.value : '20:00';
              const interval = intervalSelect ? parseInt(intervalSelect.value) : 30;

              const existing = (state.masterSchedule || []).find(s => s.day_of_week === dayNum);

              if (existing) {
                await updateScheduleDay(existing.id, {
                  start_time: startTime,
                  end_time: endTime,
                  slot_interval: interval,
                  is_active: isActive
                });
              } else if (isActive) {
                await saveScheduleDay({
                  master_id: CURRENT_MASTER_ID,
                  day_of_week: dayNum,
                  start_time: startTime,
                  end_time: endTime,
                  slot_interval: interval,
                  is_active: true
                });
              }
            }

            state.masterSchedule = await loadAllSchedule(CURRENT_MASTER_ID) || [];
            if (resultEl) {
              resultEl.textContent = 'График сохранён!';
              resultEl.style.color = '#4CAF50';
            }
            haptic('notification', 'success');
          } catch (err) {
            if (resultEl) {
              resultEl.textContent = 'Ошибка: ' + err.message;
              resultEl.style.color = '#f44336';
            }
          }

          saveScheduleBtn.disabled = false;
          saveScheduleBtn.textContent = 'Сохранить график';
        });
      }

      // --- Записи: подтвердить / отменить ---
      container.querySelectorAll('.admin-btn.confirm').forEach(btn => {
        btn.addEventListener('click', async () => {
          await updateBookingStatus(btn.dataset.bookingId, 'confirmed');
          haptic('notification', 'success');
          await loadMasterTabData('bookings');
          refreshAdminContent(container);
        });
      });
      container.querySelectorAll('.admin-btn.cancel').forEach(btn => {
        btn.addEventListener('click', async () => {
          await updateBookingStatus(btn.dataset.bookingId, 'cancelled');
          haptic('notification', 'warning');
          await loadMasterTabData('bookings');
          refreshAdminContent(container);
        });
      });

      // --- Записи: визит состоялся / не пришёл (через API бота) ---
      async function handleVisitAction(btn, action) {
        try {
          const bookingId = btn.dataset.bookingId;
          const clientTg = parseInt(btn.dataset.clientTg) || 0;
          const price = parseInt(btn.dataset.price) || 0;

          btn.disabled = true;
          btn.textContent = '⏳';

          const resp = await fetch('/api/complete-visit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              master_id: CURRENT_MASTER_ID,
              master_code: MASTER_CODE,
              booking_id: bookingId,
              client_tg_id: clientTg,
              price: price,
              action: action,
            }),
          });

          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error || 'Ошибка сервера');

          haptic('notification', action === 'completed' ? 'success' : 'warning');

          if (data.bonus > 0) {
            alert(`Визит подтверждён! Клиенту начислено ${data.bonus} ₽ бонусов (3%)`);
          } else if (action === 'completed') {
            alert('Визит подтверждён!');
          }

          await loadMasterTabData('bookings');
          refreshAdminContent(container);
        } catch (err) {
          console.error('Ошибка:', err);
          alert('Ошибка: ' + err.message);
          btn.disabled = false;
          btn.textContent = action === 'completed' ? '✅ Визит состоялся' : '❌ Не пришёл';
        }
      }

      container.querySelectorAll('.admin-btn.completed').forEach(btn => {
        btn.addEventListener('click', () => handleVisitAction(btn, 'completed'));
      });

      container.querySelectorAll('.admin-btn.no-show').forEach(btn => {
        btn.addEventListener('click', () => handleVisitAction(btn, 'no_show'));
      });

      // --- Услуги: добавить ---
      const addServiceBtn = container.querySelector('#addServiceBtn');
      if (addServiceBtn) {
        addServiceBtn.addEventListener('click', () => {
          state.editingService = null;
          state.masterTab = 'serviceForm';
          state.currentScreen = '_refresh';
          navigateTo('masterPanel', false);
        });
      }

      // --- Услуги: редактировать ---
      container.querySelectorAll('.admin-icon-btn.edit').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const svc = state.masterServices.find(s => s.id === btn.dataset.serviceId);
          state.editingService = { ...svc };
          state.masterTab = 'serviceForm';
          state.currentScreen = '_refresh';
          navigateTo('masterPanel', false);
        });
      });

      // --- Услуги: удалить ---
      container.querySelectorAll('.admin-icon-btn.delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm('Удалить услугу?')) return;
          await deleteService(btn.dataset.serviceId);
          haptic('notification', 'success');
          await loadMasterTabData('services');
          refreshAdminContent(container);
        });
      });

      // --- Форма услуги: загрузка фото ---
      const photoInput = container.querySelector('#svcPhotoInput');
      if (photoInput) {
        photoInput.addEventListener('change', async (e) => {
          const files = Array.from(e.target.files);
          if (!files.length) return;

          for (const file of files) {
            const url = await uploadServicePhoto(file, CURRENT_MASTER_ID);
            if (url) {
              if (!state.editingService) state.editingService = { photos: [] };
              if (!state.editingService.photos) state.editingService.photos = [];
              state.editingService.photos.push(url);
            }
          }
          // Обновить отображение фото
          const photosContainer = container.querySelector('#svcPhotos');
          if (photosContainer) {
            photosContainer.innerHTML = (state.editingService?.photos || []).map((url, i) => `
              <div class="admin-photo-item" data-index="${i}">
                <img src="${url}">
                <button class="admin-photo-delete" data-index="${i}">×</button>
              </div>
            `).join('');
            bindPhotoDeleteButtons(container);
          }
          photoInput.value = '';
        });
      }
      bindPhotoDeleteButtons(container);

      // --- Форма услуги: сохранить ---
      const saveBtn = container.querySelector('#saveServiceBtn');
      if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
          const name = container.querySelector('#svcName')?.value.trim();
          const categoryId = container.querySelector('#svcCategory')?.value;
          const price = parseInt(container.querySelector('#svcPrice')?.value) || 0;
          const salePrice = parseInt(container.querySelector('#svcSalePrice')?.value) || null;
          const duration = parseInt(container.querySelector('#svcDuration')?.value) || 60;
          const sortOrder = parseInt(container.querySelector('#svcSort')?.value) || 0;
          const description = container.querySelector('#svcDescription')?.value.trim();
          const photos = state.editingService?.photos || [];

          if (!name || !price) {
            alert('Заполните название и цену');
            return;
          }

          const data = {
            master_id: CURRENT_MASTER_ID,
            category_id: categoryId,
            name,
            description,
            price,
            sale_price: salePrice,
            duration,
            sort_order: sortOrder,
            photos,
            is_active: true,
          };

          saveBtn.disabled = true;
          saveBtn.textContent = 'Сохраняем...';

          if (state.editingService?.id) {
            await updateService(state.editingService.id, data);
          } else {
            await addService(data);
          }

          haptic('notification', 'success');
          state.editingService = null;
          state.masterTab = 'services';
          await loadMasterTabData('services');
          // Обновляем глобальный SERVICES для клиентского каталога
          await reloadGlobalServices();
          state.currentScreen = '_refresh';
          navigateTo('masterPanel', false);
        });
      }

      // --- Категории: добавить ---
      const addCategoryBtn = container.querySelector('#addCategoryBtn');
      if (addCategoryBtn) {
        addCategoryBtn.addEventListener('click', () => {
          state.editingCategory = null;
          state.masterTab = 'categoryForm';
          state.currentScreen = '_refresh';
          navigateTo('masterPanel', false);
        });
      }

      // --- Категории: редактировать ---
      container.querySelectorAll('.admin-icon-btn.edit-cat').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const cat = state.masterCategories.find(c => c.id === btn.dataset.catId);
          state.editingCategory = { ...cat };
          state.masterTab = 'categoryForm';
          state.currentScreen = '_refresh';
          navigateTo('masterPanel', false);
        });
      });

      // --- Категории: удалить ---
      container.querySelectorAll('.admin-icon-btn.delete-cat').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm('Удалить категорию?')) return;
          await deleteCategory(btn.dataset.catId);
          haptic('notification', 'success');
          await loadMasterTabData('categories');
          await reloadGlobalCategories();
          refreshAdminContent(container);
        });
      });

      // --- Форма категории: сохранить ---
      // Превью выбранного фото категории
      const catPhotoInput = container.querySelector('#catPhotoInput');
      const catPhotoPreview = container.querySelector('#catPhotoPreview');
      if (catPhotoInput && catPhotoPreview) {
        catPhotoInput.addEventListener('change', () => {
          const file = catPhotoInput.files[0];
          catPhotoPreview.textContent = file ? `Выбрано: ${file.name}` : '';
        });
      }

      const saveCatBtn = container.querySelector('#saveCategoryBtn');
      if (saveCatBtn) {
        saveCatBtn.addEventListener('click', async () => {
          const icon = container.querySelector('#catIcon')?.value.trim() || '✨';
          const name = container.querySelector('#catName')?.value.trim();
          const sortOrder = parseInt(container.querySelector('#catSort')?.value) || 0;

          if (!name) {
            alert('Введите название категории');
            return;
          }

          saveCatBtn.disabled = true;
          saveCatBtn.textContent = 'Сохраняем...';

          // Загружаем фото если выбрано
          let photoUrl = state.editingCategory?.photo_url || null;
          const photoFile = container.querySelector('#catPhotoInput')?.files[0];
          if (photoFile) {
            try {
              const auth = typeof getStoredAuth === 'function' ? getStoredAuth() : null;
              const formData = new FormData();
              formData.append('photo', photoFile);
              const uploadRes = await fetch(`${API_BASE_URL}/api/v1/upload/${CURRENT_MASTER_ID}`, {
                method: 'POST',
                headers: auth ? { 'Authorization': `Bearer ${auth.access_token}` } : {},
                body: formData,
              });
              if (uploadRes.ok) {
                const uploadData = await uploadRes.json();
                photoUrl = uploadData.url;
              } else {
                alert('Ошибка загрузки фото');
                saveCatBtn.disabled = false;
                saveCatBtn.textContent = state.editingCategory ? 'Сохранить' : 'Создать категорию';
                return;
              }
            } catch(e) {
              alert('Ошибка загрузки фото: ' + e.message);
              saveCatBtn.disabled = false;
              saveCatBtn.textContent = state.editingCategory ? 'Сохранить' : 'Создать категорию';
              return;
            }
          }

          const data = {
            master_id: CURRENT_MASTER_ID,
            name,
            icon,
            sort_order: sortOrder,
            is_active: true,
            photo_url: photoUrl,
          };

          if (state.editingCategory?.id) {
            await updateCategory(state.editingCategory.id, data);
          } else {
            await addCategory(data);
          }

          haptic('notification', 'success');
          state.editingCategory = null;
          state.masterTab = 'categories';
          await loadMasterTabData('categories');
          await reloadGlobalCategories();
          state.currentScreen = '_refresh';
          navigateTo('masterPanel', false);
        });
      }
      break;

    case 'catalog':
      // Тап по карточке услуги
      container.querySelectorAll('.service-card').forEach(card => {
        card.addEventListener('click', () => {
          const serviceId = card.dataset.serviceId;
          state.selectedService = SERVICES.find(s => String(s.id) === serviceId);
          navigateTo('service');
        });
      });
      break;

    case 'service':
      // Свайп галереи
      initGallerySwipe(container);
      // Кнопка «Записаться» на экране услуги
      const serviceBookBtn = container.querySelector('#serviceBookBtn');
      if (serviceBookBtn) {
        serviceBookBtn.addEventListener('click', () => {
          state.selectedDate = null;
          state.selectedTime = null;
          navigateTo('booking');
        });
      }
      break;

    case 'booking':
      const confirmBtn = container.querySelector('#bookingConfirmBtn');

      // Тап по дате
      container.querySelectorAll('.date-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          state.selectedDate = chip.dataset.date;
          state.selectedTime = null; // сбрасываем время при смене даты
          haptic('selection');

          // Обновляем визуал дат
          container.querySelectorAll('.date-chip').forEach(c => c.classList.remove('selected'));
          chip.classList.add('selected');

          // Деактивируем кнопку при смене даты
          if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.classList.add('disabled');
            confirmBtn.textContent = 'Выберите время';
          }

          // Обновляем слоты
          updateTimeSlots();
          updateTelegramButtons('booking');
        });
      });

      // Тап по времени
      container.querySelectorAll('.time-slot:not(.booked)').forEach(slot => {
        slot.addEventListener('click', () => {
          state.selectedTime = slot.dataset.time;
          haptic('selection');

          container.querySelectorAll('.time-slot').forEach(s => s.classList.remove('selected'));
          slot.classList.add('selected');

          // Активируем кнопку только если есть согласие
          const consent = container.querySelector('#consentCheckbox');
          if (confirmBtn) {
            if (consent && consent.checked) {
              confirmBtn.disabled = false;
              confirmBtn.classList.remove('disabled');
              confirmBtn.textContent = 'Записаться';
            } else {
              confirmBtn.disabled = true;
              confirmBtn.classList.add('disabled');
              confirmBtn.textContent = 'Дайте согласие';
            }
          }

          updateTelegramButtons('booking');
        });
      });

      // Чекбокс согласия на обработку ПД
      const consentCb = container.querySelector('#consentCheckbox');
      const consentLink = container.querySelector('#consentLink');
      if (consentCb) {
        consentCb.addEventListener('change', () => {
          if (confirmBtn && state.selectedDate && state.selectedTime) {
            if (consentCb.checked) {
              confirmBtn.disabled = false;
              confirmBtn.classList.remove('disabled');
              confirmBtn.textContent = 'Записаться';
            } else {
              confirmBtn.disabled = true;
              confirmBtn.classList.add('disabled');
              confirmBtn.textContent = 'Дайте согласие';
            }
          }
        });
      }
      if (consentLink) {
        consentLink.addEventListener('click', (e) => {
          e.preventDefault();
          showConsentPopup();
        });
      }

      // Чекбокс бонусов
      const useBonusCb = container.querySelector('#useBonusCheckbox');
      if (useBonusCb) {
        useBonusCb.addEventListener('change', () => {
          const row = container.querySelector('#bonusInputRow');
          if (row) row.style.display = useBonusCb.checked ? 'flex' : 'none';
        });
      }

      // Кнопка «Записаться»
      if (confirmBtn) {
        confirmBtn.addEventListener('click', () => {
          const consent = container.querySelector('#consentCheckbox');
          if (state.selectedDate && state.selectedTime && consent && consent.checked) {
            submitBooking();
          }
        });
      }
      break;

    case 'success':
      const successHomeBtn = container.querySelector('#successHomeBtn');
      if (successHomeBtn) {
        successHomeBtn.addEventListener('click', () => {
          state.screenHistory = [];
          navigateTo('home', false);
        });
      }
      break;
  }
}

// ============================================================
// ОБНОВЛЕНИЕ СЛОТОВ НА ГЛАВНОМ ЭКРАНЕ
// ============================================================

function updateHomeTimeSlots(container) {
  const timeContainer = container.querySelector('#homeTimeContainer');
  if (!timeContainer) return;

  if (!state.selectedDate || !SCHEDULE[state.selectedDate]) {
    timeContainer.innerHTML = '<div class="no-slots">Выберите дату</div>';
    return;
  }

  const slots = SCHEDULE[state.selectedDate];
  if (slots.length === 0) {
    timeContainer.innerHTML = '<div class="no-slots">Нет свободных слотов</div>';
    return;
  }

  timeContainer.innerHTML = '<div class="time-slots">' + slots.map(time => {
    const isBooked = BOOKED_SLOTS.includes(`${state.selectedDate}_${time}`);
    const cls = isBooked ? 'booked' : '';
    return `<div class="time-slot ${cls}" data-time="${time}">${time}</div>`;
  }).join('') + '</div>';

  // Обработчики на слоты
  timeContainer.querySelectorAll('.time-slot:not(.booked)').forEach(slot => {
    slot.addEventListener('click', () => {
      state.selectedTime = slot.dataset.time;
      haptic('selection');

      timeContainer.querySelectorAll('.time-slot').forEach(s => s.classList.remove('selected'));
      slot.classList.add('selected');
    });
  });
}

// ============================================================
// ГАЛЕРЕЯ (СВАЙП)
// ============================================================

function initGallerySwipe(container) {
  const gallery = container.querySelector('#galleryContainer');
  if (!gallery || gallery.children.length <= 1) return;

  let startX = 0;
  let currentX = 0;
  let isDragging = false;

  gallery.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    isDragging = true;
    gallery.style.transition = 'none';
  });

  gallery.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    currentX = e.touches[0].clientX - startX;
    const offset = -(state.galleryIndex * 100) + (currentX / gallery.offsetWidth * 100);
    gallery.style.transform = `translateX(${offset}%)`;
  });

  gallery.addEventListener('touchend', () => {
    isDragging = false;
    gallery.style.transition = 'transform 300ms ease-out';

    const totalSlides = gallery.children.length;
    if (currentX < -50 && state.galleryIndex < totalSlides - 1) {
      state.galleryIndex++;
    } else if (currentX > 50 && state.galleryIndex > 0) {
      state.galleryIndex--;
    }

    gallery.style.transform = `translateX(-${state.galleryIndex * 100}%)`;
    currentX = 0;

    // Обновляем точки
    const dots = container.querySelectorAll('.gallery-dot');
    dots.forEach((dot, i) => dot.classList.toggle('active', i === state.galleryIndex));

    haptic('selection');
  });
}

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================

// Haptic feedback (безопасный вызов)
function haptic(type, style) {
  if (!tg?.HapticFeedback) return;
  try {
    if (type === 'impact') {
      tg.HapticFeedback.impactOccurred(style || 'light');
    } else if (type === 'notification') {
      tg.HapticFeedback.notificationOccurred(style || 'success');
    } else if (type === 'selection') {
      tg.HapticFeedback.selectionChanged();
    }
  } catch (e) {
    // Игнорируем ошибки haptic feedback
  }
}

// Форматирование цены: 2000 → "2 000 ₽"
function formatPrice(price) {
  return price.toLocaleString('ru-RU') + ' ₽';
}

// Форматирование длительности: 90 → "1 ч 30 мин"
function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} мин`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h} ч ${m} мин` : `${h} ч`;
}

// Склонение: "3 услуги", "5 услуг"
function formatCount(n) {
  const forms = ['услуга', 'услуги', 'услуг'];
  const mod10 = n % 10;
  const mod100 = n % 100;
  let idx;
  if (mod100 >= 11 && mod100 <= 19) idx = 2;
  else if (mod10 === 1) idx = 0;
  else if (mod10 >= 2 && mod10 <= 4) idx = 1;
  else idx = 2;
  return `${n} ${forms[idx]}`;
}

// Парсинг даты из ключа "2026-03-10"
function parseDate(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Короткое имя дня: "Пн", "Вт"
function getDayName(date) {
  return ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][date.getDay()];
}

// Короткое имя месяца: "мар", "апр"
function getMonthShort(date) {
  return ['янв', 'фев', 'мар', 'апр', 'мая', 'июн',
          'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'][date.getMonth()];
}

// Полная дата: "10 марта, Пн"
function formatDateFull(date) {
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
                  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const day = getDayName(date);
  return `${date.getDate()} ${months[date.getMonth()]}, ${day}`;
}

// ============================================================
// ОНБОРДИНГ (ПРИВЕТСТВИЕ)
// ============================================================

function showOnboarding() {
  const tgUser = tg?.initDataUnsafe?.user;
  const firstName = tgUser?.first_name || '';
  const greeting = firstName ? `Привет, ${firstName}!` : 'Привет!';

  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="onboarding-screen">
      <div class="onboarding-emoji">✨</div>
      <div class="onboarding-title">${greeting}</div>
      <div class="onboarding-subtitle">Добро пожаловать в ${MASTER?.name || 'Beauty Platform'}</div>
      <ul class="onboarding-list">
        <li>Выбирайте услуги из каталога и записывайтесь онлайн</li>
        <li>Копите бонусы — 3% с каждого визита</li>
        <li>Получайте напоминания и эксклюзивные скидки</li>
      </ul>
      <button class="onboarding-btn" id="onboardingStartBtn">Начать</button>
    </div>
  `;

  document.getElementById('onboardingStartBtn').addEventListener('click', () => {
    localStorage.setItem('onboardingDone', '1');
    requestPushPermission(); // вызываем здесь — браузер требует действия пользователя
    document.getElementById('app').innerHTML = '';
    renderScreen('home');
    showOfferIfNeeded();
  });
}

// ============================================================
// ОФФЕР ПРИ ПЕРВОМ ОТКРЫТИИ
// ============================================================

function showOfferIfNeeded() {
  if (localStorage.getItem('offerShown')) return;

  const overlay = document.createElement('div');
  overlay.className = 'offer-overlay';
  overlay.innerHTML = `
    <div class="offer-card">
      <div class="offer-emoji">🎁</div>
      <div class="offer-title">Скидка 20% на первую запись</div>
      <div class="offer-subtitle">Подпишитесь на бота — получите промокод в личное сообщение</div>
      <ul class="offer-bullets">
        <li>Напомним о записи за день</li>
        <li>Первыми узнаёте о свободных окошках</li>
        <li>Эксклюзивные акции для подписчиков</li>
      </ul>
      <a href="https://t.me/lasertime_prilo_bot?profile" target="_blank" class="offer-btn">Получить скидку 20%</a>
      <button class="offer-skip" id="offerSkipBtn">Пропустить</button>
    </div>
  `;

  document.body.appendChild(overlay);

  // Анимация появления
  requestAnimationFrame(() => overlay.classList.add('visible'));

  const closeOffer = () => {
    localStorage.setItem('offerShown', '1');
    overlay.classList.remove('visible');
    setTimeout(() => overlay.remove(), 300);
  };

  overlay.querySelector('#offerSkipBtn').addEventListener('click', closeOffer);
  overlay.querySelector('.offer-btn').addEventListener('click', () => {
    closeOffer();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeOffer();
  });
}

// ============================================================
// НИЖНИЙ ТАБ-БАР
// ============================================================

// === Регистрация мастера через веб ===

function renderRegisterMaster() {
  const user = getCurrentUser();
  const phone = user ? user.phone : '';
  return `
    <div class="login-screen" style="padding-top: 40px;">
      <div class="login-logo">💼</div>
      <div class="login-title">Регистрация мастера</div>
      <div class="login-subtitle">Создайте аккаунт и начните принимать клиентов</div>

      <div style="padding: 0 20px; width: 100%; max-width: 400px; box-sizing: border-box;">
        <label class="login-label" style="margin-top:16px">Название салона / имя мастера *</label>
        <input type="text" id="regName" class="login-input" placeholder="Студия Анны" style="width:100%" />

        <label class="login-label" style="margin-top:12px">Телефон</label>
        <input type="tel" id="regPhone" class="login-input" value="${phone}" placeholder="+79001234567" style="width:100%" />

        <label class="login-label" style="margin-top:12px">Описание</label>
        <textarea id="regDescription" class="login-input" rows="3" placeholder="Кратко опишите ваши услуги" style="width:100%;resize:vertical"></textarea>

        <label class="login-label" style="margin-top:12px">Адрес страницы *</label>
        <input type="text" id="regSlug" class="login-input" placeholder="anna-laser" style="width:100%" />
        <div style="font-size:12px;color:var(--tg-theme-hint-color,#999);margin-top:4px">
          Ваша ссылка: app.beautyplatform.ru/?master=<span id="slugPreview">...</span>
        </div>
        <div style="font-size:11px;color:var(--tg-theme-hint-color,#aaa);margin-top:2px">Только латинские буквы, цифры и дефис. Можно изменить.</div>

        <button class="login-btn" id="regSubmitBtn" style="margin-top:20px">Зарегистрироваться</button>
        <div id="regResult" style="margin-top:12px;text-align:center"></div>
      </div>
    </div>
  `;
}

// === Колокольчик уведомлений ===

// ============================================================
// СУПЕР-АДМИН ПАНЕЛЬ (только для владельца платформы)
// URL: ?page=superadmin   Пароль: в .env ADMIN_PASSWORD
// ============================================================

const SUPERADMIN_KEY = 'superadmin_auth';

function renderSuperAdmin() {
  const authed = sessionStorage.getItem(SUPERADMIN_KEY);
  if (!authed) return renderSuperAdminLogin();
  return renderSuperAdminPanel();
}

function renderSuperAdminLogin() {
  return `
    <div class="login-screen" style="padding-top: 60px;">
      <div class="login-logo">🔐</div>
      <div class="login-title">Управление платформой</div>
      <div class="login-subtitle">Введите пароль администратора</div>
      <div style="padding: 0 20px; width: 100%; max-width: 360px; box-sizing: border-box;">
        <input class="phone-input" type="password" id="adminPasswordInput" placeholder="Пароль" autocomplete="off" style="margin-top: 32px;">
        <button class="phone-submit-btn" id="adminLoginBtn" style="margin-top: 16px;">Войти</button>
        <div id="adminLoginError" style="color:red; text-align:center; margin-top:12px; font-size:14px;"></div>
      </div>
    </div>
  `;
}

function renderSuperAdminPanel() {
  const masters = state.adminMasters || [];
  const tab = state.adminTab || 'masters';

  const masterRows = masters.map(m => `
    <div class="sadmin-master-row ${m.is_active ? '' : 'sadmin-paused'}">
      <div class="sadmin-master-info">
        <div class="sadmin-master-name">${escapeHtml(m.name)}</div>
        <div class="sadmin-master-meta">
          ${m.phone ? '📞 ' + m.phone + ' · ' : ''}
          ${m.slug ? '<a href="/?master=' + m.slug + '" target="_blank" class="sadmin-link">/' + m.slug + '</a>' : ''}
          ${m.bot_username ? ' · @' + m.bot_username : ''}
        </div>
        <div class="sadmin-master-status">${m.is_active ? '✅ Активен' : '⏸ Пауза'} · 🔐 Код: <b>${m.master_code || '—'}</b></div>
      </div>
      <div class="sadmin-master-actions">
        <button class="sadmin-btn ${m.is_active ? 'pause' : 'resume'}" data-master-id="${m.id}" data-active="${m.is_active}">
          ${m.is_active ? 'Пауза' : 'Включить'}
        </button>
        <button class="sadmin-btn delete" data-master-id="${m.id}" data-master-name="${escapeHtml(m.name)}">Удалить</button>
      </div>
    </div>
  `).join('') || '<div class="sadmin-empty">Мастеров нет</div>';

  return `
    <div class="history-screen admin-panel">
      <div class="sadmin-header">
        <div class="sadmin-title">🔐 Панель администратора</div>
        <div class="sadmin-header-actions">
          <button class="sadmin-refresh-btn" id="sadminRefresh">↻</button>
          <button class="sadmin-logout-btn" id="sadminLogout">Выйти</button>
        </div>
      </div>
      <div class="sadmin-stats">
        <div class="sadmin-stat">
          <div class="sadmin-stat-val">${masters.length}</div>
          <div class="sadmin-stat-label">Всего</div>
        </div>
        <div class="sadmin-stat">
          <div class="sadmin-stat-val">${masters.filter(m => m.is_active).length}</div>
          <div class="sadmin-stat-label">Активных</div>
        </div>
        <div class="sadmin-stat">
          <div class="sadmin-stat-val">${masters.filter(m => !m.is_active).length}</div>
          <div class="sadmin-stat-label">На паузе</div>
        </div>
      </div>
      <div class="sadmin-masters-list" id="sadminList">
        ${masterRows}
      </div>
      <button class="admin-add-btn" id="sadminAddBtn" style="margin: 16px;">+ Добавить мастера</button>
    </div>
  `;
}

let _notifInterval = null;

// --- Web Push ---
// Проверяем: iOS в браузере (не PWA) — push не поддерживается
function isIosInBrowser() {
  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isInPwa = window.navigator.standalone === true;
  return isIos && !isInPwa;
}

async function requestPushPermission() {
  const auth = typeof getStoredAuth === 'function' ? getStoredAuth() : null;
  if (!auth || !auth.access_token) {
    console.log('Push: нет JWT, пропускаем');
    return;
  }

  // iOS в браузере — PushManager недоступен, показываем подсказку
  if (isIosInBrowser()) {
    showIosPwaHint();
    return;
  }

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.log('Push: браузер не поддерживает push');
    return;
  }

  if (Notification.permission === 'denied') {
    console.log('Push: пользователь заблокировал уведомления');
    return;
  }

  // Уже подписаны — не просим повторно
  if (Notification.permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        console.log('Push: уже подписан');
        return;
      }
    } catch(e) { /* продолжаем */ }
  }

  try {
    const permission = await Notification.requestPermission();
    console.log('Push permission:', permission);
    if (permission !== 'granted') return;

    const reg = await navigator.serviceWorker.ready;

    const keyRes = await fetch(`${API_BASE_URL}/api/v1/push/vapid-key`);
    const keyData = await keyRes.json();
    const publicKey = keyData.publicKey;
    if (!publicKey) { console.warn('Push: нет VAPID ключа'); return; }

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    const subRes = await fetch(`${API_BASE_URL}/api/v1/push/subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${auth.access_token}`,
      },
      body: JSON.stringify(sub.toJSON()),
    });
    if (subRes.ok) {
      console.log('Push subscription saved');
    } else {
      const err = await subRes.text();
      console.warn('Push subscribe failed:', err);
    }
  } catch (err) {
    console.warn('Push subscription error:', err.message);
  }
}

function showIosPwaHint() {
  if (document.getElementById('iosPwaHint')) return;
  if (localStorage.getItem('iosPwaHintDismissed')) return;
  const banner = document.createElement('div');
  banner.id = 'iosPwaHint';
  banner.style.cssText = 'position:fixed;bottom:80px;left:12px;right:12px;background:#1a1a2e;color:#fff;border-radius:14px;padding:14px 16px;z-index:9999;font-size:14px;box-shadow:0 4px 20px rgba(0,0,0,0.4);display:flex;gap:12px;align-items:flex-start';
  banner.innerHTML = `
    <div style="font-size:22px;flex-shrink:0">📲</div>
    <div style="flex:1">
      <div style="font-weight:600;margin-bottom:4px">Включите уведомления</div>
      <div style="opacity:0.85;line-height:1.4">Нажмите <b>Поделиться</b> → <b>На экран Домой</b> — и уведомления заработают</div>
    </div>
    <button onclick="localStorage.setItem('iosPwaHintDismissed','1');document.getElementById('iosPwaHint').remove()" style="background:none;border:none;color:#aaa;font-size:20px;cursor:pointer;padding:0;line-height:1">×</button>
  `;
  document.body.appendChild(banner);
  setTimeout(() => { if (banner.parentNode) banner.remove(); }, 15000);
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// Обработка клика на push-уведомление (из SW)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'PUSH_CLICK') {
      // Обновляем колокольчик
      refreshNotifCount();
      // Открываем панель уведомлений
      toggleNotificationPanel();
    }
  });
}

function createNotificationBell() {
  const user = getCurrentUser();
  if (!user) return;

  if (document.getElementById('notifBellContainer')) return;

  const bell = document.createElement('div');
  bell.id = 'notifBellContainer';
  bell.innerHTML = '<button class="notification-bell" id="notifBell">🔔</button>';
  document.body.appendChild(bell);

  bell.addEventListener('click', toggleNotificationPanel);

  // Обновляем счётчик сразу и каждые 30 сек
  refreshNotifCount();
  _notifInterval = setInterval(refreshNotifCount, 30000);
}

async function refreshNotifCount() {
  if (typeof getUnreadNotifCount !== 'function') return;
  const count = await getUnreadNotifCount();
  const bell = document.getElementById('notifBell');
  if (!bell) return;
  const existing = bell.querySelector('.notif-badge');
  if (existing) existing.remove();
  if (count > 0) {
    const badge = document.createElement('span');
    badge.className = 'notif-badge';
    badge.textContent = count > 99 ? '99+' : count;
    bell.appendChild(badge);
  }
}

async function toggleNotificationPanel() {
  let panel = document.getElementById('notificationPanel');
  if (panel) {
    panel.remove();
    return;
  }

  panel = document.createElement('div');
  panel.id = 'notificationPanel';
  panel.className = 'notification-panel';
  panel.innerHTML = '<div class="notif-panel-header"><span>Уведомления</span><button id="notifMarkAll" class="notif-mark-all">Прочитать все</button></div><div class="notif-panel-list" id="notifList">Загрузка...</div>';
  document.body.appendChild(panel);

  // Загружаем уведомления
  if (typeof loadNotifications === 'function') {
    const notifs = await loadNotifications();
    const list = document.getElementById('notifList');
    if (!notifs || notifs.length === 0) {
      list.innerHTML = '<div class="notif-empty">Нет уведомлений</div>';
    } else {
      list.innerHTML = notifs.map(n => {
        const isReminder = n.type === 'reminder' && n.booking_id;
        const actions = isReminder ? `
          <div class="notif-actions" data-booking-id="${n.booking_id}" data-notif-id="${n.id}">
            <button class="notif-action-btn confirm" data-action="confirmed">Подтвердить</button>
            <button class="notif-action-btn cancel" data-action="cancelled">Отменить</button>
            <button class="notif-action-btn reschedule" data-action="reschedule">Перенести</button>
          </div>` : '';
        return `
          <div class="notification-item ${n.read ? '' : 'unread'}" data-id="${n.id}">
            <div class="notif-title">${escapeHtml(n.title)}</div>
            <div class="notif-body">${escapeHtml(n.body)}</div>
            ${actions}
            <div class="notif-time">${formatNotifTime(n.created_at)}</div>
          </div>`;
      }).join('');

      // Обработчики кнопок действий
      list.querySelectorAll('.notif-action-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const actionDiv = btn.closest('.notif-actions');
          const bookingId = actionDiv.dataset.bookingId;
          const notifId = actionDiv.dataset.notifId;
          const action = btn.dataset.action;

          btn.disabled = true;
          btn.textContent = '...';

          try {
            if (action === 'reschedule') {
              // Отменяем и переходим к записи
              await API.patch('bookings', `id=eq.${bookingId}`, { status: 'cancelled' });
              actionDiv.innerHTML = '<div class="notif-action-done">Запись отменена. Выберите новую дату.</div>';
              if (typeof markNotificationRead === 'function') await markNotificationRead(notifId);
              // Переходим на главную для перезаписи
              setTimeout(() => {
                const panel = document.getElementById('notificationPanel');
                if (panel) panel.remove();
                navigateTo('home');
              }, 1500);
            } else {
              await API.patch('bookings', `id=eq.${bookingId}`, { status: action });
              const label = action === 'confirmed' ? 'Запись подтверждена!' : 'Запись отменена';
              actionDiv.innerHTML = `<div class="notif-action-done">${label}</div>`;
              if (typeof markNotificationRead === 'function') await markNotificationRead(notifId);
            }
            refreshNotifCount();
          } catch (err) {
            btn.textContent = 'Ошибка';
          }
        });
      });
    }
  }

  // Кнопка "Прочитать все"
  document.getElementById('notifMarkAll')?.addEventListener('click', async () => {
    if (typeof markAllNotificationsRead === 'function') {
      await markAllNotificationsRead();
      document.querySelectorAll('.notification-item.unread').forEach(el => el.classList.remove('unread'));
      refreshNotifCount();
    }
  });

  // Закрытие по клику вне панели
  setTimeout(() => {
    document.addEventListener('click', closeNotifOnOutsideClick);
  }, 100);
}

function closeNotifOnOutsideClick(e) {
  const panel = document.getElementById('notificationPanel');
  const bell = document.getElementById('notifBellContainer');
  if (panel && !panel.contains(e.target) && !bell.contains(e.target)) {
    panel.remove();
    document.removeEventListener('click', closeNotifOnOutsideClick);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatNotifTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'только что';
  if (diffMin < 60) return `${diffMin} мин назад`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH} ч назад`;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function createTabBar() {
  const bar = document.createElement('nav');
  bar.className = 'tab-bar';
  bar.id = 'tabBar';
  bar.innerHTML = `
    <button class="tab-bar-item active" data-tab="catalog">
      <span class="tab-bar-icon">📋</span>
      <span class="tab-bar-label">Каталог</span>
    </button>
    <button class="tab-bar-item" data-tab="bonus">
      <span class="tab-bar-icon">🎁</span>
      <span class="tab-bar-label">Бонусы</span>
    </button>
    <button class="tab-bar-item" data-tab="history">
      <span class="tab-bar-icon">📅</span>
      <span class="tab-bar-label">Мои записи</span>
    </button>
  `;
  document.body.appendChild(bar);

  bar.querySelectorAll('.tab-bar-item').forEach(item => {
    item.addEventListener('click', () => {
      const tab = item.dataset.tab;
      const targetScreen = TAB_MAP[tab];
      if (state.currentScreen === targetScreen) return;
      // При переключении табов сбрасываем стек
      state.screenHistory = [];
      state.currentScreen = '_tab';
      navigateTo(targetScreen, false);
      haptic('selection');
    });
  });
}

function updateTabBar(screenName) {
  const bar = document.getElementById('tabBar');
  if (!bar) return;

  // Показываем таб-бар только на табовых экранах
  if (TAB_SCREENS.includes(screenName)) {
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }

  // Определяем активный таб
  let activeTab = null;
  if (screenName === 'home') activeTab = 'catalog';
  else if (screenName === 'bonus') activeTab = 'bonus';
  else if (screenName === 'history') activeTab = 'history';

  bar.querySelectorAll('.tab-bar-item').forEach(item => {
    item.classList.toggle('active', item.dataset.tab === activeTab);
  });
}

// ============================================================
// FALLBACK-КНОПКИ ДЛЯ БРАУЗЕРА (когда нет Telegram SDK)
// ============================================================

/**
 * Показывает/скрывает кнопку «Назад» в верхней части экрана,
 * а также кнопку действия внизу — для тестирования вне Telegram.
 */
function updateFallbackBackButton(screenName) {
  // Удаляем старые fallback-кнопки
  document.querySelectorAll('.fallback-back-btn, .fallback-main-btn').forEach(el => el.remove());

  // Кнопка «Назад» — скрываем на табовых экранах и успехе
  if (!TAB_SCREENS.includes(screenName) && screenName !== 'success') {
    const backBtn = document.createElement('button');
    backBtn.className = 'fallback-back-btn';
    backBtn.textContent = '←';
    backBtn.addEventListener('click', () => goBack());
    document.body.appendChild(backBtn);
  }

  // Кнопка действия внизу — только вне Telegram
  if (!tg) {
    let btnText = '';
    let btnAction = null;

    switch (screenName) {
      case 'service':
        btnText = 'ЗАПИСАТЬСЯ';
        btnAction = () => {
          state.selectedDate = null;
          state.selectedTime = null;
          navigateTo('booking');
        };
        break;
      case 'booking':
        btnText = 'ПОДТВЕРДИТЬ';
        btnAction = () => {
          if (state.selectedDate && state.selectedTime) {
            submitBooking();
          }
        };
        break;
      case 'success':
        btnText = 'ЗАКРЫТЬ';
        btnAction = () => navigateTo('home', false);
        break;
    }

    if (btnText && btnAction) {
      const mainBtn = document.createElement('button');
      mainBtn.className = 'fallback-main-btn';
      mainBtn.textContent = btnText;
      mainBtn.addEventListener('click', btnAction);
      document.body.appendChild(mainBtn);
    }
  }
}
