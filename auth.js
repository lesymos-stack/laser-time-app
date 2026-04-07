// ============================================================
// Авторизация по телефону (SMS OTP) — для веб-версии (без Telegram)
// ============================================================

// --- Хранилище токенов ---

function getStoredAuth() {
  try {
    const data = localStorage.getItem('beauty_auth');
    if (data) return JSON.parse(data);
    // Fallback: cookie (iOS PWA имеет изолированный localStorage)
    const match = document.cookie.match(/beauty_auth=([^;]+)/);
    if (match) {
      const cookieData = JSON.parse(decodeURIComponent(match[1]));
      // Восстанавливаем в localStorage
      localStorage.setItem('beauty_auth', JSON.stringify(cookieData));
      return cookieData;
    }
    return null;
  } catch { return null; }
}

function saveAuth(data) {
  localStorage.setItem('beauty_auth', JSON.stringify(data));
  // Cookie-бэкап для iOS PWA (localStorage изолирован в standalone режиме)
  try {
    document.cookie = 'beauty_auth=' + encodeURIComponent(JSON.stringify(data)) + ';path=/;max-age=' + (180 * 86400) + ';SameSite=Lax';
  } catch(e) {}
}

function clearAuth() {
  localStorage.removeItem('beauty_auth');
}

function getAuthRole() {
  const auth = getStoredAuth();
  return auth?.user?.role || 'client';
}

// --- Проверка авторизации ---

function getWebUser() {
  const auth = getStoredAuth();
  if (!auth || !auth.access_token) return null;

  try {
    const payload = JSON.parse(atob(auth.access_token.split('.')[1]));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      // Токен истёк — запускаем фоновый refresh (не блокируем)
      // Но всё равно возвращаем пользователя, чтобы не показывать экран логина
      if (auth.refresh_token) {
        refreshToken().catch(() => {});
      }
      // Возвращаем данные из payload — приложение будет работать,
      // а authFetch обновит токен при первом API-запросе
      return { id: payload.client_id, phone: payload.phone, name: auth.user?.name || '' };
    }
    return { id: payload.client_id, phone: payload.phone, name: auth.user?.name || '' };
  } catch {
    return null;
  }
}

// --- Обновление токена ---

async function refreshToken() {
  const auth = getStoredAuth();
  if (!auth || !auth.refresh_token) return false;

  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: auth.refresh_token }),
    });
    if (!res.ok) { clearAuth(); return false; }
    const data = await res.json();
    auth.access_token = data.access_token;
    saveAuth(auth);
    return true;
  } catch {
    return false;
  }
}

// --- API с авторизацией ---

async function authFetch(url, options = {}) {
  let auth = getStoredAuth();
  if (!auth) return null;

  options.headers = options.headers || {};
  options.headers['Authorization'] = `Bearer ${auth.access_token}`;

  let res = await fetch(url, options);

  // Если 401 — пробуем обновить токен
  if (res.status === 401) {
    const refreshed = await refreshToken();
    if (refreshed) {
      auth = getStoredAuth();
      options.headers['Authorization'] = `Bearer ${auth.access_token}`;
      res = await fetch(url, options);
    }
  }

  return res;
}

// --- Отправка OTP ---

async function sendOtp(phone) {
  const res = await fetch(`${API_BASE_URL}/api/v1/auth/send-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  return await res.json();
}

// --- Проверка OTP ---

async function verifyOtp(phone, code) {
  const res = await fetch(`${API_BASE_URL}/api/v1/auth/verify-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code }),
  });
  const data = await res.json();
  if (data.ok) {
    saveAuth(data);
  }
  return data;
}

// --- Выход ---

function logout() {
  clearAuth();
  location.reload();
}

// --- Рендер экрана логина ---

function renderLoginScreen() {
  return `
    <div class="login-screen">
      <div class="login-logo">💆‍♀️</div>
      <div class="login-title">Beauty Platform</div>

      <div id="clientLoginBlock">
        <div class="login-subtitle">Войдите, чтобы записаться на услуги</div>

        <div id="loginStep1">
          <div class="login-input-group">
            <label class="login-label">Ваше имя</label>
            <input type="text" id="loginName" class="login-input" placeholder="Как вас зовут?" maxlength="50" autocomplete="name" style="padding:14px 16px" />
          </div>
          <div class="login-input-group">
            <label class="login-label">Номер телефона</label>
            <div class="login-phone-row">
              <span class="login-phone-prefix">+7</span>
              <input type="tel" id="loginPhone" class="login-input" placeholder="(___) ___-__-__" maxlength="15" autocomplete="tel" />
            </div>
          </div>
          <button class="login-btn" id="sendCodeBtn">Позвонить мне</button>
          <div style="font-size:13px;color:#999;margin-top:8px;line-height:1.4">Вам поступит звонок. Введите 4 последние цифры входящего номера.</div>
          <div id="loginError" class="login-error"></div>
          <a href="/?page=master-login" style="display:block;text-align:center;margin-top:18px;font-size:14px;color:#2196F3;text-decoration:none;font-weight:500">Я мастер — войти с кодом</a>
        </div>

        <div id="loginStep2" style="display:none">
          <div class="login-hint">Вам звонят на <b id="loginPhoneDisplay"></b><br>Введите последние 4 цифры входящего номера</div>
          <div class="login-code-inputs" id="codeInputs">
            <input type="tel" class="login-code-digit" maxlength="1" data-idx="0" autocomplete="one-time-code" />
            <input type="tel" class="login-code-digit" maxlength="1" data-idx="1" />
            <input type="tel" class="login-code-digit" maxlength="1" data-idx="2" />
            <input type="tel" class="login-code-digit" maxlength="1" data-idx="3" />
          </div>
          <div id="verifyError" class="login-error"></div>
          <div class="login-resend" id="resendBlock">
            <span id="resendTimer"></span>
            <button class="login-resend-btn" id="resendBtn" style="display:none">Позвонить повторно</button>
          </div>
          <button class="login-back-link" id="changePhoneBtn">Изменить номер</button>
        </div>
      </div>
    </div>
  `;
}

// --- Рендер экрана входа мастера (отдельная страница) ---

function renderMasterLoginScreen() {
  return `
    <div class="login-screen">
      <div class="login-logo">💆‍♀️</div>
      <div class="login-title">Вход для мастера</div>

      <div id="masterLoginBlock">
        <div class="login-subtitle">Войдите по номеру телефона и коду доступа</div>
        <div class="login-input-group">
          <label class="login-label">Номер телефона</label>
          <div class="login-phone-row">
            <span class="login-phone-prefix">+7</span>
            <input type="tel" id="masterLoginPhone" class="login-input" placeholder="(___) ___-__-__" maxlength="15" />
          </div>
        </div>
        <div class="login-input-group" style="margin-top:12px">
          <label class="login-label">Код доступа</label>
          <input type="password" id="masterLoginCode" class="login-input" placeholder="Код из регистрации" maxlength="10" inputmode="numeric" style="padding:14px 16px" />
        </div>
        <button class="login-btn" id="masterLoginBtn2" style="margin-top:16px">Войти</button>
        <div id="masterLoginError" class="login-error"></div>
      </div>
    </div>
  `;
}

// --- Обработчики логин-экрана ---

function initLoginHandlers(onSuccess) {
  let currentPhone = '';
  let resendInterval = null;

  const sendCodeBtn = document.getElementById('sendCodeBtn');
  const loginPhone = document.getElementById('loginPhone');
  const loginError = document.getElementById('loginError');
  const step1 = document.getElementById('loginStep1');
  const step2 = document.getElementById('loginStep2');
  const phoneDisplay = document.getElementById('loginPhoneDisplay');
  const verifyError = document.getElementById('verifyError');
  const resendTimer = document.getElementById('resendTimer');
  const resendBtn = document.getElementById('resendBtn');
  const changePhoneBtn = document.getElementById('changePhoneBtn');
  const codeInputs = document.querySelectorAll('.login-code-digit');

  // Маска телефона с сохранением позиции курсора
  if (loginPhone) {
    loginPhone.addEventListener('input', () => {
      applyPhoneMask(loginPhone);
    });
  }

  function applyPhoneMask(input) {
    const raw = input.value.replace(/\D/g, '').slice(0, 10);
    const formatted = formatPhoneMask(raw);
    if (input.value !== formatted) {
      // Запоминаем сколько цифр было до курсора
      const cursorPos = input.selectionStart;
      const digitsBefore = input.value.slice(0, cursorPos).replace(/\D/g, '').length;
      input.value = formatted;
      // Восстанавливаем курсор по количеству цифр
      let newPos = 0;
      let count = 0;
      for (let i = 0; i < formatted.length && count < digitsBefore; i++) {
        newPos = i + 1;
        if (/\d/.test(formatted[i])) count++;
      }
      input.setSelectionRange(newPos, newPos);
    }
  }

  function formatPhoneMask(digits) {
    if (!digits) return '';
    let f = '(';
    f += digits.slice(0, 3);
    if (digits.length >= 3) f += ') ' + digits.slice(3, 6);
    if (digits.length >= 6) f += '-' + digits.slice(6, 8);
    if (digits.length >= 8) f += '-' + digits.slice(8, 10);
    return f;
  }

  // Отправка кода
  if (sendCodeBtn) {
    sendCodeBtn.addEventListener('click', async () => {
      const raw = loginPhone.value.replace(/\D/g, '');
      if (raw.length !== 10) {
        loginError.textContent = 'Введите 10 цифр номера';
        return;
      }
      currentPhone = '+7' + raw;
      sendCodeBtn.disabled = true;
      sendCodeBtn.textContent = 'Звоним...';
      loginError.textContent = '';

      const result = await sendOtp(currentPhone);
      sendCodeBtn.disabled = false;
      sendCodeBtn.textContent = 'Позвонить мне';

      if (result.error) {
        loginError.textContent = result.error;
        return;
      }

      // Показываем шаг 2
      step1.style.display = 'none';
      step2.style.display = 'block';
      phoneDisplay.textContent = currentPhone;
      codeInputs[0].focus();
      startResendTimer();
    });
  }

  // Ввод кода — автофокус
  codeInputs.forEach((input, idx) => {
    input.addEventListener('input', async () => {
      if (input.value.length === 1 && idx < 3) {
        codeInputs[idx + 1].focus();
      }
      // Автоотправка когда введены все 4 цифры
      const code = Array.from(codeInputs).map(i => i.value).join('');
      if (code.length === 4) {
        verifyError.textContent = '';
        codeInputs.forEach(i => { i.disabled = true; });

        const result = await verifyOtp(currentPhone, code);

        if (result.ok) {
          // Сохраняем имя и роль клиента в auth-данные
          const auth = getStoredAuth();
          if (auth) {
            if (!auth.user) auth.user = {};
            auth.user.role = 'client';
            const nameInput = document.getElementById('loginName');
            const clientName = nameInput ? nameInput.value.trim() : '';
            if (clientName) auth.user.name = clientName;
            saveAuth(auth);
          }
          onSuccess(result.user);
        } else {
          verifyError.textContent = result.error || 'Неверный код';
          codeInputs.forEach(i => { i.disabled = false; i.value = ''; });
          codeInputs[0].focus();
        }
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && idx > 0) {
        codeInputs[idx - 1].focus();
      }
    });
  });

  // Смена номера
  if (changePhoneBtn) {
    changePhoneBtn.addEventListener('click', () => {
      step1.style.display = 'block';
      step2.style.display = 'none';
      codeInputs.forEach(i => { i.value = ''; i.disabled = false; });
      if (resendInterval) clearInterval(resendInterval);
    });
  }

  // Повторная отправка
  if (resendBtn) {
    resendBtn.addEventListener('click', async () => {
      resendBtn.style.display = 'none';
      const result = await sendOtp(currentPhone);
      if (result.error) {
        verifyError.textContent = result.error;
      } else {
        verifyError.textContent = '';
        startResendTimer();
      }
    });
  }

  function startResendTimer() {
    let seconds = 60;
    resendTimer.textContent = `Повторная отправка через ${seconds} сек.`;
    resendBtn.style.display = 'none';
    if (resendInterval) clearInterval(resendInterval);
    resendInterval = setInterval(() => {
      seconds--;
      if (seconds <= 0) {
        clearInterval(resendInterval);
        resendTimer.textContent = '';
        resendBtn.style.display = 'inline';
      } else {
        resendTimer.textContent = `Повторная отправка через ${seconds} сек.`;
      }
    }, 1000);
  }

}

// --- Обработчики экрана входа мастера ---

function initMasterLoginHandlers(onSuccess) {
  // Маска телефона для мастера
  const masterPhone = document.getElementById('masterLoginPhone');
  if (masterPhone) {
    masterPhone.addEventListener('input', () => {
      applyPhoneMask(masterPhone);
    });
  }

  const masterBtn2 = document.getElementById('masterLoginBtn2');
  const masterCode2 = document.getElementById('masterLoginCode');
  const masterErr = document.getElementById('masterLoginError');

  if (masterBtn2 && masterCode2 && masterPhone) {
    const tryMasterLogin = async () => {
      const rawPhone = masterPhone.value.replace(/\D/g, '');
      const code = masterCode2.value.trim();
      if (rawPhone.length !== 10) {
        masterErr.textContent = 'Введите 10 цифр номера';
        return;
      }
      if (!code) {
        masterErr.textContent = 'Введите код доступа';
        return;
      }
      masterErr.textContent = '';
      masterBtn2.disabled = true;
      masterBtn2.textContent = 'Проверяем...';

      try {
        const phone = '+7' + rawPhone;
        const API = typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : '';
        const res = await fetch(`${API}/api/v1/auth/master-phone-login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, code }),
        });
        const data = await res.json();
        if (data.ok) {
          // Сохраняем роль мастера
          if (typeof saveAuth === 'function') {
            if (!data.user) data.user = {};
            data.user.role = 'master';
            saveAuth(data);
          }
          onSuccess(data.user || { phone, source: 'web' });
        } else {
          masterErr.textContent = data.error || 'Неверный телефон или код';
        }
      } catch(e) {
        masterErr.textContent = 'Ошибка соединения';
      }
      masterBtn2.disabled = false;
      masterBtn2.textContent = 'Войти';
    };
    masterBtn2.addEventListener('click', tryMasterLogin);
    masterCode2.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') tryMasterLogin();
    });
  }
}
