// ============================================================
// Авторизация по телефону (SMS OTP) — для веб-версии (без Telegram)
// ============================================================

// --- Хранилище токенов ---

function getStoredAuth() {
  try {
    const data = localStorage.getItem('beauty_auth');
    return data ? JSON.parse(data) : null;
  } catch { return null; }
}

function saveAuth(data) {
  localStorage.setItem('beauty_auth', JSON.stringify(data));
}

function clearAuth() {
  localStorage.removeItem('beauty_auth');
}

// --- Проверка авторизации ---

function getWebUser() {
  const auth = getStoredAuth();
  if (!auth || !auth.access_token) return null;

  // Проверяем не истёк ли access_token (декодируем payload)
  try {
    const payload = JSON.parse(atob(auth.access_token.split('.')[1]));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      // Токен истёк — пробуем обновить
      return null; // refreshToken будет вызван при необходимости
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
      <div class="login-subtitle">Войдите, чтобы записаться на услуги</div>

      <div id="loginStep1">
        <div class="login-input-group">
          <label class="login-label">Номер телефона</label>
          <div class="login-phone-row">
            <span class="login-phone-prefix">+7</span>
            <input type="tel" id="loginPhone" class="login-input" placeholder="(___) ___-__-__" maxlength="15" autocomplete="tel" />
          </div>
        </div>
        <button class="login-btn" id="sendCodeBtn">Позвонить мне</button>
        <div id="loginError" class="login-error"></div>
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

  // Маска телефона
  if (loginPhone) {
    loginPhone.addEventListener('input', () => {
      let val = loginPhone.value.replace(/\D/g, '');
      if (val.length > 10) val = val.slice(0, 10);
      let formatted = '';
      if (val.length > 0) formatted += '(' + val.slice(0, 3);
      if (val.length >= 3) formatted += ') ' + val.slice(3, 6);
      if (val.length >= 6) formatted += '-' + val.slice(6, 8);
      if (val.length >= 8) formatted += '-' + val.slice(8, 10);
      loginPhone.value = formatted;
    });
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
