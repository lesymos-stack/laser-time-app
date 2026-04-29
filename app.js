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

// Глобальный перехватчик ошибок — показывает падение на экране вместо белого фона.
// Помогает диагностировать проблемы у пользователей без открытия F12.
function __showFatalError(label, err) {
  try {
    const root = document.getElementById('app') || document.body;
    if (!root) return;
    const msg = (err && err.message) ? err.message : String(err);
    const stack = (err && err.stack) ? String(err.stack).slice(0, 800) : '';
    root.innerHTML = `
      <div style="padding:20px;font:14px/1.5 -apple-system,sans-serif;color:#222;background:#fff;min-height:100vh">
        <div style="font-size:42px;margin-bottom:12px">⚠️</div>
        <div style="font-weight:700;font-size:18px;margin-bottom:8px">Ошибка загрузки</div>
        <div style="margin-bottom:12px;color:#666">${label}</div>
        <pre style="background:#f5f5f5;padding:12px;border-radius:8px;font-size:12px;white-space:pre-wrap;word-break:break-word;color:#c00;max-height:200px;overflow:auto">${msg}\n\n${stack}</pre>
        <button onclick="(async()=>{
          try {
            if ('serviceWorker' in navigator) {
              const regs = await navigator.serviceWorker.getRegistrations();
              for (const r of regs) await r.unregister();
            }
            if (window.caches) {
              const keys = await caches.keys();
              for (const k of keys) await caches.delete(k);
            }
            localStorage.clear();
            sessionStorage.clear();
          } catch(e){}
          location.reload();
        })()" style="margin-top:14px;padding:12px 18px;background:#2196F3;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;width:100%">Очистить кэш и перезагрузить</button>
        <div style="margin-top:12px;font-size:12px;color:#999">Если ошибка повторяется — пришлите этот скриншот разработчику</div>
      </div>
    `;
  } catch (e) {
    // Если даже это упало — пишем в title чтобы было видно хоть что-то
    document.title = 'ERR: ' + ((err && err.message) || err);
  }
}
window.addEventListener('error', (e) => __showFatalError('JavaScript error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => __showFatalError('Promise rejection', e.reason));

const tg = window.Telegram?.WebApp;

// Если открыто не в Telegram — включаем тёмную палитру веб-темы
if (!tg || !tg.initDataUnsafe || !tg.initDataUnsafe.user) {
  document.documentElement.classList.add('web-theme');
}

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
  clientName: '',             // имя клиента для записи
  calendarMonth: null,        // текущий месяц календаря (Date)
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

  // Принудительно обновляем SW при каждом визите
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistration().then(reg => {
      if (reg) reg.update();
    });
  }

  // Очищаем данные если сменился мастер (другая ссылка)
  const currentSlug = new URLSearchParams(window.location.search).get('master');
  const savedSlug = localStorage.getItem('current_master_slug');
  if (currentSlug && savedSlug && currentSlug !== savedSlug) {
    // Мастер сменился — сбрасываем авторизацию и данные
    localStorage.removeItem('beauty_auth');
    localStorage.removeItem('onboardingDone');
    localStorage.removeItem('bookingHistory');
    localStorage.removeItem('bonusBalance');
    localStorage.removeItem('offerShown');
  }
  if (currentSlug) {
    localStorage.setItem('current_master_slug', currentSlug);
    // Cookie для iOS PWA (localStorage изолирован в standalone)
    document.cookie = 'beauty_master=' + encodeURIComponent(currentSlug) + ';path=/;max-age=' + (180 * 86400) + ';SameSite=Lax';
  }

  // PWA: если приложение открыто без ?master= и без ?page=, но есть сохранённый slug —
  // редиректим пользователя на его мастера (чтобы он не видел лендинг).
  // Не проверяем валидность токена: даже если он истёк, загрузка страницы мастера
  // сама обновит токен или покажет экран входа клиента. Главное — не лендинг.
  const pageParamCheck = new URLSearchParams(window.location.search).get('page');
  if (!currentSlug && !pageParamCheck) {
    const savedMasterSlug = localStorage.getItem('current_master_slug');
    if (savedMasterSlug) {
      location.replace('/?master=' + savedMasterSlug);
      return;
    }
  }

  // Проверяем ?page= ДО любых загрузок — для быстрого открытия спецстраниц
  const pageParamEarly = new URLSearchParams(window.location.search).get('page');
  if (pageParamEarly === 'register') {
    renderScreen('register');
    return;
  }
  if (pageParamEarly === 'superadmin') {
    renderScreen('superadmin');
    return;
  }
  if (pageParamEarly === 'master-login') {
    // Всегда показываем форму логина, даже если уже есть auth.
    // Прежде редиректили на сохранённый ?master=<slug>, но если мастер был
    // удалён через супер-админку — пользователь попадал на пустую страницу.
    // На этой странице явный intent — войти/сменить аккаунт.
    document.getElementById('app').innerHTML = renderMasterLoginScreen();
    initMasterLoginHandlers((user) => {
      const slug = user?.slug;
      if (slug) {
        localStorage.setItem('current_master_slug', slug);
        localStorage.setItem('onboardingDone', '1');
        location.replace('/?master=' + slug);
      } else {
        location.reload();
      }
    });
    return;
  }

  createTabBar();

  // Показываем skeleton пока грузим данные
  document.getElementById('app').innerHTML = `
    <div style="padding: 20px; text-align: center; margin-top: 40vh;">
      <div style="font-size: 24px; margin-bottom: 12px;">✨</div>
      <div style="color: var(--tg-theme-hint-color, #999);">Загружаем каталог...</div>
    </div>
  `;

  // Пытаемся загрузить данные с таймаутом 15 секунд
  try {
    const dataPromise = loadAllData();
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000));
    const data = await Promise.race([dataPromise, timeoutPromise]);
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

        // Создаём запись клиента в БД мастера, если её нет (для веб-регистраций)
        const roleNow = typeof getAuthRole === 'function' ? getAuthRole() : 'client';
        if (roleNow === 'client' && currentUser.phone && typeof upsertClient === 'function') {
          try {
            const clientData = currentUser.source === 'telegram'
              ? { id: currentUser.id, first_name: currentUser.name || '', username: currentUser.username || '' }
              : { id: 0, first_name: currentUser.name || '', username: '' };
            await upsertClient(CURRENT_MASTER_ID, clientData, currentUser.phone);
          } catch (e) { console.warn('upsertClient on load failed:', e); }
        }
      }

      // Автовход мастера отключён — требуется ввод кода при каждом визите

      console.log('✅ Данные загружены');
    } else {
      // Мастер не найден — нет ?master= в URL, показываем лендинг платформы
      document.getElementById('app').innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:32px 24px;text-align:center;background:#f8f8f8">
          <div style="font-size:56px;margin-bottom:16px">💆‍♀️</div>
          <div style="font-size:24px;font-weight:700;margin-bottom:8px;color:#1a1a1a">Beauty Platform</div>
          <div style="font-size:15px;color:#666;margin-bottom:24px;line-height:1.5">Онлайн-запись к мастерам красоты</div>

          <div style="width:100%;max-width:360px">
            <!-- Блок для клиента -->
            <div style="background:#fff;border-radius:16px;padding:24px;margin-bottom:16px;box-shadow:0 2px 8px rgba(0,0,0,0.06)">
              <div style="font-size:15px;font-weight:600;color:#1a1a1a;margin-bottom:8px">Вы клиент?</div>
              <div style="font-size:14px;color:#888;line-height:1.5">Попросите вашего мастера отправить вам ссылку для записи. Она выглядит так:</div>
              <div style="font-size:13px;color:#2196F3;margin-top:8px;word-break:break-all">app.beautyplatform.ru/?master=<i>имя-мастера</i></div>
            </div>

            <!-- Блок для мастера -->
            <div style="background:#fff;border-radius:16px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,0.06)">
              <div style="font-size:15px;font-weight:600;color:#1a1a1a;margin-bottom:8px">Вы мастер?</div>
              <div style="font-size:14px;color:#888;margin-bottom:16px;line-height:1.5">Зарегистрируйтесь и получите свою уникальную ссылку для клиентов</div>
              <a href="/?page=register" style="display:block;padding:14px;background:#2196F3;color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:600;text-decoration:none;text-align:center">Зарегистрироваться</a>
            </div>
          </div>
        </div>
      `;
      return;
    }
  } catch (err) {
    console.error('Ошибка загрузки:', err);
    document.getElementById('app').innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:32px 24px;text-align:center">
        <div style="font-size:48px;margin-bottom:16px">😔</div>
        <div style="font-size:18px;font-weight:600;margin-bottom:8px;color:#1a1a1a">Не удалось загрузить</div>
        <div style="font-size:14px;color:#888;margin-bottom:24px;line-height:1.5">Проверьте интернет-соединение<br>и попробуйте ещё раз</div>
        <button onclick="location.reload()" style="padding:14px 32px;background:#2196F3;color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:600;cursor:pointer">Повторить</button>
        <div style="margin-top:16px;font-size:12px;color:#ccc">${err.message || 'unknown error'}</div>
      </div>
    `;
    return;
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
  // Веб-пользователь без авторизации — показываем логин клиента
  // Но если телефон мастера совпадёт — мастер войдёт через masterLogin без звонка
  if (!tg && !getCurrentUser() && typeof renderLoginScreen === 'function') {
    // Скрываем таб-бар на экране авторизации
    const tabBar = document.getElementById('tabBar');
    if (tabBar) tabBar.classList.add('hidden');
    // Показываем экран с вкладками Клиент/Мастер
    document.getElementById('app').innerHTML = renderLoginScreen();
    initLoginHandlers((user) => {
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
    // Если мастер вошёл через ?page=master-login — сразу открываем панель
    const role = typeof getAuthRole === 'function' ? getAuthRole() : 'client';
    if (role === 'master') {
      state.masterUnlocked = true;
      state.screenHistory = [];
      state.currentScreen = 'masterPanel';
      await loadMasterTabData('bookings');
      renderScreen('masterPanel');
      updateTelegramButtons('masterPanel');
    } else {
      renderScreen('home');
      showOfferIfNeeded();
    }
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

  // При переходе на home — всегда сбрасываем флаг мастера
  if (screenName === 'home') {
    state.masterUnlocked = false;
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
    case 'history':  state.clientBookings = null; state.clientBookingsLoaded = false; html = renderHistory(); break;
    case 'bonus': {
      const authRole = typeof getAuthRole === 'function' ? getAuthRole() : 'client';
      const authObj = typeof getStoredAuth === 'function' ? getStoredAuth() : null;
      if (authObj && authRole === 'client') {
        // Показываем новый экран с историей бонусов
        state.bonusHistoryLoading = true;
        state.bonusHistoryData = null;
        html = renderBonusNew();
        // После рендера запускаем загрузку
        setTimeout(async () => {
          const data = await loadBonusHistoryJwt();
          state.bonusHistoryLoading = false;
          state.bonusHistoryData = data;
          if (state.currentScreen === 'bonus') {
            const app2 = document.getElementById('app');
            const bonusScreen = app2 && app2.querySelector('.screen.active');
            if (bonusScreen) bonusScreen.innerHTML = renderBonusNew();
          }
        }, 0);
      } else {
        html = renderBonus();
      }
      break;
    }
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

  // BackButton — скрываем на табовых экранах, success и панели мастера
  if (TAB_SCREENS.includes(screenName) || screenName === 'success' || screenName === 'masterPanel') {
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
      tg.MainButton.hide();
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
      <div class="category-card ${c.photo_url ? 'has-photo' : ''}" data-category="${c.id}">
        ${c.photo_url ? `<img class="category-photo" src="${c.photo_url}" alt="${c.name}">` : `<span class="category-icon">${c.icon}</span>`}
        <div class="category-label">
          <div class="category-name">${escapeHtml(c.name)}</div>
          <div class="category-count">${formatCount(counts[c.id] || 0)}</div>
        </div>
      </div>
    `).join('');

  const promoHTML = hasSale ? `
    <div class="promo-banner" data-action="show-sales">
      <div class="promo-badge">АКЦИЯ</div>
      <div class="promo-title">${MASTER.promo_title || 'Скидка до 20% на первый визит'}</div>
      <div class="promo-text">${MASTER.promo_text || 'Успейте записаться по выгодной цене'}</div>
    </div>
  ` : '';

  // Инициалы для аватара
  const initials = MASTER.name.split(' ').map(w => w[0]).join('').slice(0, 2);

  const whatsappUrl = safeUrl(MASTER.whatsapp_url || 'https://wa.me/' + (MASTER.phone || '').replace(/[^0-9]/g, ''));
  const telUrl = safeUrl('tel:' + (MASTER.phone || ''));
  const statsHTML = (MASTER.works_count > 0 || MASTER.years_experience > 0) ? `
    <div class="hero-stats">
      ${MASTER.works_count > 0 ? `<div class="hero-stat"><div class="hero-stat-num">${MASTER.works_count}</div><div class="hero-stat-label">работ</div></div>` : ''}
      ${(MASTER.works_count > 0 && MASTER.years_experience > 0) ? `<div class="hero-stat-sep"></div>` : ''}
      ${MASTER.years_experience > 0 ? `<div class="hero-stat"><div class="hero-stat-num">${MASTER.years_experience} лет</div><div class="hero-stat-label">опыт</div></div>` : ''}
      <div class="hero-stats-actions">
        ${telUrl ? `<a href="${escapeHtml(telUrl)}" class="hero-action-btn" aria-label="Позвонить">📞</a>` : ''}
        ${whatsappUrl ? `<a href="${escapeHtml(whatsappUrl)}" target="_blank" rel="noopener noreferrer" class="hero-action-btn" aria-label="Написать">💬</a>` : ''}
        <button class="hero-action-btn hero-bell" id="heroBell" aria-label="Уведомления">🔔</button>
      </div>
    </div>
  ` : '';

  return `
    ${MASTER.avatar ? `
    <div class="master-hero-v2" style="background-image:url('${MASTER.avatar}')">
      <div class="master-hero-overlay">
        <div class="master-hero-name">${escapeHtml(MASTER.name)}</div>
        <div class="master-hero-desc">${escapeHtml(MASTER.description)}</div>
      </div>
    </div>
    ${statsHTML}
    ` : `
    <div class="master-header">
      <div class="master-avatar">${initials}</div>
      <div class="master-info">
        <div class="master-name">${escapeHtml(MASTER.name)}</div>
        <div class="master-desc">${escapeHtml(MASTER.description)}</div>
      </div>
    </div>
    ${statsHTML}
    `}


    ${(() => {
      const u = getCurrentUser();
      const name = u && u.name ? u.name.split(' ')[0] : '';
      return name ? `
        <div class="home-greeting">
          <div class="home-greeting-hi">Привет, ${name}!</div>
          <div class="home-greeting-sub">Выберите услугу для записи</div>
        </div>
      ` : '';
    })()}

    <div class="section-title">Услуги</div>
    <div class="categories-grid">
      ${categoriesHTML}
    </div>

    ${promoHTML}

    ${(() => {
      // Популярные услуги — отмеченные мастером, потом акционные
      const markedPopular = SERVICES.filter(s => s.active && s.is_popular);
      const popular = markedPopular.length > 0
        ? markedPopular.slice(0, 5)
        : saleServices.length > 0
          ? saleServices.slice(0, 3)
          : [];
      if (!popular.length) return '';
      const cat = (id) => CATEGORIES.find(c => c.id === id);
      return `
        <div class="section-title">Популярные услуги</div>
        <div class="popular-services">
          ${popular.map(s => `
            <div class="popular-service-card" data-service-id="${s.id}" data-category="${s.category}">
              <div class="popular-service-icon">${cat(s.category)?.icon || '✨'}</div>
              <div class="popular-service-info">
                <div class="popular-service-name">${s.name}</div>
                <div class="popular-service-meta">⏱ ${s.duration} мин</div>
              </div>
              <div class="popular-service-price">
                ${s.salePrice ? `<div class="popular-service-old">${formatPrice(s.price)}</div>` : ''}
                <div class="popular-service-current">${formatPrice(s.salePrice || s.price)}</div>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    })()}

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
      <div class="abonement-section-title">${escapeHtml(complexName)}</div>
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
  const isLoggedIn = !!getCurrentUser();
  return `
    <div class="history-screen">
      <div class="master-login">
        <div class="master-login-icon">🔒</div>
        <div class="master-login-title">Вход для мастера</div>
        ${!isLoggedIn ? `
          <div class="master-login-hint">Введите номер телефона и код доступа</div>
          <input type="tel" class="master-login-input" id="masterPhoneInput" placeholder="Номер телефона" style="margin-bottom:12px">
        ` : `
          <div class="master-login-hint">Введите код доступа</div>
        `}
        <input type="password" class="master-login-input" id="masterCodeInput" maxlength="10" placeholder="Код доступа" inputmode="numeric">
        <div class="master-login-error hidden" id="masterLoginError">Неверный телефон или код</div>
        <button class="master-login-btn" id="masterLoginBtn">Войти</button>
      </div>
    </div>
  `;
}

// ============================================================
// ЭКРАН: ПАНЕЛЬ МАСТЕРА
// ============================================================

function renderMasterPanel() {
  // Используем новый дизайн с drawer
  return renderMasterPanelNew();
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
        // Нормализуем дату
        const dateKey = b.date && b.date.includes('T') ? b.date.split('T')[0] : b.date;
        const dateDisplay = dateKey ? formatDateFull(parseDate(dateKey)) : b.date;
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
            <span class="admin-booking-name">${escapeHtml(b.client_name || 'Клиент')}${b.client_username ? ' @' + escapeHtml(b.client_username) : ''}</span>
            <span class="admin-booking-status ${st.cls}">${st.label}</span>
          </div>
          <div class="admin-booking-phone">${b.client_phone ? '📞 ' + b.client_phone : ''}</div>
          <div class="admin-booking-details">
            <span>${serviceName}</span>
            <span>${dateDisplay}, ${timeShort}</span>
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
              <button class="admin-btn completed" data-booking-id="${b.id}" data-client-tg="${b.client_tg_id}" data-client-phone="${b.client_phone || ''}" data-price="${b.price || 0}">✅ Визит состоялся</button>
              <button class="admin-btn no-show" data-booking-id="${b.id}" data-client-tg="${b.client_tg_id}" data-client-phone="${b.client_phone || ''}">❌ Не пришёл</button>
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
          <div class="admin-service-name">${escapeHtml(s.name)}</div>
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
        <div class="admin-category-title">${cat.icon} ${escapeHtml(cat.name)}</div>
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
          <div class="admin-client-name">${escapeHtml(c.first_name || 'Клиент')}${c.username ? ' @' + escapeHtml(c.username) : ''}</div>
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
        const name = escapeHtml(c.first_name || 'Клиент');
        const info = c.phone ? ` (${escapeHtml(c.phone)})` : c.username ? ` (@${escapeHtml(c.username)})` : '';
        return `<label class="broadcast-client-row">
          <input type="checkbox" class="broadcast-client-check" data-phone="${escapeHtml(c.phone || '')}" data-tg="${c.tg_user_id || ''}" checked>
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
      <label class="admin-label">Фото мастера / салона</label>
      <div class="profile-photo-upload">
        ${m.avatar ? `<img src="${m.avatar}" class="profile-photo-preview" id="profilePhotoPreview">` : `<div class="profile-photo-placeholder" id="profilePhotoPreview">📷 Нажмите чтобы загрузить</div>`}
        <input type="file" id="profilePhotoInput" accept="image/*" style="display:none">
        <button class="admin-btn" id="profilePhotoBtn" style="margin-top:8px;">📷 ${m.avatar ? 'Изменить фото' : 'Загрузить фото'}</button>
      </div>

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

      <div style="display:flex;gap:12px;">
        <div style="flex:1;">
          <label class="admin-label">Кол-во работ</label>
          <input type="number" id="profileWorks" class="admin-input" value="${m.works_count || 0}" min="0" placeholder="1500" />
        </div>
        <div style="flex:1;">
          <label class="admin-label">Лет опыта</label>
          <input type="number" id="profileYears" class="admin-input" value="${m.years_experience || 0}" min="0" placeholder="5" />
        </div>
      </div>

      <label class="admin-label">Адрес</label>
      <input type="text" id="profileAddress" class="admin-input" value="${(m.address || '').replace(/"/g, '&quot;')}" placeholder="г. Москва, ул. Примерная, д. 1" />

      <label class="admin-label">Ссылка на Яндекс Карты</label>
      <input type="text" id="profileMapsUrl" class="admin-input" value="${(m.maps_url || '').replace(/"/g, '&quot;')}" placeholder="https://yandex.ru/maps/..." />
      <div class="admin-form-hint" style="font-size:12px;color:var(--tg-theme-hint-color,#999);margin:4px 0 8px;">Откройте Яндекс Карты → найдите точку → Поделиться → скопируйте ссылку</div>

      <div class="master-section-title" style="margin-top:20px;">Баннер акции на главной</div>
      <label class="admin-label">Заголовок акции</label>
      <input type="text" id="profilePromoTitle" class="admin-input" value="${(m.promo_title || '').replace(/"/g, '&quot;')}" placeholder="Скидка до 20% на первый визит">
      <label class="admin-label">Описание акции</label>
      <input type="text" id="profilePromoText" class="admin-input" value="${(m.promo_text || '').replace(/"/g, '&quot;')}" placeholder="Успейте записаться по выгодной цене">

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
          ${c.photo_url
            ? `<img class="admin-service-thumb" src="${c.photo_url}" style="width:48px;height:48px;border-radius:10px;object-fit:cover;">`
            : `<div class="admin-service-thumb-placeholder">${c.icon || '📁'}</div>`
          }
          <div class="admin-service-info">
            <div class="admin-service-name">${escapeHtml(c.name)}</div>
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

      <label class="admin-checkbox-label" style="margin-top:12px;">
        <input type="checkbox" id="svcPopular" ${isEdit && s.is_popular ? 'checked' : ''}>
        ⭐ Показывать в «Популярные услуги» на главной
      </label>

      <button class="admin-save-btn" id="saveServiceBtn">${isEdit ? 'Сохранить' : 'Создать услугу'}</button>
    </div>
  `;
}

// ============================================================
// ЭКРАН: ИСТОРИЯ ПОСЕЩЕНИЙ
// ============================================================

function renderHistory() {
  // Инициализируем вкладку
  if (!state.historyTab) state.historyTab = 'upcoming';

  // Загружаем записи клиента из API
  if (!state.clientBookings) {
    state.clientBookings = [];
    state.clientBookingsLoaded = false;
    loadClientBookingsForHistory();
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const all = (state.clientBookings || []).map(b => {
    // Нормализуем дату из ISO формата "2026-04-05T00:00:00.000Z" → "2026-04-05"
    if (b.date && b.date.includes('T')) b.date = b.date.split('T')[0];
    return b;
  });
  const upcoming = all.filter(b => {
    if (b.status === 'cancelled' || b.status === 'no_show' || b.status === 'completed') return false;
    const d = parseDate(b.date);
    return d >= today;
  });
  const past = all.filter(b => {
    const d = parseDate(b.date);
    return d < today || b.status === 'completed';
  });

  const isUpcoming = state.historyTab === 'upcoming';

  const upcomingHTML = upcoming.length
    ? upcoming.map(b => {
        const serviceName = b.services?.name || b.service_name || 'Услуга';
        const date = parseDate(b.date);
        const dateFmt = formatDateFull(date);
        const timeShort = b.time ? b.time.substring(0, 5) : '';
        const statusMap = {
          confirmed: { cls: 'status-confirmed', label: 'Подтверждено' },
          pending: { cls: 'status-pending', label: 'Ожидает подтверждения' },
        };
        const st = statusMap[b.status] || { cls: 'status-pending', label: b.status };

        return `
        <div class="my-booking-card">
          <div class="my-booking-status ${st.cls}">${st.label}</div>
          <div class="my-booking-service">${escapeHtml(serviceName)}</div>
          <div class="my-booking-datetime">
            <span>📅 ${dateFmt}</span>
            <span>🕐 ${timeShort}</span>
          </div>
          ${b.duration ? `<div class="my-booking-duration">⏱ ${formatDuration(b.duration)}</div>` : ''}
          <div class="my-booking-price">${b.price ? formatPrice(b.price) + ' · оплата на месте' : ''}</div>
          <div class="my-booking-actions">
            ${b.status === 'pending' ? `<button class="my-booking-btn confirm-btn" data-booking-id="${b.id}">Подтвердить</button>` : ''}
            <button class="my-booking-btn cancel-btn" data-booking-id="${b.id}">Отменить</button>
            <button class="my-booking-btn reschedule-btn" data-booking-id="${b.id}" data-service-id="${b.service_id}">Перенести</button>
          </div>
        </div>`;
      }).join('')
    : '<div class="history-empty">Нет предстоящих записей</div>';

  const pastHTML = past.length
    ? past.map(b => {
        const serviceName = b.services?.name || b.service_name || 'Услуга';
        const date = parseDate(b.date);
        const dateFmt = formatDateFull(date);
        const timeShort = b.time ? b.time.substring(0, 5) : '';
        const isCancelled = b.status === 'cancelled' || b.status === 'no_show';

        return `
        <div class="my-booking-card past">
          <div class="my-booking-status ${isCancelled ? 'status-cancelled' : 'status-completed'}">${isCancelled ? 'Отменено' : '✓ Выполнено'}</div>
          <div class="my-booking-service">${escapeHtml(serviceName)}</div>
          <div class="my-booking-datetime">
            <span>📅 ${dateFmt}</span>
            <span>🕐 ${timeShort}</span>
          </div>
          <div class="my-booking-price">${b.price ? formatPrice(b.price) : ''}</div>
          ${!isCancelled && b.service_id ? `
          <div class="my-booking-actions">
            <button class="my-booking-btn again-btn" data-service-id="${b.service_id}">Записаться снова</button>
          </div>` : ''}
        </div>`;
      }).join('')
    : '<div class="history-empty">Пока нет завершённых записей</div>';

  return `
    <div class="history-screen">
      <div class="history-title">Мои записи</div>
      <div class="history-tabs">
        <button class="history-tab ${isUpcoming ? 'active' : ''}" data-tab="upcoming">Предстоящие${upcoming.length ? ' (' + upcoming.length + ')' : ''}</button>
        <button class="history-tab ${!isUpcoming ? 'active' : ''}" data-tab="past">Прошедшие${past.length ? ' (' + past.length + ')' : ''}</button>
      </div>
      <div class="history-tab-content">
        ${isUpcoming ? upcomingHTML : pastHTML}
      </div>
    </div>
  `;
}

async function loadClientBookingsForHistory() {
  const user = getCurrentUser();
  if (!user || !CURRENT_MASTER_ID) return;
  try {
    const tgId = user.source === 'telegram' ? user.id : 0;
    const bookings = await loadClientBookings(CURRENT_MASTER_ID, tgId, user.phone);
    state.clientBookings = bookings || [];
    state.clientBookingsLoaded = true;
    // Перерисовываем если мы на экране истории
    if (state.currentScreen === 'history') {
      const app = document.getElementById('app');
      if (app) app.innerHTML = renderHistory();
      bindHistoryEvents();
    }
  } catch (e) {
    console.error('Ошибка загрузки записей клиента:', e);
  }
}

function bindHistoryEvents() {
  const container = document.getElementById('app');
  if (!container) return;

  // Переключение вкладок
  container.querySelectorAll('.history-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      state.historyTab = tab.dataset.tab;
      container.innerHTML = renderHistory();
      bindHistoryEvents();
      haptic('selection');
    });
  });

  // Подтвердить запись
  container.querySelectorAll('.confirm-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.bookingId;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        await API.patch('bookings', `id=eq.${id}`, { status: 'confirmed' });
        const b = state.clientBookings.find(x => x.id === id);
        if (b) b.status = 'confirmed';
        container.innerHTML = renderHistory();
        bindHistoryEvents();
        haptic('notification_success');
      } catch (e) {
        alert('Ошибка подтверждения');
        btn.disabled = false;
        btn.textContent = 'Подтвердить';
      }
    });
  });

  // Отменить запись
  container.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Отменить запись?')) return;
      const id = btn.dataset.bookingId;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        await API.patch('bookings', `id=eq.${id}`, { status: 'cancelled' });
        const b = state.clientBookings.find(x => x.id === id);
        if (b) {
          b.status = 'cancelled';
          // Освобождаем слот в BOOKED_SLOTS и BUSY_INTERVALS
          const slotKey = `${b.date}_${b.time ? b.time.substring(0,5) : ''}`;
          const idx = BOOKED_SLOTS.indexOf(slotKey);
          if (idx !== -1) BOOKED_SLOTS.splice(idx, 1);
          if (BUSY_INTERVALS[b.date]) {
            const startMin = timeToMinutes(b.time ? b.time.substring(0,5) : '');
            BUSY_INTERVALS[b.date] = BUSY_INTERVALS[b.date].filter(
              iv => !(iv.start === startMin)
            );
          }
        }
        container.innerHTML = renderHistory();
        bindHistoryEvents();
        haptic('notification_success');
      } catch (e) {
        alert('Ошибка отмены');
        btn.disabled = false;
        btn.textContent = 'Отменить';
      }
    });
  });

  // Перенести — переход на экран записи с тем же сервисом
  container.querySelectorAll('.reschedule-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const bookingId = btn.dataset.bookingId;
      const serviceId = btn.dataset.serviceId;
      const service = SERVICES.find(s => s.id === serviceId);
      if (service) {
        // Сначала отменяем текущую запись
        try {
          await API.patch('bookings', `id=eq.${bookingId}`, { status: 'cancelled' });
          const b = state.clientBookings.find(x => x.id === bookingId);
          if (b) {
            b.status = 'cancelled';
            const slotKey = `${b.date}_${b.time ? b.time.substring(0,5) : ''}`;
            const idx = BOOKED_SLOTS.indexOf(slotKey);
            if (idx !== -1) BOOKED_SLOTS.splice(idx, 1);
            if (BUSY_INTERVALS[b.date]) {
              const startMin = timeToMinutes(b.time ? b.time.substring(0,5) : '');
              BUSY_INTERVALS[b.date] = BUSY_INTERVALS[b.date].filter(
                iv => !(iv.start === startMin)
              );
            }
          }
        } catch (e) { /* продолжаем */ }
        // Открываем экран записи
        state.selectedService = service;
        state.selectedDate = null;
        state.selectedTime = null;
        navigateTo('booking');
      }
    });
  });

  // Записаться снова
  container.querySelectorAll('.again-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const serviceId = btn.dataset.serviceId;
      const service = SERVICES.find(s => s.id === serviceId);
      if (service) {
        state.selectedService = service;
        state.selectedDate = null;
        state.selectedTime = null;
        navigateTo('booking');
      }
    });
  });
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
    <div class="catalog-header">${category.icon} ${escapeHtml(category.name)}</div>
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
        <div class="service-name">${escapeHtml(service.name)}</div>
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
    ? service.photos.map(url => `<div class="gallery-slide"><img src="${url}" alt="${escapeHtml(service.name)}"></div>`).join('')
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

    <div class="detail-title">${escapeHtml(service.name)}</div>

    <div class="detail-meta">
      <div class="detail-meta-item">
        <span class="detail-meta-icon">🕐</span>
        <span class="detail-meta-value">${formatDuration(service.duration)}</span>
      </div>
      ${priceHTML}
    </div>

    <div class="detail-description-title">Описание</div>
    <div class="detail-description">${escapeHtml(service.description)}</div>

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
  overlay.querySelector('#consentPopupClose')?.addEventListener('click', () => {
    overlay.remove();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

// === Календарь для выбора даты ===
const MONTH_NAMES_FULL = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const DAY_HEADERS = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];

function buildCalendarHTML(viewDate, selectedDateKey, schedule) {
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const today = new Date();
  const todayKey = formatDateKey(today);

  // Первый день месяца и количество дней
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();

  // День недели первого числа (0=Пн, 6=Вс)
  let startDow = firstDay.getDay() - 1;
  if (startDow < 0) startDow = 6;

  let html = `
    <div class="cal-header">
      <button class="cal-nav" id="calPrev">‹</button>
      <span class="cal-title">${MONTH_NAMES_FULL[month]} ${year}</span>
      <button class="cal-nav" id="calNext">›</button>
    </div>
    <div class="cal-days-header">
      ${DAY_HEADERS.map(d => `<span>${d}</span>`).join('')}
    </div>
    <div class="cal-grid">`;

  // Пустые ячейки до первого дня
  for (let i = 0; i < startDow; i++) {
    html += '<span class="cal-day empty"></span>';
  }

  // Дни месяца
  for (let d = 1; d <= daysInMonth; d++) {
    const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const hasSlots = schedule[dateKey] && schedule[dateKey].length > 0;
    const isPast = dateKey < todayKey;
    const isToday = dateKey === todayKey;
    const isSelected = dateKey === selectedDateKey;

    let cls = 'cal-day';
    if (isPast || !hasSlots) cls += ' disabled';
    if (isToday) cls += ' today';
    if (isSelected) cls += ' selected';

    html += `<span class="${cls}" data-date="${dateKey}">${d}</span>`;
  }

  html += '</div>';
  return html;
}

function renderBooking() {
  const service = state.selectedService;
  if (!service) return '';

  const displayPrice = service.salePrice || service.price;

  // Генерируем календарь
  const calendarMonth = state.calendarMonth || new Date();
  const calendarHTML = buildCalendarHTML(calendarMonth, state.selectedDate, SCHEDULE);

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
      <div class="booking-summary-name">${escapeHtml(service.name)}</div>
      <div class="booking-summary-meta">${formatDuration(service.duration)} · ${formatPrice(displayPrice)}</div>
    </div>

    <div class="booking-section-title">Выберите дату</div>
    <div class="calendar-wrapper" id="calendarWrapper">
      ${calendarHTML}
    </div>

    <div class="booking-section-title">Выберите время</div>
    <div id="timeContainer">
      ${timeSlotsHTML}
    </div>

    <div class="booking-section-title">Ваше имя</div>
    <input type="text" id="bookingName" class="booking-phone-input" placeholder="Как к вам обращаться" value="${state.clientName || getCurrentUser()?.name || ''}" />

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
        <div class="success-card-title">${escapeHtml(service.name)}</div>
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

      ${(() => {
        const u = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
        const clientName = u && u.name ? u.name.split(' ')[0] : '';
        const addr = MASTER?.address || '';
        const mapsUrl = safeUrl(MASTER?.maps_url || '');
        const addrEsc = escapeHtml(addr);
        const nameEsc = escapeHtml(clientName);
        return `
          <div class="success-message">
            <div class="success-message-text">${nameEsc ? nameEsc + ', д' : 'Д'}о встречи! 🌸</div>
            ${addr ? `<div class="success-address">📍 Наш адрес: ${mapsUrl ? `<a href="${escapeHtml(mapsUrl)}" target="_blank" rel="noopener noreferrer" class="success-address-link">${addrEsc}</a>` : addrEsc}</div>` : ''}
          </div>
        `;
      })()}

      <div class="success-hint">Напоминание придёт за 24 часа</div>

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

  // Считываем имя из инпута
  const nameInput = document.getElementById('bookingName');
  const clientName = nameInput ? nameInput.value.trim() : (user?.name || '');
  state.clientName = clientName;

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
  // Обновляем BUSY_INTERVALS чтобы учесть длительность новой записи
  if (!BUSY_INTERVALS[state.selectedDate]) BUSY_INTERVALS[state.selectedDate] = [];
  const startMin = timeToMinutes(state.selectedTime);
  BUSY_INTERVALS[state.selectedDate].push({ start: startMin, end: startMin + service.duration });
  if (CURRENT_MASTER_ID) {
    try {
      const bookingData = {
        master_id: CURRENT_MASTER_ID,
        service_id: service.id,
        client_tg_id: user?.source === 'telegram' ? user.id : 0,
        client_name: clientName,
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
            ? { id: user.id, first_name: clientName || user.name, username: user.username }
            : { id: user.id, first_name: clientName, username: '' };
          upsertClient(CURRENT_MASTER_ID, clientData, phone);
        }
        // Создаём уведомления — мастеру о новой записи, клиенту о подтверждении
        try {
          const bookingId = Array.isArray(result) ? result[0]?.id : result?.id;
          const dateStr = formatDate ? formatDate(state.selectedDate) : state.selectedDate;
          const masterNotifBody = `${service.name}\n${dateStr} в ${state.selectedTime}\nКлиент: ${clientName || 'без имени'}\nТелефон: ${phone || '—'}\nСтоимость: ${finalPrice} ₽`;
          const clientNotifBody = `${service.name}\n${dateStr} в ${state.selectedTime}\nМастер: ${MASTER.name}\nСтоимость: ${finalPrice} ₽`;
          if (MASTER.phone && typeof createNotification === 'function') {
            const masterPhoneDigits = MASTER.phone.replace(/\D/g, '');
            await createNotification(masterPhoneDigits, CURRENT_MASTER_ID, 'new_booking', 'Новая запись', masterNotifBody, bookingId);
          }
          if (phone && typeof createNotification === 'function') {
            const clientPhoneDigits = phone.replace(/\D/g, '');
            await createNotification(clientPhoneDigits, CURRENT_MASTER_ID, 'booking_confirmed', 'Вы записаны!', clientNotifBody, bookingId);
          }
        } catch (e) { console.warn('Создание уведомлений не удалось:', e); }
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
      // Загружаем сегодняшние записи через новый JWT-эндпоинт
      await loadMpTodayBookings();
      // Для совместимости со старым кодом тоже загружаем общий список
      state.masterBookings = await loadMasterBookings(CURRENT_MASTER_ID) || [];
    } else if (tab === 'calendar') {
      if (!state.calendarMonth) state.calendarMonth = new Date();
      const m = state.calendarMonth;
      await loadCalendarMonthBookings(m.getFullYear(), m.getMonth());
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
      photo_url: c.photo_url,
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
      is_popular: s.is_popular || false,
    }));
  }
}

// Обновить содержимое админ-панели без полной перерисовки
function refreshAdminContent(container) {
  // Новый интерфейс — используем refreshMpContent
  if (container.querySelector('#mpPanelContent')) {
    refreshMpContent(container);
    return;
  }
  // Старый fallback (не должен вызываться, но на случай)
  const content = container.querySelector('#adminContent');
  if (!content) return;
  switch (state.masterTab) {
    case 'bookings': content.innerHTML = renderMpTodayFeed(); break;
    case 'services': content.innerHTML = renderMasterServicesList(); break;
    case 'categories': content.innerHTML = renderMasterCategoriesList(); break;
    case 'clients':  content.innerHTML = renderMasterClientsList(); break;
    case 'abonements': content.innerHTML = renderMasterAbonements(); break;
    case 'schedule': content.innerHTML = renderMasterSchedule(); break;
    case 'broadcast': content.innerHTML = renderBroadcastForm(); break;
    case 'profile': content.innerHTML = renderMasterProfileNew(); break;
  }
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
      // Колокольчик в строке статистики
      const heroBell = container.querySelector('#heroBell');
      if (heroBell) {
        document.body.classList.add('has-hero-bell');
        heroBell.addEventListener('click', (e) => { e.stopPropagation(); toggleNotificationPanel(); });
      } else {
        document.body.classList.remove('has-hero-bell');
      }
      // Тап по категории
      container.querySelectorAll('.category-card').forEach(card => {
        card.addEventListener('click', () => {
          state.selectedCategory = card.dataset.category;
          navigateTo('catalog');
        });
      });
      // Тап по популярной услуге
      container.querySelectorAll('.popular-service-card').forEach(card => {
        card.addEventListener('click', () => {
          state.selectedCategory = card.dataset.category;
          state.selectedService = SERVICES.find(s => s.id == card.dataset.serviceId);
          navigateTo('service');
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
          const masterSlug = MASTER?.slug || '';
          const masterName = MASTER?.name || 'Beauty Platform';
          const shareText = `Привет! Посмотри ${masterName}. Записаться можно онлайн:`;
          const shareUrl = MASTER?.bot_username
            ? `https://t.me/${MASTER.bot_username}`
            : `https://app.beautyplatform.ru/?master=${masterSlug}`;
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

      break;

    case 'history':
      bindHistoryEvents();
      break;

    case 'masterLogin':
      // Кнопка «Войти»
      const loginBtn = container.querySelector('#masterLoginBtn');
      const codeInput = container.querySelector('#masterCodeInput');
      const phoneInput = container.querySelector('#masterPhoneInput');
      const loginError = container.querySelector('#masterLoginError');

      if (loginBtn && codeInput) {
        const tryLogin = async () => {
          // Если мастер не залогинен — проверяем телефон
          if (phoneInput) {
            const enteredPhone = phoneInput.value.replace(/\D/g, '').slice(-10);
            const masterPhone = (MASTER && MASTER.phone || '').replace(/\D/g, '').slice(-10);
            if (!enteredPhone || enteredPhone !== masterPhone) {
              loginError.textContent = 'Неверный телефон или код';
              loginError.classList.remove('hidden');
              phoneInput.focus();
              haptic('notification', 'error');
              return;
            }
          }

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
            loginError.textContent = 'Неверный код доступа';
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
        if (phoneInput) {
          phoneInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') codeInput.focus();
          });
        }
        // Автофокус на первое поле
        setTimeout(() => (phoneInput || codeInput).focus(), 300);
      }

      // Вкладка «Клиент» из экрана входа
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
              const masterUrl = safeUrl(`https://app.beautyplatform.ru/?master=${encodeURIComponent(slug)}`);
              const masterUrlEsc = escapeHtml(masterUrl);
              const codeEsc = escapeHtml(String(data.master_code || ''));
              if (resultDiv) resultDiv.innerHTML = `<span style="color:green">
  ✅ Мастер зарегистрирован!<br><br>
  🔗 Ссылка:<br>
  <a href="${masterUrlEsc}" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin:8px 0;padding:12px 18px;background:#2196F3;color:#fff;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px;word-break:break-all">${masterUrlEsc}</a><br><br>
  🔐 Код доступа в кабинет мастера: <b style="font-size:20px">${codeEsc}</b><br><br>
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
      // Новый интерфейс с drawer
      bindMasterPanelNewEvents(container);

      // Совместимость: старые admin-tab (если вдруг останутся)
      container.querySelectorAll('.admin-tab').forEach(tab => {
        tab.addEventListener('click', async () => {
          state.masterTab = tab.dataset.tab;
          state.mpSection = tab.dataset.tab;
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
          state.mpSection = 'services';
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
          state.mpSection = 'categories';
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
          state.mpSection = 'abonements';
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

            // Также отправляем через Telegram-бот (для TG-клиентов).
            // Endpoint /api/broadcast — это Vercel Serverless Function на app.beautyplatform.ru,
            // НЕ на api.beautyplatform.ru, поэтому шлём на тот же origin что и текущая страница.
            try {
              await fetch('/api/broadcast', {
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

      // --- Профиль: загрузка фото ---
      const profilePhotoBtn = container.querySelector('#profilePhotoBtn');
      const profilePhotoInput = container.querySelector('#profilePhotoInput');
      if (profilePhotoBtn && profilePhotoInput) {
        profilePhotoBtn.addEventListener('click', () => profilePhotoInput.click());
        profilePhotoInput.addEventListener('change', async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          profilePhotoBtn.disabled = true;
          profilePhotoBtn.textContent = '⏳ Загрузка...';
          try {
            const compressed = await (typeof compressImage === 'function' ? compressImage(file).catch(() => file) : file);
            const formData = new FormData();
            formData.append('file', compressed, file.name || 'photo.jpg');
            const headers = {};
            const auth = typeof getStoredAuth === 'function' ? getStoredAuth() : null;
            if (auth && auth.access_token) headers['Authorization'] = 'Bearer ' + auth.access_token;
            const resp = await fetch(`${API_BASE_URL}/api/v1/upload/${CURRENT_MASTER_ID}`, {
              method: 'POST',
              headers,
              body: formData,
            });
            const data = await resp.json().catch(() => ({}));
            if (data.url) {
              await updateMaster(CURRENT_MASTER_ID, { avatar_url: data.url });
              MASTER.avatar = data.url;
              const preview = container.querySelector('#profilePhotoPreview');
              if (preview) {
                preview.outerHTML = `<img src="${data.url}" class="profile-photo-preview" id="profilePhotoPreview">`;
              }
              profilePhotoBtn.textContent = '✅ Фото загружено';
            } else {
              profilePhotoBtn.textContent = '❌ Ошибка загрузки';
            }
          } catch (err) {
            profilePhotoBtn.textContent = '❌ ' + err.message;
          }
          setTimeout(() => {
            profilePhotoBtn.disabled = false;
            profilePhotoBtn.textContent = '📷 Изменить фото';
          }, 2000);
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
          const works_count = parseInt(container.querySelector('#profileWorks')?.value || '0', 10) || 0;
          const years_experience = parseInt(container.querySelector('#profileYears')?.value || '0', 10) || 0;
          const master_code = container.querySelector('#profileCode')?.value.trim();
          const promo_title = container.querySelector('#profilePromoTitle')?.value.trim();
          const promo_text = container.querySelector('#profilePromoText')?.value.trim();
          const address = container.querySelector('#profileAddress')?.value.trim();
          const maps_url = container.querySelector('#profileMapsUrl')?.value.trim();

          if (!name) {
            const res = container.querySelector('#profileResult');
            if (res) { res.textContent = '❌ Название не может быть пустым'; res.style.color = '#c00'; }
            return;
          }

          saveProfileBtn.disabled = true;
          saveProfileBtn.textContent = 'Сохранение...';

          try {
            const data = { name, description, phone, whatsapp_url, welcome_text, works_count, years_experience, promo_title, promo_text, address, maps_url };
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
              MASTER.works_count = works_count;
              MASTER.years_experience = years_experience;
              MASTER.promo_title = promo_title;
              MASTER.promo_text = promo_text;
              MASTER.address = address;
              MASTER.maps_url = maps_url;
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
          const bid = btn.dataset.bookingId;
          // Освобождаем слот до обновления
          const bk = state.masterBookings.find(x => x.id === bid);
          if (bk) {
            const slotKey = `${bk.date}_${bk.time ? bk.time.substring(0,5) : ''}`;
            const idx = BOOKED_SLOTS.indexOf(slotKey);
            if (idx !== -1) BOOKED_SLOTS.splice(idx, 1);
            if (BUSY_INTERVALS[bk.date]) {
              const startMin = timeToMinutes(bk.time ? bk.time.substring(0,5) : '');
              BUSY_INTERVALS[bk.date] = BUSY_INTERVALS[bk.date].filter(
                iv => !(iv.start === startMin)
              );
            }
          }
          await updateBookingStatus(bid, 'cancelled');
          haptic('notification', 'warning');
          await loadMasterTabData('bookings');
          refreshAdminContent(container);
        });
      });

      // --- Записи: визит состоялся / не пришёл (через VPS API) ---
      async function handleVisitAction(btn, action) {
        try {
          const bookingId = btn.dataset.bookingId;
          const clientTg = parseInt(btn.dataset.clientTg) || 0;
          const clientPhone = btn.dataset.clientPhone || '';
          const price = parseInt(btn.dataset.price) || 0;

          btn.disabled = true;
          btn.textContent = '⏳';

          const newStatus = action === 'no_show' ? 'no_show' : 'completed';

          // 1. Обновляем статус записи
          const patchRes = await API.patch('bookings', `id=eq.${bookingId}`, { status: newStatus });
          if (!patchRes) throw new Error('Не удалось обновить статус');

          let bonusAmount = 0;

          // 2. Начисляем бонусы для completed
          if (newStatus === 'completed' && price > 0) {
            // Ищем клиента по tg_id или телефону
            let clients = [];
            if (clientTg) {
              clients = await API.fetch('clients', `master_id=eq.${CURRENT_MASTER_ID}&tg_user_id=eq.${clientTg}&select=id,bonus_balance`) || [];
            }
            if (!clients.length && clientPhone) {
              clients = await API.fetch('clients', `master_id=eq.${CURRENT_MASTER_ID}&phone=eq.${encodeURIComponent(clientPhone)}&select=id,bonus_balance`) || [];
            }

            if (clients.length > 0) {
              const client = clients[0];
              bonusAmount = Math.round(price * 0.03 * 100) / 100; // 3%
              const expiresAt = new Date();
              expiresAt.setMonth(expiresAt.getMonth() + 3);

              // Создаём транзакцию бонуса
              await API.post('bonus_transactions', {
                master_id: CURRENT_MASTER_ID,
                client_id: client.id,
                booking_id: bookingId,
                amount: bonusAmount,
                type: 'credit',
                description: 'Начисление 3% за визит',
                expires_at: expiresAt.toISOString(),
              });

              // Обновляем баланс клиента
              const newBalance = parseFloat(client.bonus_balance || 0) + bonusAmount;
              await API.patch('clients', `id=eq.${client.id}`, { bonus_balance: newBalance });

              // Помечаем запись как bonus_credited
              await API.patch('bookings', `id=eq.${bookingId}`, { bonus_credited: true });
            }
          }

          haptic('notification', action === 'completed' ? 'success' : 'warning');

          if (bonusAmount > 0) {
            alert(`Визит подтверждён! Клиенту начислено ${bonusAmount} ₽ бонусов (3%)`);
          } else if (action === 'completed') {
            alert('Визит подтверждён!');
          } else {
            alert('Отмечено: клиент не пришёл');
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
          state.mpSection = 'serviceForm';
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
          state.mpSection = 'serviceForm';
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

          const isPopular = container.querySelector('#svcPopular')?.checked || false;

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
            is_popular: isPopular,
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
          state.mpSection = 'services';
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
          state.mpSection = 'categoryForm';
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
          state.mpSection = 'categoryForm';
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
              // Сжимаем перед отправкой (Vercel rewrite limit 4.5MB)
              const compressed = await (typeof compressImage === 'function' ? compressImage(photoFile).catch(() => photoFile) : photoFile);
              const formData = new FormData();
              formData.append('file', compressed, photoFile.name || 'photo.jpg');
              const uploadRes = await fetch(`${API_BASE_URL}/api/v1/upload/${CURRENT_MASTER_ID}`, {
                method: 'POST',
                headers: auth ? { 'Authorization': `Bearer ${auth.access_token}` } : {},
                body: formData,
              });
              if (uploadRes.ok) {
                const uploadData = await uploadRes.json();
                photoUrl = uploadData.url;
              } else {
                const errText = await uploadRes.text().catch(() => uploadRes.status);
                alert('Не удалось загрузить фото: ' + errText);
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
          state.mpSection = 'categories';
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

      // Календарь — навигация по месяцам и выбор дня
      function bindCalendarEvents() {
        const wrapper = container.querySelector('#calendarWrapper');
        if (!wrapper) return;

        const prevBtn = wrapper.querySelector('#calPrev');
        const nextBtn = wrapper.querySelector('#calNext');

        if (prevBtn) prevBtn.addEventListener('click', () => {
          const m = state.calendarMonth || new Date();
          state.calendarMonth = new Date(m.getFullYear(), m.getMonth() - 1, 1);
          wrapper.innerHTML = buildCalendarHTML(state.calendarMonth, state.selectedDate, SCHEDULE);
          bindCalendarEvents();
        });

        if (nextBtn) nextBtn.addEventListener('click', () => {
          const m = state.calendarMonth || new Date();
          state.calendarMonth = new Date(m.getFullYear(), m.getMonth() + 1, 1);
          wrapper.innerHTML = buildCalendarHTML(state.calendarMonth, state.selectedDate, SCHEDULE);
          bindCalendarEvents();
        });

        wrapper.querySelectorAll('.cal-day:not(.disabled):not(.empty)').forEach(day => {
          day.addEventListener('click', () => {
            state.selectedDate = day.dataset.date;
            state.selectedTime = null;
            haptic('selection');

            wrapper.querySelectorAll('.cal-day').forEach(d => d.classList.remove('selected'));
            day.classList.add('selected');

            if (confirmBtn) {
              confirmBtn.disabled = true;
              confirmBtn.classList.add('disabled');
              confirmBtn.textContent = 'Выберите время';
            }

            updateTimeSlots();
            updateTelegramButtons('booking');
          });
        });
      }
      bindCalendarEvents();

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

  document.getElementById('onboardingStartBtn').addEventListener('click', async () => {
    localStorage.setItem('onboardingDone', '1');
    requestPushPermission(); // вызываем здесь — браузер требует действия пользователя
    document.getElementById('app').innerHTML = '';
    // Мастер — сразу в панель, клиент — на главную
    const role = typeof getAuthRole === 'function' ? getAuthRole() : 'client';
    if (role === 'master') {
      state.masterUnlocked = true;
      state.screenHistory = [];
      state.currentScreen = 'masterPanel';
      await loadMasterTabData('bookings');
      renderScreen('masterPanel');
      updateTelegramButtons('masterPanel');
    } else {
      renderScreen('home');
      showOfferIfNeeded();
    }
  });
}

// ============================================================
// ОФФЕР ПРИ ПЕРВОМ ОТКРЫТИИ
// ============================================================

function showOfferIfNeeded() {
  if (localStorage.getItem('offerShown')) return;

  // Если у мастера нет Telegram-бота — не показываем оффер с подпиской
  const botUsername = MASTER?.bot_username;
  const botLink = botUsername ? `https://t.me/${botUsername}?start=promo` : '';

  const overlay = document.createElement('div');
  overlay.className = 'offer-overlay';
  overlay.innerHTML = `
    <div class="offer-card">
      <div class="offer-emoji">🎁</div>
      <div class="offer-title">Скидка 20% на первую запись</div>
      <div class="offer-subtitle">${botLink ? 'Подпишитесь на бота — получите промокод' : 'Запишитесь сейчас и получите скидку'}</div>
      <ul class="offer-bullets">
        <li>Напомним о записи за день</li>
        <li>Первыми узнаёте о свободных окошках</li>
        <li>Эксклюзивные акции для подписчиков</li>
      </ul>
      ${botLink ? `<a href="${escapeHtml(safeUrl(botLink))}" target="_blank" rel="noopener noreferrer" class="offer-btn">Получить скидку 20%</a>` : ''}
      <button class="offer-skip" id="offerSkipBtn">${botLink ? 'Пропустить' : 'Понятно'}</button>
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

  // Опциональные кнопки: skip может отсутствовать в кастомных рендерах,
  // .offer-btn рендерится только если у мастера настроен Telegram-бот (botLink).
  // Без guard'а — TypeError на null.addEventListener сразу после SMS-входа.
  overlay.querySelector('#offerSkipBtn')?.addEventListener('click', closeOffer);
  overlay.querySelector('.offer-btn')?.addEventListener('click', closeOffer);
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
          ${m.phone ? '📞 ' + escapeHtml(m.phone) + ' · ' : ''}
          ${m.slug ? '<a href="/?master=' + encodeURIComponent(m.slug) + '" target="_blank" rel="noopener noreferrer" class="sadmin-link">/' + escapeHtml(m.slug) + '</a>' : ''}
          ${m.bot_username ? ' · @' + escapeHtml(m.bot_username) : ''}
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

  // Колокольчик теперь только в hero-stats на главной (heroBell)
  // Плавающий не создаём — только запускаем обновление счётчика
  if (!_notifInterval) {
    refreshNotifCount();
    _notifInterval = setInterval(refreshNotifCount, 30000);
  }
}

async function refreshNotifCount() {
  if (typeof loadNotifications !== 'function') return;
  let notifs = await loadNotifications();
  // Фильтруем по роли
  const role = typeof getAuthRole === 'function' ? getAuthRole() : 'client';
  if (role === 'master') {
    notifs = (notifs || []).filter(n => ['new_booking', 'status_change', 'reminder', 'broadcast'].includes(n.type));
  } else {
    notifs = (notifs || []).filter(n => ['booking_confirmed', 'reminder', 'broadcast'].includes(n.type));
  }
  const count = (notifs || []).filter(n => !n.read).length;
  ['notifBell', 'heroBell'].forEach(id => {
    const bell = document.getElementById(id);
    if (!bell) return;
    const existing = bell.querySelector('.notif-badge');
    if (existing) existing.remove();
    if (count > 0) {
      const badge = document.createElement('span');
      badge.className = 'notif-badge';
      badge.textContent = count > 99 ? '99+' : count;
      bell.appendChild(badge);
    }
  });
}

function closeNotificationPanel() {
  const panel = document.getElementById('notificationPanel');
  if (!panel) return;
  panel.remove();
  document.removeEventListener('click', closeNotifOnOutsideClick);
}

async function toggleNotificationPanel() {
  const existing = document.getElementById('notificationPanel');
  if (existing) {
    closeNotificationPanel();
    return;
  }

  if (!window.__notifPopstateBound) {
    window.__notifPopstateBound = true;
    window.addEventListener('popstate', () => {
      closeNotificationPanel();
    });
  }

  const panel = document.createElement('div');
  panel.id = 'notificationPanel';
  panel.className = 'notification-panel';
  panel.innerHTML = '<div class="notif-panel-header"><span>Уведомления</span><button id="notifMarkAll" class="notif-mark-all">Прочитать все</button></div><div class="notif-panel-list" id="notifList">Загрузка...</div>';
  document.body.appendChild(panel);
  history.pushState({ notifOpen: true }, '');

  // Загружаем уведомления с фильтрацией по роли
  if (typeof loadNotifications === 'function') {
    let notifs = await loadNotifications();
    // Фильтруем по роли: клиент не видит уведомления мастера и наоборот
    const role = typeof getAuthRole === 'function' ? getAuthRole() : 'client';
    if (role === 'master') {
      notifs = (notifs || []).filter(n => ['new_booking', 'status_change', 'reminder', 'broadcast'].includes(n.type));
    } else {
      notifs = (notifs || []).filter(n => ['booking_confirmed', 'reminder', 'broadcast'].includes(n.type));
    }
    const list = document.getElementById('notifList');
    if (!notifs || notifs.length === 0) {
      list.innerHTML = '<div class="notif-empty">Нет уведомлений</div>';
    } else {
      // Дедуплицируем reminder: оставляем кнопки только на последнем (первом в списке) для каждой записи
      const seenBookingReminders = new Set();
      list.innerHTML = notifs.map(n => {
        // Кнопки только на непрочитанном reminder + только один раз на запись
        let hasActions = false;
        if (n.type === 'reminder' && n.booking_id && !n.read) {
          if (!seenBookingReminders.has(n.booking_id)) {
            hasActions = true;
            seenBookingReminders.add(n.booking_id);
          }
        }
        const actions = hasActions ? `
          <div class="notif-actions" data-booking-id="${n.booking_id}" data-notif-id="${n.id}">
            <button class="notif-action-btn confirm" data-action="confirmed">Подтвердить</button>
            <button class="notif-action-btn cancel" data-action="cancelled">Отменить</button>
            <button class="notif-action-btn reschedule" data-action="reschedule">Перенести</button>
          </div>` : '';
        // Исправляем дату если она в GMT-формате (баг старых записей)
        const body = (n.body || '').replace(
          /\w{3} \w{3} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT[+\-]\d{4} \([^)]+\)/g,
          (m) => { try { const d = new Date(m); return `${String(d.getUTCDate()).padStart(2,'0')}.${String(d.getUTCMonth()+1).padStart(2,'0')}.${d.getUTCFullYear()}`; } catch(e) { return m; } }
        );
        return `
          <div class="notification-item ${n.read ? '' : 'unread'}" data-id="${n.id}">
            <div class="notif-title">${escapeHtml(n.title)}</div>
            <div class="notif-body">${escapeHtml(body).replace(/\n/g, '<br>')}</div>
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
              if (typeof markBookingRemindersRead === 'function') await markBookingRemindersRead(bookingId);
              else if (typeof markNotificationRead === 'function') await markNotificationRead(notifId);
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
              if (typeof markBookingRemindersRead === 'function') await markBookingRemindersRead(bookingId);
              else if (typeof markNotificationRead === 'function') await markNotificationRead(notifId);
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
  const heroBellEl = document.getElementById('heroBell');
  if (panel && !panel.contains(e.target) && !(bell && bell.contains(e.target)) && !(heroBellEl && heroBellEl.contains(e.target))) {
    closeNotificationPanel();
    if (history.state && history.state.notifOpen) history.back();
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url, window.location.origin);
    if (['http:', 'https:', 'tel:', 'mailto:'].includes(u.protocol)) return url;
    return '';
  } catch { return ''; }
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
    <button class="tab-bar-item" data-tab="share">
      <span class="tab-bar-icon">💌</span>
      <span class="tab-bar-label">Поделиться</span>
    </button>
  `;
  document.body.appendChild(bar);

  bar.querySelectorAll('.tab-bar-item').forEach(item => {
    item.addEventListener('click', () => {
      const tab = item.dataset.tab;

      // «Поделиться» — не экран, а действие
      if (tab === 'share') {
        const masterSlug = MASTER?.slug || '';
        const masterName = MASTER?.name || 'Beauty Platform';
        const shareText = `Привет! Посмотри ${masterName}. Записаться можно онлайн:`;
        const shareUrl = MASTER?.bot_username
          ? `https://t.me/${MASTER.bot_username}`
          : `https://app.beautyplatform.ru/?master=${masterSlug}`;
        if (tg) {
          tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(shareText)}`);
        } else {
          window.open(`https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(shareText)}`, '_blank');
        }
        haptic('impact', 'light');
        return;
      }

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

  // Кнопка «Назад» — скрываем на табовых экранах, успехе и панели мастера
  if (!TAB_SCREENS.includes(screenName) && screenName !== 'success' && screenName !== 'masterPanel') {
    const backBtn = document.createElement('button');
    backBtn.className = 'fallback-back-btn';
    backBtn.textContent = '←';
    backBtn.addEventListener('click', () => goBack());
    document.body.appendChild(backBtn);
  }

  // Кнопка «ЗАКРЫТЬ» на success убрана — есть «На главную»
}

// ============================================================
// STAGE 3 — MASTER PANEL REDESIGN (M6/M1/M3/M4/M5/M2)
// ============================================================

// --- Показать toast-уведомление ---
function showToast(message, duration) {
  const existing = document.getElementById('mpToast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'mpToast';
  toast.className = 'mp-toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('show'));
  });
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 220);
  }, duration || 2200);
}

// --- Авторизованный fetch для мастера (JWT из getStoredAuth) ---
async function authFetch(path, options) {
  const auth = typeof getStoredAuth === 'function' ? getStoredAuth() : null;
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options && options.headers);
  if (auth && auth.access_token) headers['Authorization'] = 'Bearer ' + auth.access_token;
  const res = await fetch(API_BASE_URL + path, Object.assign({}, options, { headers }));
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error('HTTP ' + res.status + ': ' + errText);
  }
  return res.json();
}

// --- Открытие / закрытие drawer ---
function openMpDrawer() {
  document.body.classList.add('mp-drawer-open');
}

function closeMpDrawer() {
  document.body.classList.remove('mp-drawer-open');
}

// --- Инициализация drawer (обработчики событий) ---
function initMpDrawer(container) {
  const overlay = container.querySelector('.mp-drawer-overlay');
  const closeBtn = container.querySelector('.mp-drawer-close-btn');

  if (overlay) overlay.addEventListener('click', closeMpDrawer);
  if (closeBtn) closeBtn.addEventListener('click', closeMpDrawer);

  // Закрытие по ESC
  const escHandler = (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('mp-drawer-open')) {
      closeMpDrawer();
    }
  };
  document.addEventListener('keydown', escHandler);

  // Закрытие свайпом влево
  let touchStartX = 0;
  const drawer = container.querySelector('.mp-drawer');
  if (drawer) {
    drawer.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
    drawer.addEventListener('touchend', (e) => {
      const delta = e.changedTouches[0].clientX - touchStartX;
      if (delta < -50) closeMpDrawer();
    }, { passive: true });
  }

  // Пункты drawer
  container.querySelectorAll('.mp-drawer-item[data-section]').forEach(item => {
    item.addEventListener('click', async () => {
      const section = item.dataset.section;
      closeMpDrawer();
      if (section === 'logout') {
        if (typeof clearAuth === 'function') clearAuth();
        state.masterUnlocked = false;
        state.masterTab = 'bookings';
        location.reload();
        return;
      }
      state.masterTab = section;
      state.mpSection = section;
      haptic('selection');
      if (['bookings', 'services', 'categories', 'clients', 'abonements', 'schedule', 'broadcast', 'profile'].includes(section)) {
        await loadMasterTabData(section);
      }
      // navigateTo делает ранний return если currentScreen уже masterPanel,
      // поэтому ставим '_refresh' чтобы форсировать перерисовку.
      state.currentScreen = '_refresh';
      navigateTo('masterPanel', false);
    });
  });
}

// --- Render нового master panel с drawer ---
function renderMasterPanelNew() {
  const section = state.mpSection || state.masterTab || 'bookings';
  const m = MASTER || {};

  const drawerItems = [
    { section: 'bookings',   icon: '📋', label: 'Записи' },
    { section: 'calendar',   icon: '📆', label: 'Календарь' },
    { section: 'services',   icon: '✂️',  label: 'Услуги' },
    { section: 'categories', icon: '🗂',  label: 'Категории' },
    { section: 'schedule',   icon: '📊', label: 'Расписание' },
    { section: 'clients',    icon: '👥', label: 'Клиенты' },
    { section: 'broadcast',  icon: '📣', label: 'Рассылка' },
    { section: 'profile',    icon: '⚙️',  label: 'Профиль' },
  ];

  const drawerItemsHTML = drawerItems.map(it => `
    <button class="mp-drawer-item${section === it.section ? ' active' : ''}" data-section="${escapeHtml(it.section)}">
      <span class="mp-drawer-item-icon">${it.icon}</span>
      <span>${it.label}</span>
    </button>
  `).join('');

  const avatarHTML = m.avatar
    ? `<img class="mp-avatar" src="${escapeHtml(m.avatar)}" alt="">`
    : `<div class="mp-avatar">👤</div>`;

  let contentHTML = '';
  switch (section) {
    case 'bookings':  contentHTML = renderMpTodayFeed(); break;
    case 'calendar':  contentHTML = renderMpCalendar(); break;
    case 'dayView':   contentHTML = renderMpDayView(); break;
    case 'services':  contentHTML = renderMasterServicesList(); break;
    case 'categories': contentHTML = renderMasterCategoriesList(); break;
    case 'schedule':  contentHTML = renderMasterSchedule(); break;
    case 'clients':   contentHTML = renderMasterClientsList(); break;
    case 'broadcast': contentHTML = renderBroadcastForm(); break;
    case 'profile':   contentHTML = renderMasterProfileNew(); break;
    case 'serviceForm': contentHTML = renderServiceForm(); break;
    case 'categoryForm': contentHTML = renderCategoryForm(); break;
    case 'abonementForm': contentHTML = renderAbonementForm(); break;
    case 'scheduleForm': contentHTML = renderScheduleForm(); break;
    case 'abonements': contentHTML = renderMasterAbonements(); break;
    case 'wizard':    contentHTML = renderMpWizard(); break;
    default: contentHTML = renderMpTodayFeed();
  }

  // Статусная строка (для экрана записей)
  let statusBarHTML = '';
  if (section === 'bookings') {
    const bookings = state.todayBookings || [];
    const count = bookings.length;
    const amount = bookings.reduce((s, b) => s + (b.price || 0), 0);
    statusBarHTML = `
      <div class="mp-status-bar">
        <span class="stat-bookings">${count} ${pluralBookings(count)}</span>
        <span style="color:var(--tg-theme-hint-color,#999)">·</span>
        <span class="stat-amount">${amount.toLocaleString('ru-RU')} ₽</span>
      </div>`;
  }

  const fabHTML = (section === 'bookings' || section === 'dayView')
    ? `<button class="mp-fab" id="mpFabBtn">+</button>`
    : '';

  return `
    <div class="mp-panel-wrapper" id="mpPanelWrapper">
      <div class="mp-drawer-overlay"></div>
      <nav class="mp-drawer">
        <div class="mp-drawer-head">
          <div class="mp-drawer-head-top">
            ${avatarHTML}
            <button class="mp-drawer-close-btn">✕</button>
          </div>
          <div class="mp-drawer-name">${escapeHtml(m.name || 'Мастер')}</div>
          ${m.studio_name ? `<div class="mp-drawer-subtitle">${escapeHtml(m.studio_name)}</div>` : ''}
        </div>
        <div class="mp-drawer-items">
          ${drawerItemsHTML}
          <div class="mp-drawer-divider"></div>
          <button class="mp-drawer-item" data-section="logout">
            <span class="mp-drawer-item-icon">🚪</span>
            <span>Выйти</span>
          </button>
        </div>
      </nav>

      <div class="mp-header">
        <button class="mp-burger-btn" id="mpBurgerBtn">☰</button>
        <div class="mp-header-title">${escapeHtml(m.name || 'Панель мастера')}</div>
        <button class="mp-bell-btn" id="heroBell" aria-label="Уведомления">🔔</button>
        ${avatarHTML}
      </div>
      ${statusBarHTML}
      <div class="mp-panel-content" id="mpPanelContent">
        ${contentHTML}
      </div>
      ${fabHTML}
    </div>
  `;
}

function pluralBookings(n) {
  if (n % 10 === 1 && n % 100 !== 11) return 'запись';
  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return 'записи';
  return 'записей';
}

// --- M3 — Лента сегодняшних записей ---
function renderMpTodayFeed() {
  const bookings = state.todayBookings;
  if (!bookings) {
    return `<div class="mp-empty-state"><div class="mp-empty-icon">⏳</div><div class="mp-empty-title">Загрузка...</div></div>`;
  }
  if (bookings.length === 0) {
    return `
      <div class="mp-empty-state">
        <div class="mp-empty-icon">☕</div>
        <div class="mp-empty-title">Сегодня записей нет</div>
        <div class="mp-empty-hint">Свободный день — отдыхайте!</div>
      </div>`;
  }

  const today = new Date();
  const dateLabel = today.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })
    .replace(/^./, c => c.toUpperCase());

  const cardsHTML = bookings.map(b => renderMpBookingCard(b)).join('');

  return `
    <div class="mp-day-section-header">
      <span>${escapeHtml(dateLabel)}</span>
      <hr>
    </div>
    ${cardsHTML}
  `;
}

// --- Карточка записи (M3/M5) ---
function renderMpBookingCard(b) {
  const time = b.time ? b.time.substring(0, 5) : '';
  const dur = b.duration ? Math.floor(b.duration / 60) + (b.duration % 60 ? 'ч ' + (b.duration % 60) + 'м' : 'ч') : '';
  const durSimple = b.duration ? (b.duration >= 60 ? Math.floor(b.duration / 60) + ' ч' + (b.duration % 60 ? ' ' + (b.duration % 60) + ' м' : '') : b.duration + ' м') : '';
  const statusMap = {
    pending:   { cls: 'pending',   label: 'Ожидает' },
    confirmed: { cls: 'confirmed', label: 'Подтверждено' },
    cancelled: { cls: 'cancelled', label: 'Отменено' },
    completed: { cls: 'completed', label: 'Завершено' },
  };
  const st = statusMap[b.status] || { cls: 'pending', label: b.status || 'Ожидает' };

  // Кнопки доступны только для активных записей (не отменённых и не завершённых)
  const showActions = b.status === 'pending' || b.status === 'confirmed';
  const phoneDigits = b.client_phone ? String(b.client_phone).replace(/\D/g, '') : '';
  const actionsHTML = showActions ? `
    <div class="mp-booking-actions" data-booking-id="${escapeHtml(b.id || '')}">
      <button class="mp-bk-act done" data-act="complete" title="Завершить и начислить бонус">✅ Завершить</button>
      <button class="mp-bk-act move" data-act="reschedule" title="Перенести запись">📅 Перенести</button>
      <button class="mp-bk-act cancel" data-act="cancel" title="Отменить запись">🚫 Отменить</button>
      ${phoneDigits ? `<a class="mp-bk-act call" href="tel:+${phoneDigits}" title="Позвонить">📞</a>` : ''}
    </div>
  ` : '';

  return `
    <div class="mp-booking-card" data-booking-id="${escapeHtml(b.id || '')}">
      <div class="mp-booking-time-block">
        <span class="time">${escapeHtml(time)}</span>
        ${durSimple ? `<span class="dur">${escapeHtml(durSimple)}</span>` : ''}
      </div>
      <div class="mp-booking-info">
        <div class="mp-booking-client">${escapeHtml(b.client_name || 'Клиент')}</div>
        <div class="mp-booking-service">${escapeHtml(b.service_name || '')}</div>
        ${b.price ? `<div class="mp-booking-price">${b.price.toLocaleString('ru-RU')} ₽</div>` : ''}
        ${actionsHTML}
      </div>
      <span class="mp-status-badge ${st.cls}">${st.label}</span>
    </div>`;
}

// Простой модальный диалог выбора даты+времени для переноса записи.
// Возвращает {date:'YYYY-MM-DD', time:'HH:MM'} или null (отмена).
function pickDateTime(initialDate, initialTime) {
  return new Promise((resolve) => {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:20px;width:100%;max-width:340px;box-shadow:0 10px 40px rgba(0,0,0,0.2)">
        <div style="font-weight:700;font-size:18px;margin-bottom:16px;color:#222">Перенести запись</div>
        <label style="display:block;font-size:13px;color:#666;margin-bottom:6px">Новая дата</label>
        <input type="date" id="__pkDate" min="${todayStr}" value="${initialDate || todayStr}" style="width:100%;padding:12px;font-size:16px;border:1px solid #ddd;border-radius:10px;margin-bottom:14px;box-sizing:border-box">
        <label style="display:block;font-size:13px;color:#666;margin-bottom:6px">Новое время</label>
        <input type="time" id="__pkTime" value="${initialTime || '10:00'}" step="900" style="width:100%;padding:12px;font-size:16px;border:1px solid #ddd;border-radius:10px;margin-bottom:18px;box-sizing:border-box">
        <div style="display:flex;gap:8px">
          <button id="__pkCancel" style="flex:1;padding:12px;background:#eee;color:#333;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer">Отмена</button>
          <button id="__pkOk" style="flex:1;padding:12px;background:#FF9800;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer">Перенести</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('#__pkCancel').addEventListener('click', () => close(null));
    overlay.querySelector('#__pkOk').addEventListener('click', () => {
      const d = overlay.querySelector('#__pkDate').value;
      const t = overlay.querySelector('#__pkTime').value;
      if (!d || !t) { alert('Заполни дату и время'); return; }
      close({ date: d, time: t });
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
  });
}

// Универсальный обработчик кнопок карточки записи (используется в today-feed и dayView)
async function bindMpBookingActions(container) {
  container.querySelectorAll('.mp-booking-actions').forEach(group => {
    const bookingId = group.dataset.bookingId;
    if (!bookingId) return;
    group.querySelectorAll('.mp-bk-act[data-act]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        haptic('selection');
        try {
          if (act === 'complete') {
            if (!confirm('Отметить запись как завершённую? Клиенту будет начислен бонус.')) return;
            btn.disabled = true; btn.textContent = '...';
            // Вызываем endpoint который атомарно: меняет статус, начисляет бонус, шлёт push клиенту
            const result = await authFetch('/api/v1/bookings/' + bookingId + '/complete', { method: 'POST' });
            haptic('notification', 'success');
            const sum = result?.bonus_amount || 0;
            const balance = result?.new_balance;
            if (sum > 0) {
              const balanceTxt = (balance != null) ? `\nБаланс клиента: ${balance.toLocaleString('ru-RU')} ₽` : '';
              alert(`✅ Запись завершена\nНачислено клиенту: ${sum.toLocaleString('ru-RU')} ₽ бонусов${balanceTxt}`);
            } else {
              alert('✅ Запись завершена');
            }
          } else if (act === 'cancel') {
            if (!confirm('Отменить запись? Слот освободится для других клиентов.')) return;
            btn.disabled = true; btn.textContent = '...';
            await API.patch('bookings', `id=eq.${bookingId}`, { status: 'cancelled' });
            haptic('notification', 'warning');
          } else if (act === 'reschedule') {
            const picked = await pickDateTime();
            if (!picked) return;
            btn.disabled = true; btn.textContent = '...';
            await API.patch('bookings', `id=eq.${bookingId}`, { date: picked.date, time: picked.time });
            haptic('notification', 'success');
          } else {
            return;
          }
          // Перезагружаем текущую секцию
          const sec = state.mpSection || state.masterTab;
          if (sec === 'dayView' && state.calendarSelectedDate) {
            await loadMpDayBookings(state.calendarSelectedDate);
            // calendarMonth может быть null если попали в dayView не через календарь
            const cm = state.calendarMonth || new Date(state.calendarSelectedDate + 'T00:00:00');
            state.calendarMonth = cm;
            await loadCalendarMonthBookings(cm.getFullYear(), cm.getMonth());
          } else {
            await loadMpTodayBookings();
          }
          state.currentScreen = '_refresh';
          navigateTo('masterPanel', false);
        } catch (err) {
          alert('Ошибка: ' + (err.message || err));
          btn.disabled = false;
          btn.textContent = act === 'complete' ? '✅ Завершить' : act === 'cancel' ? '🚫 Отменить' : '📅 Перенести';
        }
      });
    });
  });
}

// --- Загрузить сегодняшние записи через JWT ---
async function loadMpTodayBookings() {
  try {
    const data = await authFetch('/api/v1/bookings/today');
    state.todayBookings = data.bookings || [];
    state.todayDate = data.date;
    return data;
  } catch (e) {
    console.error('loadMpTodayBookings:', e);
    state.todayBookings = [];
    return null;
  }
}

// --- M4 — Месячный календарь ---
function renderMpCalendar() {
  const now = state.calendarMonth || new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  const monthName = new Date(year, month, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
    .replace(/^./, c => c.toUpperCase());

  // Генерируем сетку
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  // Понедельник = 0
  let startDow = firstDay.getDay() - 1;
  if (startDow < 0) startDow = 6;

  const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const weekdaysHTML = weekdays.map(d => `<div class="mp-calendar-weekday">${d}</div>`).join('');

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const selectedDate = state.calendarSelectedDate;
  const datesWithBookings = state.calendarDatesWithBookings || {};

  let cellsHTML = '';
  // Пустые ячейки до первого числа
  for (let i = 0; i < startDow; i++) {
    cellsHTML += `<div class="mp-calendar-day other-month"></div>`;
  }
  for (let d = 1; d <= lastDay.getDate(); d++) {
    const dateObj = new Date(year, month, d);
    dateObj.setHours(0, 0, 0, 0);
    const dateKey = formatDateKey(dateObj);
    const isToday = dateObj.getTime() === today.getTime();
    const isSelected = dateKey === selectedDate && !isToday;
    const hasDot = datesWithBookings[dateKey];
    let cls = 'mp-calendar-day';
    if (isToday) cls += ' today';
    if (isSelected) cls += ' selected';
    cellsHTML += `
      <div class="${cls}" data-date="${dateKey}">
        ${d}
        ${hasDot ? `<span class="mp-calendar-dot"></span>` : ''}
      </div>`;
  }
  // Остаток строки
  const totalCells = startDow + lastDay.getDate();
  const remainder = totalCells % 7;
  if (remainder !== 0) {
    for (let i = 0; i < 7 - remainder; i++) {
      cellsHTML += `<div class="mp-calendar-day other-month"></div>`;
    }
  }

  return `
    <div class="mp-calendar">
      <div class="mp-calendar-nav">
        <button class="mp-calendar-nav-btn" id="mpCalPrev">‹</button>
        <div class="mp-calendar-month-title">${escapeHtml(monthName)}</div>
        <button class="mp-calendar-nav-btn" id="mpCalNext">›</button>
      </div>
      <div class="mp-calendar-grid">
        ${weekdaysHTML}
        ${cellsHTML}
      </div>
    </div>
    ${selectedDate ? `<div id="mpDayViewInline"></div>` : ''}
  `;
}

// --- Загрузить даты с записями для текущего месяца ---
async function loadCalendarMonthBookings(year, month) {
  try {
    const from = `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const lastD = new Date(year, month + 1, 0).getDate();
    const to = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastD).padStart(2, '0')}`;
    const data = await API.fetch('bookings',
      `master_id=eq.${CURRENT_MASTER_ID}&date=gte.${from}&date=lte.${to}&status=in.(confirmed,pending,completed)&select=date`
    );
    const map = {};
    if (data) data.forEach(b => { map[String(b.date).slice(0, 10)] = true; });
    state.calendarDatesWithBookings = map;
  } catch (e) {
    console.error('loadCalendarMonthBookings:', e);
    state.calendarDatesWithBookings = {};
  }
}

// --- M5 — Экран "Запись дня" ---
function renderMpDayView() {
  const date = state.calendarSelectedDate;
  if (!date) return '';
  const bookings = state.dayViewBookings;
  const summary = state.dayViewSummary;

  const dateObj = new Date(date + 'T00:00:00');
  const dateFmt = dateObj.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })
    .replace(/^./, c => c.toUpperCase());

  let bodyHTML;
  if (!bookings) {
    bodyHTML = `<div class="mp-empty-state"><div class="mp-empty-icon">⏳</div><div class="mp-empty-title">Загрузка...</div></div>`;
  } else if (bookings.length === 0) {
    bodyHTML = `
      <div class="mp-empty-state">
        <div class="mp-empty-icon">📅</div>
        <div class="mp-empty-title">Записей нет</div>
        <div class="mp-empty-hint">В этот день нет записей</div>
      </div>`;
  } else {
    bodyHTML = bookings.map(b => renderMpBookingCard(b)).join('');
  }

  const count = summary ? summary.total_count : (bookings ? bookings.length : 0);
  const amount = summary ? summary.total_amount : (bookings ? bookings.reduce((s, b) => s + (b.price || 0), 0) : 0);

  return `
    <div class="mp-day-screen-header">
      <button class="back-btn" id="mpDayBackBtn">← Назад</button>
      <div class="date-title">${escapeHtml(dateFmt)}</div>
      <div class="day-stats">
        <span class="count">${count} ${pluralBookings(count)}</span>
        &nbsp;·&nbsp;
        <span class="amount">${(amount || 0).toLocaleString('ru-RU')} ₽</span>
      </div>
    </div>
    ${bodyHTML}
  `;
}

// --- Загрузить записи конкретного дня ---
async function loadMpDayBookings(date) {
  try {
    const data = await authFetch('/api/v1/bookings/by-date?date=' + date);
    state.dayViewBookings = data.bookings || [];
    state.dayViewSummary = data.summary || null;
    return data;
  } catch (e) {
    console.error('loadMpDayBookings:', e);
    state.dayViewBookings = [];
    state.dayViewSummary = null;
    return null;
  }
}

// --- M2 — Wizard "Новая запись" ---
// Состояние wizard
const wizardState = {
  step: 1,
  client: null,       // { name, phone } или null (будет заполнено на шаге 1)
  service: null,      // объект услуги
  date: null,         // 'YYYY-MM-DD'
  time: null,         // 'HH:MM'
  clientSearch: '',
  clientSearchResults: [],
  showNewClientForm: false,
  newClientName: '',
  newClientPhone: '',
  slotsBusy: [],
  slotsAll: [],
};

function renderMpWizard() {
  const step = wizardState.step;
  const totalSteps = 5;
  const fillPct = Math.round((step / totalSteps) * 100);

  const stepTitles = ['Клиент', 'Услуга', 'Дата', 'Время', 'Подтверждение'];

  let stepHTML = '';
  switch (step) {
    case 1: stepHTML = renderWizardStepClient(); break;
    case 2: stepHTML = renderWizardStepService(); break;
    case 3: stepHTML = renderWizardStepDate(); break;
    case 4: stepHTML = renderWizardStepTime(); break;
    case 5: stepHTML = renderWizardStepConfirm(); break;
  }

  const prevDisabled = step === 1;
  const nextLabel = step === totalSteps ? 'Записать' : 'Далее';

  return `
    <div class="mp-wizard-screen" id="mpWizardScreen">
      <div class="mp-wizard-header">
        <button class="mp-burger-btn" id="wizardBackBtn">←</button>
        <div class="mp-wizard-header-title">Новая запись</div>
      </div>
      <div class="mp-wizard-progress">
        <div class="mp-wizard-progress-fill" style="width:${fillPct}%"></div>
      </div>
      <div class="mp-wizard-step-label">Шаг ${step} из ${totalSteps} — ${stepTitles[step - 1]}</div>
      <div class="mp-wizard-content" id="wizardContent">
        ${stepHTML}
      </div>
      <div class="mp-wizard-nav">
        <button class="mp-btn-secondary" id="wizardPrevBtn" ${prevDisabled ? 'style="opacity:0.4"' : ''}>Назад</button>
        <button class="mp-btn-primary" id="wizardNextBtn">${nextLabel}</button>
      </div>
    </div>
  `;
}

function renderWizardStepClient() {
  const results = wizardState.clientSearchResults || [];
  const resultsHTML = results.length
    ? results.map(c => `
        <div class="mp-client-result-item" data-client-id="${escapeHtml(c.id || '')}">
          ${escapeHtml(c.first_name || c.name || 'Клиент')}
          <span class="meta">${escapeHtml(c.phone || '')}</span>
        </div>`).join('')
    : (wizardState.clientSearch.length >= 2 ? '<div style="padding:12px 16px;font-size:14px;color:var(--tg-theme-hint-color,#999)">Не найдено</div>' : '');

  const selectedHTML = wizardState.client
    ? `<div style="background:#e8f5e9;border-radius:12px;padding:12px 16px;margin-bottom:12px;font-size:15px;font-weight:600;color:#2e7d32">
        ✓ ${escapeHtml(wizardState.client.name)} ${escapeHtml(wizardState.client.phone || '')}
        <button id="wizardClientClear" style="float:right;background:none;border:none;color:#999;cursor:pointer;font-size:16px;">✕</button>
       </div>`
    : '';

  const newClientFormHTML = wizardState.showNewClientForm
    ? `<div class="mp-new-client-form">
        <label class="mp-form-label">Имя</label>
        <input class="mp-form-input" id="wizardNewName" placeholder="Имя клиента" value="${escapeHtml(wizardState.newClientName)}">
        <label class="mp-form-label">Телефон</label>
        <input class="mp-form-input" id="wizardNewPhone" type="tel" placeholder="+7 (___) ___-__-__" value="${escapeHtml(wizardState.newClientPhone)}">
       </div>`
    : `<button class="mp-btn-secondary" id="wizardShowNewClient" style="width:100%;margin-top:4px;">+ Новый клиент</button>`;

  return `
    ${selectedHTML}
    ${!wizardState.client ? `
      <input class="mp-search-input" id="wizardClientSearch" placeholder="🔍 Имя или телефон..." value="${escapeHtml(wizardState.clientSearch)}">
      ${results.length || wizardState.clientSearch.length >= 2 ? `<div class="mp-client-search-results">${resultsHTML}</div>` : ''}
      <div class="mp-wizard-divider">или</div>
    ` : ''}
    ${!wizardState.client ? newClientFormHTML : ''}
  `;
}

function renderWizardStepService() {
  const services = state.masterServices || [];
  if (!services.length) {
    return '<div style="padding:16px;color:var(--tg-theme-hint-color,#999)">Нет услуг. Добавьте услуги в разделе «Услуги».</div>';
  }
  return services.map(s => `
    <div class="mp-service-select-item${wizardState.service && wizardState.service.id === s.id ? ' selected' : ''}" data-service-id="${escapeHtml(String(s.id))}">
      <div>
        <div class="name">${escapeHtml(s.name)}</div>
        <div class="meta">${s.duration} мин · ${(s.price || 0).toLocaleString('ru-RU')} ₽</div>
      </div>
      <div class="checkmark">${wizardState.service && wizardState.service.id === s.id ? '✓' : ''}</div>
    </div>`).join('');
}

function renderWizardStepDate() {
  // Используем mp-calendar с ограничениями: min = завтра, max = сегодня + 30
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + 30);

  const now = state.wizardCalendarMonth || tomorrow;
  const year = now.getFullYear();
  const month = now.getMonth();
  const monthName = new Date(year, month, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
    .replace(/^./, c => c.toUpperCase());

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  let startDow = firstDay.getDay() - 1;
  if (startDow < 0) startDow = 6;

  const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const weekdaysHTML = weekdays.map(d => `<div class="mp-calendar-weekday">${d}</div>`).join('');

  let cellsHTML = '';
  for (let i = 0; i < startDow; i++) {
    cellsHTML += `<div class="mp-calendar-day other-month"></div>`;
  }
  for (let d = 1; d <= lastDay.getDate(); d++) {
    const dateObj = new Date(year, month, d);
    dateObj.setHours(0, 0, 0, 0);
    const dateKey = formatDateKey(dateObj);
    const isDisabled = dateObj < tomorrow || dateObj > maxDate;
    const isSelected = dateKey === wizardState.date;
    let cls = 'mp-calendar-day';
    if (isDisabled) cls += ' disabled';
    if (isSelected) cls += ' selected';
    cellsHTML += `<div class="${cls}" data-wizard-date="${dateKey}">${d}</div>`;
  }
  const totalCells = startDow + lastDay.getDate();
  const remainder = totalCells % 7;
  if (remainder !== 0) {
    for (let i = 0; i < 7 - remainder; i++) {
      cellsHTML += `<div class="mp-calendar-day other-month"></div>`;
    }
  }

  return `
    <div class="mp-calendar">
      <div class="mp-calendar-nav">
        <button class="mp-calendar-nav-btn" id="wizardCalPrev">‹</button>
        <div class="mp-calendar-month-title">${escapeHtml(monthName)}</div>
        <button class="mp-calendar-nav-btn" id="wizardCalNext">›</button>
      </div>
      <div class="mp-calendar-grid">
        ${weekdaysHTML}
        ${cellsHTML}
      </div>
    </div>
    ${wizardState.date ? `<div style="padding:8px 0;font-size:14px;color:var(--tg-theme-button-color,#007AFF);font-weight:600;">Выбрано: ${wizardState.date}</div>` : ''}
  `;
}

function renderWizardStepTime() {
  const slots = wizardState.slotsAll || [];
  const busy = wizardState.slotsBusy || [];
  if (!wizardState.date) {
    return '<div style="color:var(--tg-theme-hint-color,#999)">Сначала выберите дату</div>';
  }
  if (slots.length === 0) {
    return '<div style="color:var(--tg-theme-hint-color,#999)">Нет доступных слотов на эту дату</div>';
  }
  const slotsHTML = slots.map(t => {
    const isBusy = busy.includes(t);
    const isSelected = wizardState.time === t;
    let cls = 'mp-slot';
    if (isBusy) cls += ' busy';
    else if (isSelected) cls += ' selected';
    return `<button class="${cls}" data-time="${escapeHtml(t)}">${escapeHtml(t)}</button>`;
  }).join('');
  return `<div class="mp-slots-grid">${slotsHTML}</div>`;
}

function renderWizardStepConfirm() {
  const c = wizardState.client || {};
  const s = wizardState.service || {};
  return `
    <div class="mp-summary-card">
      <div class="mp-summary-row"><span class="label">Клиент</span><span class="value">${escapeHtml(c.name || '—')}</span></div>
      <div class="mp-summary-row"><span class="label">Телефон</span><span class="value">${escapeHtml(c.phone || '—')}</span></div>
      <div class="mp-summary-row"><span class="label">Услуга</span><span class="value">${escapeHtml(s.name || '—')}</span></div>
      <div class="mp-summary-row"><span class="label">Дата</span><span class="value">${escapeHtml(wizardState.date || '—')}</span></div>
      <div class="mp-summary-row"><span class="label">Время</span><span class="value">${escapeHtml(wizardState.time || '—')}</span></div>
      <div class="mp-summary-row"><span class="label">Стоимость</span><span class="value">${s.price ? s.price.toLocaleString('ru-RU') + ' ₽' : '—'}</span></div>
      <div class="mp-summary-row"><span class="label">Длительность</span><span class="value">${s.duration ? s.duration + ' мин' : '—'}</span></div>
    </div>
  `;
}

// --- Привязка событий wizard ---
function bindWizardEvents(container) {
  // Кнопка назад из wizard
  container.querySelector('#wizardBackBtn')?.addEventListener('click', () => {
    if (wizardState.step > 1) {
      wizardState.step--;
      refreshWizardContent(container);
    } else {
      state.mpSection = 'bookings';
      state.masterTab = 'bookings';
      state.currentScreen = '_refresh';
      navigateTo('masterPanel', false);
    }
  });

  // Кнопка "Назад" в nav
  container.querySelector('#wizardPrevBtn')?.addEventListener('click', () => {
    if (wizardState.step > 1) {
      wizardState.step--;
      refreshWizardContent(container);
    }
  });

  // Кнопка "Далее" / "Записать"
  container.querySelector('#wizardNextBtn')?.addEventListener('click', async () => {
    await wizardNext(container);
  });

  bindWizardStepEvents(container);
}

function refreshWizardContent(container) {
  const content = container.querySelector('#wizardContent');
  if (!content) return;
  const step = wizardState.step;
  switch (step) {
    case 1: content.innerHTML = renderWizardStepClient(); break;
    case 2: content.innerHTML = renderWizardStepService(); break;
    case 3: content.innerHTML = renderWizardStepDate(); break;
    case 4: content.innerHTML = renderWizardStepTime(); break;
    case 5: content.innerHTML = renderWizardStepConfirm(); break;
  }
  // Обновляем прогресс
  const fill = container.querySelector('.mp-wizard-progress-fill');
  if (fill) fill.style.width = Math.round((step / 5) * 100) + '%';
  const label = container.querySelector('.mp-wizard-step-label');
  const titles = ['Клиент', 'Услуга', 'Дата', 'Время', 'Подтверждение'];
  if (label) label.textContent = 'Шаг ' + step + ' из 5 — ' + titles[step - 1];
  // Кнопки
  const nextBtn = container.querySelector('#wizardNextBtn');
  if (nextBtn) nextBtn.textContent = step === 5 ? 'Записать' : 'Далее';
  const prevBtn = container.querySelector('#wizardPrevBtn');
  if (prevBtn) prevBtn.style.opacity = step === 1 ? '0.4' : '1';
  bindWizardStepEvents(container);
}

function bindWizardStepEvents(container) {
  const step = wizardState.step;

  if (step === 1) {
    // Поиск клиента
    const searchInput = container.querySelector('#wizardClientSearch');
    if (searchInput) {
      searchInput.addEventListener('input', async () => {
        wizardState.clientSearch = searchInput.value;
        if (searchInput.value.length >= 2) {
          const results = await API.fetch('clients',
            `master_id=eq.${CURRENT_MASTER_ID}&or=(first_name.ilike.*${encodeURIComponent(searchInput.value)}*,phone.ilike.*${encodeURIComponent(searchInput.value)}*)&limit=10`
          );
          wizardState.clientSearchResults = results || [];
        } else {
          wizardState.clientSearchResults = [];
        }
        const content = container.querySelector('#wizardContent');
        if (content) content.innerHTML = renderWizardStepClient();
        bindWizardStepEvents(container);
      });
    }

    // Выбрать клиента из результатов
    container.querySelectorAll('.mp-client-result-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.clientId;
        const found = (wizardState.clientSearchResults || []).find(c => String(c.id) === id);
        if (found) {
          wizardState.client = {
            id: found.id,
            name: found.first_name || found.name || 'Клиент',
            phone: found.phone || '',
          };
        }
        const content = container.querySelector('#wizardContent');
        if (content) content.innerHTML = renderWizardStepClient();
        bindWizardStepEvents(container);
      });
    });

    // Очистить выбранного клиента
    container.querySelector('#wizardClientClear')?.addEventListener('click', () => {
      wizardState.client = null;
      wizardState.clientSearch = '';
      wizardState.clientSearchResults = [];
      const content = container.querySelector('#wizardContent');
      if (content) content.innerHTML = renderWizardStepClient();
      bindWizardStepEvents(container);
    });

    // Показать форму нового клиента
    container.querySelector('#wizardShowNewClient')?.addEventListener('click', () => {
      wizardState.showNewClientForm = true;
      const content = container.querySelector('#wizardContent');
      if (content) content.innerHTML = renderWizardStepClient();
      bindWizardStepEvents(container);
    });

    // Сохранение полей нового клиента при вводе
    container.querySelector('#wizardNewName')?.addEventListener('input', e => {
      wizardState.newClientName = e.target.value;
    });
    container.querySelector('#wizardNewPhone')?.addEventListener('input', e => {
      wizardState.newClientPhone = e.target.value;
    });
  }

  if (step === 2) {
    container.querySelectorAll('.mp-service-select-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.serviceId;
        const svc = (state.masterServices || []).find(s => String(s.id) === id);
        wizardState.service = svc || null;
        const content = container.querySelector('#wizardContent');
        if (content) content.innerHTML = renderWizardStepService();
        bindWizardStepEvents(container);
      });
    });
  }

  if (step === 3) {
    // Навигация месяца
    container.querySelector('#wizardCalPrev')?.addEventListener('click', () => {
      const m = state.wizardCalendarMonth || new Date();
      const prev = new Date(m.getFullYear(), m.getMonth() - 1, 1);
      state.wizardCalendarMonth = prev;
      const content = container.querySelector('#wizardContent');
      if (content) content.innerHTML = renderWizardStepDate();
      bindWizardStepEvents(container);
    });
    container.querySelector('#wizardCalNext')?.addEventListener('click', () => {
      const m = state.wizardCalendarMonth || new Date();
      const next = new Date(m.getFullYear(), m.getMonth() + 1, 1);
      state.wizardCalendarMonth = next;
      const content = container.querySelector('#wizardContent');
      if (content) content.innerHTML = renderWizardStepDate();
      bindWizardStepEvents(container);
    });
    container.querySelectorAll('.mp-calendar-day[data-wizard-date]').forEach(cell => {
      cell.addEventListener('click', () => {
        wizardState.date = cell.dataset.wizardDate;
        wizardState.time = null;
        const content = container.querySelector('#wizardContent');
        if (content) content.innerHTML = renderWizardStepDate();
        bindWizardStepEvents(container);
      });
    });
  }

  if (step === 4) {
    container.querySelectorAll('.mp-slot:not(.busy)').forEach(btn => {
      btn.addEventListener('click', () => {
        wizardState.time = btn.dataset.time;
        const content = container.querySelector('#wizardContent');
        if (content) content.innerHTML = renderWizardStepTime();
        bindWizardStepEvents(container);
      });
    });
  }
}

async function wizardNext(container) {
  const step = wizardState.step;
  const nextBtn = container.querySelector('#wizardNextBtn');

  if (step === 1) {
    // Если показана форма нового клиента — используем введённые данные
    if (wizardState.showNewClientForm) {
      const name = (container.querySelector('#wizardNewName')?.value || wizardState.newClientName).trim();
      const phone = (container.querySelector('#wizardNewPhone')?.value || wizardState.newClientPhone).trim();
      if (!name) { showToast('Введите имя клиента'); return; }
      wizardState.client = { name, phone };
      wizardState.showNewClientForm = false;
    }
    if (!wizardState.client) { showToast('Выберите или добавьте клиента'); return; }
    // Загружаем услуги если ещё не загружены
    if (!state.masterServices || !state.masterServices.length) {
      await loadMasterTabData('services');
    }
    wizardState.step = 2;
    refreshWizardContent(container);
    return;
  }

  if (step === 2) {
    if (!wizardState.service) { showToast('Выберите услугу'); return; }
    // Инициализируем месяц для шага 3 — завтра
    if (!state.wizardCalendarMonth) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      state.wizardCalendarMonth = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), 1);
    }
    wizardState.step = 3;
    refreshWizardContent(container);
    return;
  }

  if (step === 3) {
    if (!wizardState.date) { showToast('Выберите дату'); return; }
    // Загружаем занятые слоты для шага 4
    nextBtn && (nextBtn.disabled = true);
    try {
      const data = await loadMpDayBookings(wizardState.date);
      const booked = (data ? data.bookings || [] : []).map(b => b.time ? b.time.substring(0, 5) : '');
      wizardState.slotsBusy = booked;
      // Генерируем слоты из расписания мастера
      const schedRows = state.masterSchedule || await loadAllSchedule(CURRENT_MASTER_ID) || [];
      state.masterSchedule = schedRows;
      const dateObj = new Date(wizardState.date + 'T00:00:00');
      const dow = dateObj.getDay();
      const row = schedRows.find(r => r.day_of_week === dow && r.is_active);
      if (row) {
        wizardState.slotsAll = generateTimeSlots(row.start_time.substring(0, 5), row.end_time.substring(0, 5), row.slot_interval || 30);
      } else {
        wizardState.slotsAll = generateTimeSlots('09:00', '20:00', 30);
      }
    } catch (e) {
      wizardState.slotsBusy = [];
      wizardState.slotsAll = generateTimeSlots('09:00', '20:00', 30);
    } finally {
      if (nextBtn) nextBtn.disabled = false;
    }
    wizardState.step = 4;
    refreshWizardContent(container);
    return;
  }

  if (step === 4) {
    if (!wizardState.time) { showToast('Выберите время'); return; }
    wizardState.step = 5;
    refreshWizardContent(container);
    return;
  }

  if (step === 5) {
    // Отправляем запись
    if (nextBtn) { nextBtn.disabled = true; nextBtn.textContent = 'Сохранение...'; }
    try {
      const body = {
        service_id: wizardState.service.id,
        date: wizardState.date,
        time: wizardState.time,
        client_name: wizardState.client.name,
        client_phone: wizardState.client.phone || '',
        price: wizardState.service.price || 0,
        duration: wizardState.service.duration || 60,
        notes: '',
      };
      await authFetch('/api/v1/bookings/manual', { method: 'POST', body: JSON.stringify(body) });
      showToast('Запись создана');
      // Сброс wizard
      Object.assign(wizardState, { step: 1, client: null, service: null, date: null, time: null,
        clientSearch: '', clientSearchResults: [], showNewClientForm: false,
        newClientName: '', newClientPhone: '', slotsBusy: [], slotsAll: [] });
      state.wizardCalendarMonth = null;
      // Возврат на M3 с обновлением
      state.mpSection = 'bookings';
      state.masterTab = 'bookings';
      await loadMpTodayBookings();
      state.currentScreen = '_refresh';
      navigateTo('masterPanel', false);
    } catch (e) {
      showToast('Ошибка: ' + e.message);
      if (nextBtn) { nextBtn.disabled = false; nextBtn.textContent = 'Записать'; }
    }
  }
}

// --- C1 — История бонусов клиента (через JWT) ---
async function loadBonusHistoryJwt() {
  try {
    const data = await authFetch('/api/v1/bonuses/history?limit=50&offset=0');
    return data;
  } catch (e) {
    console.error('loadBonusHistoryJwt:', e);
    return null;
  }
}

function renderBonusNew() {
  const data = state.bonusHistoryData;
  const loading = state.bonusHistoryLoading;

  if (loading) {
    return `
      <div class="history-screen" style="padding:16px;">
        <div class="cl-bonus-hero">
          <div class="cl-bonus-hero-amount">…</div>
          <div class="cl-bonus-hero-label">бонусов</div>
          <div class="cl-bonus-hero-hint">1 бонус = 1 ₽ скидки</div>
        </div>
        <div class="mp-empty-state"><div class="mp-empty-icon">⏳</div><div class="mp-empty-title">Загрузка...</div></div>
      </div>`;
  }

  const balance = data ? data.balance : (CLIENT_BONUS || 0);
  const transactions = data ? (data.transactions || []) : [];

  let listHTML;
  if (transactions.length === 0) {
    listHTML = `
      <div class="mp-empty-state" style="padding:32px 16px;">
        <div class="mp-empty-icon" style="font-size:48px;">💎</div>
        <div class="mp-empty-title" style="font-size:18px;">Бонусных операций пока нет</div>
        <div class="mp-empty-hint" style="font-size:14px;">Приходите на визит — бонусы начислятся автоматически</div>
      </div>`;
  } else {
    const itemsHTML = transactions.map(t => {
      const isPlus = t.type === 'credit';
      const sign = isPlus ? '+' : '−';
      const amountStr = sign + ' ' + Math.abs(t.amount).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ₽';
      const dateStr = t.created_at ? new Date(t.created_at).toLocaleDateString('ru-RU') : '';
      const meta = [dateStr, t.service_name].filter(Boolean).join(' · ');
      return `
        <div class="cl-bonus-item">
          <span class="cl-bonus-amount ${isPlus ? 'plus' : 'minus'}">${amountStr}</span>
          <div class="cl-bonus-details">
            <div class="title">${escapeHtml(t.description || (isPlus ? 'Начислено' : 'Списано'))}</div>
            ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ''}
          </div>
        </div>`;
    }).join('');
    listHTML = `
      <div class="cl-bonus-section-title">История</div>
      <div class="cl-bonus-list">${itemsHTML}</div>`;
  }

  return `
    <div class="history-screen" style="padding:16px;">
      <div class="cl-bonus-hero">
        <div class="cl-bonus-hero-amount">${balance.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽</div>
        <div class="cl-bonus-hero-label">бонусов</div>
        <div class="cl-bonus-hero-hint">1 бонус = 1 ₽ скидки</div>
      </div>
      ${listHTML}
    </div>`;
}

async function initBonusScreen() {
  const auth = typeof getStoredAuth === 'function' ? getStoredAuth() : null;
  const role = typeof getAuthRole === 'function' ? getAuthRole() : 'client';
  // Используем новый экран только для авторизованных клиентов
  if (!auth || role !== 'client') return false;
  state.bonusHistoryLoading = true;
  state.bonusHistoryData = null;
  const app = document.getElementById('app');
  if (app) app.innerHTML = renderBonusNew();
  const data = await loadBonusHistoryJwt();
  state.bonusHistoryLoading = false;
  state.bonusHistoryData = data;
  if (app && state.currentScreen === 'bonus') app.innerHTML = renderBonusNew();
  return true;
}

// --- C4 — Расширенный профиль мастера с полями карт ---
function renderMasterProfileNew() {
  const m = MASTER || {};
  // Читаем поля из MASTER (загружены при инициализации)
  const yandexMapsUrl = m.yandex_maps_url || '';
  const address = m.address || '';
  const studioName = m.studio_name || '';

  return `
    <div class="master-section-title">Профиль мастера</div>
    <div class="admin-form">
      <label class="admin-label">Фото мастера / салона</label>
      <div class="profile-photo-upload">
        ${m.avatar ? `<img src="${escapeHtml(m.avatar)}" class="profile-photo-preview" id="profilePhotoPreview">` : `<div class="profile-photo-placeholder" id="profilePhotoPreview">📷 Нажмите чтобы загрузить</div>`}
        <input type="file" id="profilePhotoInput" accept="image/*" style="display:none">
        <button class="admin-btn" id="profilePhotoBtn" style="margin-top:8px;">📷 ${m.avatar ? 'Изменить фото' : 'Загрузить фото'}</button>
      </div>

      <label class="admin-label">Название салона / имя мастера</label>
      <input type="text" id="profileName" class="admin-input" value="${(m.name || '').replace(/"/g, '&quot;')}" placeholder="Например: Студия Анны" />

      <label class="admin-label">Описание</label>
      <textarea id="profileDescription" class="admin-input admin-textarea" rows="3" placeholder="Краткое описание">${m.description || ''}</textarea>

      <label class="admin-label">Телефон</label>
      <input type="tel" id="profilePhone" class="admin-input" value="${(m.phone || '').replace(/"/g, '&quot;')}" placeholder="+7 (999) 123-45-67" />

      <label class="admin-label">WhatsApp</label>
      <input type="text" id="profileWhatsapp" class="admin-input" value="${(m.whatsapp_url || '').replace(/"/g, '&quot;')}" placeholder="https://wa.me/79991234567" />
      <div class="admin-form-hint" style="font-size:12px;color:var(--tg-theme-hint-color,#999);margin:4px 0 8px;">Формат: https://wa.me/79991234567</div>

      <label class="admin-label">Приветственное сообщение (в боте)</label>
      <textarea id="profileWelcome" class="admin-input admin-textarea" rows="2" placeholder="Текст при нажатии /start в боте">${m.welcome_text || ''}</textarea>

      <div style="display:flex;gap:12px;">
        <div style="flex:1;">
          <label class="admin-label">Кол-во работ</label>
          <input type="number" id="profileWorks" class="admin-input" value="${m.works_count || 0}" min="0" />
        </div>
        <div style="flex:1;">
          <label class="admin-label">Лет опыта</label>
          <input type="number" id="profileYears" class="admin-input" value="${m.years_experience || 0}" min="0" />
        </div>
      </div>

      <label class="admin-label">Код доступа к панели мастера</label>
      <input type="text" id="profileCode" class="admin-input" value="${(m.master_code || '').replace(/"/g, '&quot;')}" placeholder="4 цифры" maxlength="4" />
    </div>

    <div class="mp-settings-group">
      <div class="mp-settings-group-title">Контактная информация</div>
      <div class="mp-settings-field">
        <input type="url" name="yandex_maps_url" id="profileYandexMaps"
          placeholder="Ссылка на Яндекс.Карты"
          value="${(yandexMapsUrl).replace(/"/g, '&quot;')}">
        <div class="hint">Вставьте ссылку, чтобы клиенты получали маршрут в push-уведомлениях.</div>
      </div>
      <div class="mp-settings-field">
        <input type="text" name="address" id="profileAddress"
          placeholder="Адрес"
          value="${(address).replace(/"/g, '&quot;')}">
      </div>
      <div class="mp-settings-field">
        <input type="text" name="studio_name" id="profileStudioName"
          placeholder="Название студии"
          value="${(studioName).replace(/"/g, '&quot;')}">
      </div>
    </div>

    <button class="booking-confirm-btn" id="saveProfileBtn" style="margin:16px 0;">Сохранить профиль</button>
    <div id="profileResult" class="broadcast-result"></div>
  `;
}

// --- Привязка событий нового мастер-панели ---
function bindMasterPanelNewEvents(container) {
  // Бургер — открыть drawer
  container.querySelector('#mpBurgerBtn')?.addEventListener('click', () => {
    openMpDrawer();
    haptic('impact', 'light');
  });

  // Колокольчик в шапке — открывает панель уведомлений (новые записи и пр.)
  container.querySelector('#heroBell')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (typeof toggleNotificationPanel === 'function') toggleNotificationPanel();
  });
  if (typeof refreshNotifCount === 'function') refreshNotifCount();

  // Инит drawer
  initMpDrawer(container);

  // FAB → открыть wizard
  container.querySelector('#mpFabBtn')?.addEventListener('click', async () => {
    // Сбрасываем wizard
    Object.assign(wizardState, { step: 1, client: null, service: null, date: null, time: null,
      clientSearch: '', clientSearchResults: [], showNewClientForm: false,
      newClientName: '', newClientPhone: '', slotsBusy: [], slotsAll: [] });
    state.wizardCalendarMonth = null;
    if (!state.masterServices || !state.masterServices.length) {
      await loadMasterTabData('services');
    }
    state.mpSection = 'wizard';
    state.masterTab = 'wizard';
    state.currentScreen = '_refresh';
    navigateTo('masterPanel', false);
    haptic('impact', 'light');
  });

  const section = state.mpSection || state.masterTab || 'bookings';

  // Кнопки на карточках записей (today-feed). dayView получит свои в bindEvents ниже.
  if (section === 'bookings') {
    bindMpBookingActions(container);
  }

  // Обработчики wizard
  if (section === 'wizard') {
    bindWizardEvents(container);
    return;
  }

  // Навигация M4 (calendar)
  if (section === 'calendar') {
    container.querySelector('#mpCalPrev')?.addEventListener('click', async () => {
      const m = state.calendarMonth || new Date();
      state.calendarMonth = new Date(m.getFullYear(), m.getMonth() - 1, 1);
      await loadCalendarMonthBookings(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth());
      refreshMpContent(container);
    });
    container.querySelector('#mpCalNext')?.addEventListener('click', async () => {
      const m = state.calendarMonth || new Date();
      state.calendarMonth = new Date(m.getFullYear(), m.getMonth() + 1, 1);
      await loadCalendarMonthBookings(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth());
      refreshMpContent(container);
    });
    container.querySelectorAll('.mp-calendar-day[data-date]').forEach(cell => {
      cell.addEventListener('click', async () => {
        state.calendarSelectedDate = cell.dataset.date;
        state.dayViewBookings = null;
        state.dayViewSummary = null;
        state.mpSection = 'dayView';
        state.masterTab = 'dayView';
        await loadMpDayBookings(state.calendarSelectedDate);
        state.currentScreen = '_refresh';
        navigateTo('masterPanel', false);
      });
    });
  }

  // M5 — кнопка «Назад» в day view + кнопки на карточках записей
  if (section === 'dayView') {
    bindMpBookingActions(container);
    container.querySelector('#mpDayBackBtn')?.addEventListener('click', () => {
      state.mpSection = 'calendar';
      state.masterTab = 'calendar';
      state.currentScreen = '_refresh';
      navigateTo('masterPanel', false);
    });
    // FAB на day view → wizard с предустановленной датой
    container.querySelector('#mpFabBtn')?.addEventListener('click', async () => {
      Object.assign(wizardState, { step: 1, client: null, service: null,
        date: state.calendarSelectedDate, time: null,
        clientSearch: '', clientSearchResults: [], showNewClientForm: false,
        newClientName: '', newClientPhone: '', slotsBusy: [], slotsAll: [] });
      state.wizardCalendarMonth = null;
      if (!state.masterServices || !state.masterServices.length) {
        await loadMasterTabData('services');
      }
      state.mpSection = 'wizard';
      state.masterTab = 'wizard';
      state.currentScreen = '_refresh';
      navigateTo('masterPanel', false);
    });
  }

  // Профиль — расширенный saveProfileBtn
  if (section === 'profile') {
    const profilePhotoBtn = container.querySelector('#profilePhotoBtn');
    const profilePhotoInput = container.querySelector('#profilePhotoInput');
    if (profilePhotoBtn && profilePhotoInput) {
      profilePhotoBtn.addEventListener('click', () => profilePhotoInput.click());
      profilePhotoInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        profilePhotoBtn.disabled = true;
        profilePhotoBtn.textContent = '⏳ Загрузка...';
        try {
          const compressed = await (typeof compressImage === 'function' ? compressImage(file).catch(() => file) : file);
          const formData = new FormData();
          formData.append('file', compressed, file.name || 'photo.jpg');
          const auth = typeof getStoredAuth === 'function' ? getStoredAuth() : null;
          const headers = {};
          if (auth && auth.access_token) headers['Authorization'] = 'Bearer ' + auth.access_token;
          const resp = await fetch(API_BASE_URL + '/api/v1/upload/' + CURRENT_MASTER_ID, { method: 'POST', headers, body: formData });
          const data = await resp.json().catch(() => ({}));
          if (data.url) {
            await updateMaster(CURRENT_MASTER_ID, { avatar_url: data.url });
            MASTER.avatar = data.url;
            profilePhotoBtn.textContent = '✅ Фото загружено';
          } else {
            profilePhotoBtn.textContent = '❌ Ошибка';
          }
        } catch (err) {
          profilePhotoBtn.textContent = '❌ ' + err.message;
        }
        setTimeout(() => { profilePhotoBtn.disabled = false; profilePhotoBtn.textContent = '📷 Изменить фото'; }, 2000);
      });
    }

    const saveProfileBtn = container.querySelector('#saveProfileBtn');
    if (saveProfileBtn) {
      saveProfileBtn.addEventListener('click', async () => {
        const name = container.querySelector('#profileName')?.value.trim();
        if (!name) {
          const res = container.querySelector('#profileResult');
          if (res) { res.textContent = 'Название не может быть пустым'; res.style.color = '#c00'; }
          return;
        }
        saveProfileBtn.disabled = true;
        saveProfileBtn.textContent = 'Сохранение...';
        try {
          const data = {
            name,
            description: container.querySelector('#profileDescription')?.value.trim(),
            phone: container.querySelector('#profilePhone')?.value.trim(),
            whatsapp_url: container.querySelector('#profileWhatsapp')?.value.trim(),
            welcome_text: container.querySelector('#profileWelcome')?.value.trim(),
            works_count: parseInt(container.querySelector('#profileWorks')?.value || '0', 10) || 0,
            years_experience: parseInt(container.querySelector('#profileYears')?.value || '0', 10) || 0,
            yandex_maps_url: container.querySelector('#profileYandexMaps')?.value.trim(),
            address: container.querySelector('#profileAddress')?.value.trim(),
            studio_name: container.querySelector('#profileStudioName')?.value.trim(),
          };
          const master_code = container.querySelector('#profileCode')?.value.trim();
          if (master_code && master_code.length === 4) data.master_code = master_code;

          const result = await updateMaster(CURRENT_MASTER_ID, data);
          const res = container.querySelector('#profileResult');
          if (result) {
            Object.assign(MASTER, data);
            if (master_code && master_code.length === 4) MASTER_CODE = master_code;
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
    return;
  }

  // Старые обработчики admin-tab привязываются в bindEvents('masterPanel')
  // сразу ПОСЛЕ вызова bindMasterPanelNewEvents (см. case 'masterPanel' в bindEvents).
  // Дублирующий вызов здесь приводил к бесконечной рекурсии.
}

function refreshMpContent(container) {
  const content = container.querySelector('#mpPanelContent');
  if (!content) return;
  const section = state.mpSection || state.masterTab || 'bookings';
  switch (section) {
    case 'bookings':  content.innerHTML = renderMpTodayFeed(); break;
    case 'calendar':  content.innerHTML = renderMpCalendar(); break;
    case 'dayView':   content.innerHTML = renderMpDayView(); break;
    case 'services':  content.innerHTML = renderMasterServicesList(); break;
    case 'categories': content.innerHTML = renderMasterCategoriesList(); break;
    case 'schedule':  content.innerHTML = renderMasterSchedule(); break;
    case 'clients':   content.innerHTML = renderMasterClientsList(); break;
    case 'broadcast': content.innerHTML = renderBroadcastForm(); break;
    case 'profile':   content.innerHTML = renderMasterProfileNew(); break;
    case 'abonements': content.innerHTML = renderMasterAbonements(); break;
    case 'wizard':    content.innerHTML = renderMpWizard(); break;
    default: content.innerHTML = renderMpTodayFeed();
  }
  // Обновляем статус-бар
  if (section === 'bookings') {
    const sb = container.querySelector('.mp-status-bar');
    if (sb) {
      const bookings = state.todayBookings || [];
      const count = bookings.length;
      const amount = bookings.reduce((s, b) => s + (b.price || 0), 0);
      sb.innerHTML = `
        <span class="stat-bookings">${count} ${pluralBookings(count)}</span>
        <span style="color:var(--tg-theme-hint-color,#999)">·</span>
        <span class="stat-amount">${amount.toLocaleString('ru-RU')} ₽</span>`;
    }
  }
  bindMasterPanelNewEvents(container);
}
