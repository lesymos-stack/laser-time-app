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

// Код доступа мастера
const MASTER_CODE = '5638';

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
};

// Запуск при загрузке страницы
document.addEventListener('DOMContentLoaded', () => {
  initTelegram();
  renderScreen('home');
  showOfferIfNeeded();
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

  // Скроллим наверх
  window.scrollTo(0, 0);
}

// Обновление кнопок Telegram
function updateTelegramButtons(screenName) {
  // Fallback-кнопка «Назад» для браузера (когда нет Telegram SDK)
  updateFallbackBackButton(screenName);

  if (!tg) return;

  // BackButton
  if (screenName === 'home' || screenName === 'success') {
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
      tg.MainButton.hide();
      break;
    case 'service':
      tg.MainButton.setText('ЗАПИСАТЬСЯ');
      tg.MainButton.show();
      tg.MainButton.onClick(mainButtonHandler);
      break;
    case 'booking':
      tg.MainButton.setText('ПОДТВЕРДИТЬ');
      tg.MainButton.show();
      if (!state.selectedDate || !state.selectedTime) {
        tg.MainButton.disable();
        tg.MainButton.color = '#999999';
      } else {
        tg.MainButton.enable();
        tg.MainButton.color = tg.themeParams?.button_color || '#2AABEE';
      }
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
        submitBooking();
      }
      break;
    case 'success':
      if (tg) tg.close();
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
      <div class="promo-title">Скидка до 30% на первый визит</div>
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
      <a href="https://whatsapp.com/dl/" class="contact-btn contact-btn-write" target="_blank">
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

    <button class="home-history-btn" id="homeHistoryBtn">
      <span class="home-booking-btn-icon">📋</span> История посещений
    </button>

    <button class="home-history-btn home-bonus-btn" id="homeBonusBtn">
      <span class="home-booking-btn-icon">🎁</span> Бонусы: ${getBonusBalance()} ₽
    </button>

    <button class="home-history-btn home-abonement-btn" id="homeAbonementBtn">
      <span class="home-booking-btn-icon">🏷️</span> Абонементы
    </button>

    <div class="reviews-section">
      <div class="reviews-title">Отзывы клиентов</div>
      <div class="review-card">
        <div class="review-header">
          <span class="review-name">Анна</span>
          <span class="review-stars">★★★★★</span>
        </div>
        <div class="review-text">После 4 сеансов лазерной эпиляции кожа идеально гладкая! Совсем не больно, мастер всё объяснила. Очень довольна результатом!</div>
      </div>
      <div class="review-card">
        <div class="review-header">
          <span class="review-name">Мария</span>
          <span class="review-stars">★★★★★</span>
        </div>
        <div class="review-text">Прошла комплекс по коррекции фигуры — минус 2 размера за курс! Процедуры комфортные, эффект заметен уже после третьего сеанса.</div>
      </div>
      <div class="review-card">
        <div class="review-header">
          <span class="review-name">Екатерина</span>
          <span class="review-stars">★★★★★</span>
        </div>
        <div class="review-text">Делала лазерную эпиляцию зоны бикини — быстро, аккуратно и без раздражения. Забыла про бритву! Всем подругам уже посоветовала.</div>
      </div>
    </div>
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
  const balance = getBonusBalance();
  const history = JSON.parse(localStorage.getItem('bookingHistory') || '[]');

  const listHTML = history.length
    ? history.map(b => {
        const bonus = (b.price * 0.03).toFixed(0);
        return `
          <div class="history-card">
            <div class="history-card-header">
              <span class="history-card-name">${b.serviceName}</span>
              <span class="history-card-price bonus-plus">+${bonus} ₽</span>
            </div>
            <div class="history-card-details">
              <span>${b.date}, ${b.time}</span>
            </div>
          </div>
        `;
      }).join('')
    : '<div class="history-empty">Бонусы начисляются автоматически — 3% от стоимости каждой услуги.</div>';

  return `
    <div class="history-screen">
      <div class="history-title">Бонусы</div>
      <div class="bonus-balance-card">
        <div class="bonus-balance-label">Ваш баланс</div>
        <div class="bonus-balance-value">${balance} ₽</div>
        <div class="bonus-balance-hint">3% с каждого посещения</div>
      </div>
      <div class="bonus-history-title">Начисления</div>
      ${listHTML}
    </div>
  `;
}

// ============================================================
// ЭКРАН: АБОНЕМЕНТЫ
// ============================================================

function renderAbonement() {
  return `
    <div class="history-screen">
      <div class="history-title">Абонементы</div>
      <div class="abonement-info">Лазерная эпиляция нового поколения — диодный аппарат премиум класса</div>

      <div class="abonement-section-title">Комплекс XS: Глубокое бикини + подмышки</div>
      <div class="abonement-section-sub">По комплексу у нас 3 250 ₽</div>

      <div class="abonement-card">
        <div class="abonement-card-header">
          <span class="abonement-card-name">10 процедур</span>
          <span class="abonement-card-badge">-12%</span>
        </div>
        <div class="abonement-card-prices">
          <span class="abonement-old-price">32 500 ₽</span>
          <span class="abonement-new-price">28 600 ₽</span>
        </div>
        <div class="abonement-card-saving">Экономия 3 900 ₽</div>
      </div>

      <div class="abonement-card">
        <div class="abonement-card-header">
          <span class="abonement-card-name">8 процедур</span>
          <span class="abonement-card-badge">-7%</span>
        </div>
        <div class="abonement-card-prices">
          <span class="abonement-old-price">26 000 ₽</span>
          <span class="abonement-new-price">24 180 ₽</span>
        </div>
        <div class="abonement-card-saving">Экономия 1 820 ₽</div>
      </div>

      <div class="abonement-card">
        <div class="abonement-card-header">
          <span class="abonement-card-name">5 процедур</span>
          <span class="abonement-card-badge">-5%</span>
        </div>
        <div class="abonement-card-prices">
          <span class="abonement-old-price">16 250 ₽</span>
          <span class="abonement-new-price">15 437 ₽</span>
        </div>
        <div class="abonement-card-saving">Экономия 813 ₽</div>
      </div>

      <div class="abonement-section-title">Комплекс S: Гл. бикини + подмышки + голени</div>
      <div class="abonement-section-sub">По комплексу у нас 4 990 ₽</div>

      <div class="abonement-card">
        <div class="abonement-card-header">
          <span class="abonement-card-name">10 процедур</span>
          <span class="abonement-card-badge">-12%</span>
        </div>
        <div class="abonement-card-prices">
          <span class="abonement-old-price">49 900 ₽</span>
          <span class="abonement-new-price">43 912 ₽</span>
        </div>
        <div class="abonement-card-saving">Экономия 5 988 ₽</div>
      </div>

      <div class="abonement-card">
        <div class="abonement-card-header">
          <span class="abonement-card-name">8 процедур</span>
          <span class="abonement-card-badge">-7%</span>
        </div>
        <div class="abonement-card-prices">
          <span class="abonement-old-price">39 920 ₽</span>
          <span class="abonement-new-price">37 125 ₽</span>
        </div>
        <div class="abonement-card-saving">Экономия 2 795 ₽</div>
      </div>

      <div class="abonement-card">
        <div class="abonement-card-header">
          <span class="abonement-card-name">5 процедур</span>
          <span class="abonement-card-badge">-5%</span>
        </div>
        <div class="abonement-card-prices">
          <span class="abonement-old-price">24 950 ₽</span>
          <span class="abonement-new-price">23 702 ₽</span>
        </div>
        <div class="abonement-card-saving">Экономия 1 248 ₽</div>
      </div>

      <div class="abonement-section-title">Комплекс M: Гл. бикини + подмышки + ноги полностью</div>
      <div class="abonement-section-sub">По комплексу у нас 5 990 ₽</div>

      <div class="abonement-card">
        <div class="abonement-card-header">
          <span class="abonement-card-name">10 процедур</span>
          <span class="abonement-card-badge">-12%</span>
        </div>
        <div class="abonement-card-prices">
          <span class="abonement-old-price">59 900 ₽</span>
          <span class="abonement-new-price">52 712 ₽</span>
        </div>
        <div class="abonement-card-saving">Экономия 7 188 ₽</div>
      </div>

      <div class="abonement-card">
        <div class="abonement-card-header">
          <span class="abonement-card-name">8 процедур</span>
          <span class="abonement-card-badge">-7%</span>
        </div>
        <div class="abonement-card-prices">
          <span class="abonement-old-price">47 930 ₽</span>
          <span class="abonement-new-price">44 565 ₽</span>
        </div>
        <div class="abonement-card-saving">Экономия 3 365 ₽</div>
      </div>

      <div class="abonement-card">
        <div class="abonement-card-header">
          <span class="abonement-card-name">5 процедур</span>
          <span class="abonement-card-badge">-5%</span>
        </div>
        <div class="abonement-card-prices">
          <span class="abonement-old-price">29 950 ₽</span>
          <span class="abonement-new-price">28 452 ₽</span>
        </div>
        <div class="abonement-card-saving">Экономия 1 498 ₽</div>
      </div>

      <div class="abonement-section-title">Комплекс L: Гл. бикини + подмышки + руки/ноги полностью</div>
      <div class="abonement-section-sub">По комплексу у нас 7 900 ₽</div>

      <div class="abonement-card">
        <div class="abonement-card-header">
          <span class="abonement-card-name">10 процедур</span>
          <span class="abonement-card-badge">-12%</span>
        </div>
        <div class="abonement-card-prices">
          <span class="abonement-old-price">70 000 ₽</span>
          <span class="abonement-new-price">69 520 ₽</span>
        </div>
        <div class="abonement-card-saving">Экономия 9 480 ₽</div>
      </div>

      <div class="abonement-card">
        <div class="abonement-card-header">
          <span class="abonement-card-name">8 процедур</span>
          <span class="abonement-card-badge">-7%</span>
        </div>
        <div class="abonement-card-prices">
          <span class="abonement-old-price">63 200 ₽</span>
          <span class="abonement-new-price">58 776 ₽</span>
        </div>
        <div class="abonement-card-saving">Экономия 4 424 ₽</div>
      </div>

      <div class="abonement-card">
        <div class="abonement-card-header">
          <span class="abonement-card-name">5 процедур</span>
          <span class="abonement-card-badge">-5%</span>
        </div>
        <div class="abonement-card-prices">
          <span class="abonement-old-price">39 500 ₽</span>
          <span class="abonement-new-price">37 525 ₽</span>
        </div>
        <div class="abonement-card-saving">Экономия 1 975 ₽</div>
      </div>

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
  const bookings = JSON.parse(localStorage.getItem('bookingHistory') || '[]');
  const today = new Date().toISOString().split('T')[0];

  const todayBookings = bookings.filter(b => b.date === today);
  const totalRevenue = bookings.reduce((sum, b) => sum + (b.price || 0), 0);

  const statsHTML = `
    <div class="master-stats">
      <div class="master-stat-card">
        <div class="master-stat-value">${todayBookings.length}</div>
        <div class="master-stat-label">Записей сегодня</div>
      </div>
      <div class="master-stat-card">
        <div class="master-stat-value">${bookings.length}</div>
        <div class="master-stat-label">Всего записей</div>
      </div>
      <div class="master-stat-card">
        <div class="master-stat-value">${totalRevenue.toLocaleString('ru-RU')} ₽</div>
        <div class="master-stat-label">Общая выручка</div>
      </div>
    </div>
  `;

  const todayListHTML = todayBookings.length
    ? todayBookings.map((b) => {
        const idx = bookings.indexOf(b);
        const statusHTML = b.confirmed
          ? '<span class="master-confirmed-badge">Визит подтверждён</span>'
          : `<button class="master-confirm-visit-btn" data-index="${idx}">Подтвердить визит</button>`;
        return `
        <div class="history-card">
          <div class="history-card-header">
            <span class="history-card-name">${b.serviceName}</span>
            <span class="history-card-price">${b.price} ₽</span>
          </div>
          <div class="history-card-details">
            <span>🕐 ${b.time}</span>
          </div>
          ${statusHTML}
        </div>
      `;
      }).join('')
    : '<div class="history-empty">На сегодня записей нет</div>';

  const allListHTML = bookings.length
    ? bookings.map((b, idx) => {
        const statusHTML = b.confirmed
          ? '<span class="master-confirmed-badge">Визит подтверждён</span>'
          : `<button class="master-confirm-visit-btn" data-index="${idx}">Подтвердить визит</button>`;
        return `
        <div class="history-card">
          <div class="history-card-header">
            <span class="history-card-name">${b.serviceName}</span>
            <span class="history-card-price">${b.price} ₽</span>
          </div>
          <div class="history-card-details">
            <span>📅 ${b.date}, ${b.time}</span>
          </div>
          ${statusHTML}
        </div>
      `;
      }).join('')
    : '<div class="history-empty">Пока нет записей</div>';

  return `
    <div class="history-screen">
      <div class="role-tabs">
        <button class="role-tab" id="roleClientFromMaster">Клиент</button>
        <button class="role-tab active" id="roleMasterFromMaster">Мастер</button>
      </div>

      <div class="history-title">Панель мастера</div>

      ${statsHTML}

      <div class="master-section-title">Записи на сегодня</div>
      ${todayListHTML}

      <div class="master-section-title">Все записи</div>
      ${allListHTML}
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
      timeSlotsHTML = '<div class="time-slots">' + slots.map(time => {
        const isBooked = BOOKED_SLOTS.includes(`${state.selectedDate}_${time}`);
        const isSelected = state.selectedTime === time;
        const cls = isBooked ? 'booked' : (isSelected ? 'selected' : '');
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

  container.innerHTML = '<div class="time-slots">' + slots.map(time => {
    const isBooked = BOOKED_SLOTS.includes(`${state.selectedDate}_${time}`);
    const isSelected = state.selectedTime === time;
    const cls = isBooked ? 'booked' : (isSelected ? 'selected' : '');
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

      // Активируем кнопку «Записаться» (ищем в DOM на момент клика)
      const confirmBtn = document.querySelector('#bookingConfirmBtn');
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.classList.remove('disabled');
        confirmBtn.textContent = 'Записаться';
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

      ${!tg ? '<button class="booking-confirm-btn" id="successHomeBtn">На главную</button>' : ''}
    </div>
  `;
}

// ============================================================
// ОТПРАВКА ЗАПИСИ
// ============================================================

function submitBooking() {
  const service = state.selectedService;
  const tgUser = tg?.initDataUnsafe?.user || {};

  // Данные записи
  const bookingData = {
    service_id: service.id,
    service_name: service.name,
    date: state.selectedDate,
    time: state.selectedTime,
    price: service.salePrice || service.price,
    duration: service.duration,
    tg_user_id: tgUser.id || null,
    tg_username: tgUser.username || null,
    tg_first_name: tgUser.first_name || null,
  };

  console.log('Запись отправлена:', bookingData);

  // Помечаем слот как занятый (локально)
  BOOKED_SLOTS.push(`${state.selectedDate}_${state.selectedTime}`);

  // Сохраняем в историю посещений
  const history = JSON.parse(localStorage.getItem('bookingHistory') || '[]');
  history.unshift({
    serviceName: service.name,
    date: state.selectedDate,
    time: state.selectedTime,
    price: service.salePrice || service.price,
    confirmed: false,
  });
  localStorage.setItem('bookingHistory', JSON.stringify(history));

  // TODO: отправить bookingData на бэкенд (Google Apps Script)
  // fetch(API_URL, { method: 'POST', body: JSON.stringify(bookingData) })

  // Переходим на экран успеха
  navigateTo('success');
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
        abonementBtn.addEventListener('click', () => {
          navigateTo('abonement');
        });
      }

      // Вкладка «Мастер»
      const roleMasterBtn = container.querySelector('#roleMaster');
      if (roleMasterBtn) {
        roleMasterBtn.addEventListener('click', () => {
          if (state.masterUnlocked) {
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
        const tryLogin = () => {
          if (codeInput.value === MASTER_CODE) {
            state.masterUnlocked = true;
            haptic('notification', 'success');
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

    case 'masterPanel':
      // Вкладка «Клиент» из панели мастера
      const roleClientBtn = container.querySelector('#roleClientFromMaster');
      if (roleClientBtn) {
        roleClientBtn.addEventListener('click', () => {
          navigateTo('home');
        });
      }
      // Кнопки подтверждения визита
      container.querySelectorAll('.master-confirm-visit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.index);
          const history = JSON.parse(localStorage.getItem('bookingHistory') || '[]');
          if (history[idx] && !history[idx].confirmed) {
            history[idx].confirmed = true;
            localStorage.setItem('bookingHistory', JSON.stringify(history));
            addBonus(history[idx].price);
            haptic('notification', 'success');
            // Перерендер панели
            state.currentScreen = '_refresh';
            navigateTo('masterPanel', false);
          }
        });
      });
      break;

    case 'catalog':
      // Тап по карточке услуги
      container.querySelectorAll('.service-card').forEach(card => {
        card.addEventListener('click', () => {
          const serviceId = parseInt(card.dataset.serviceId);
          state.selectedService = SERVICES.find(s => s.id === serviceId);
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

          // Активируем кнопку
          if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.classList.remove('disabled');
            confirmBtn.textContent = 'Записаться';
          }

          updateTelegramButtons('booking');
        });
      });

      // Кнопка «Записаться»
      if (confirmBtn) {
        confirmBtn.addEventListener('click', () => {
          if (state.selectedDate && state.selectedTime) {
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
// FALLBACK-КНОПКИ ДЛЯ БРАУЗЕРА (когда нет Telegram SDK)
// ============================================================

/**
 * Показывает/скрывает кнопку «Назад» в верхней части экрана,
 * а также кнопку действия внизу — для тестирования вне Telegram.
 */
function updateFallbackBackButton(screenName) {
  // Удаляем старые fallback-кнопки
  document.querySelectorAll('.fallback-back-btn, .fallback-main-btn').forEach(el => el.remove());

  // Кнопка «Назад» — на всех экранах кроме главной и успеха
  if (screenName !== 'home' && screenName !== 'success') {
    const backBtn = document.createElement('button');
    backBtn.className = 'fallback-back-btn';
    backBtn.textContent = '← Назад';
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
