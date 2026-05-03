// Service Worker — Beauty Platform PWA
const CACHE_NAME = 'beauty-v70';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/auth.js',
  '/styles.css',
  '/config.js',
  '/supabase-api.js',
  '/data.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// Install — cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch — network first for all, fallback to cache (offline)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API calls and external — skip SW
  if (url.pathname.startsWith('/api/') || url.hostname !== self.location.hostname) {
    return;
  }

  // Network first — всегда пытаемся получить свежую версию
  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => {
      // Офлайн — отдаём из кеша
      return caches.match(event.request).then((cached) => {
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});

// Push notifications
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Beauty Platform';
  const meta = data.data || {};
  // Actions для 24h reminder клиенту: подтвердить / отменить / перенести.
  // На iOS Safari кнопки видны только в установленной PWA (ограничение Apple).
  let actions;
  if (Array.isArray(meta.actions) && meta.actions.length) {
    const labels = { confirm: '✅ Подтвердить', cancel: '🚫 Отменить', reschedule: '📅 Перенести' };
    actions = meta.actions.slice(0, 3).map(a => ({ action: a, title: labels[a] || a }));
  }
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: meta.type || 'default',
    renotify: true,
    data: meta,
    ...(actions ? { actions } : {}),
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const action = event.action;
  let targetUrl = data.url || '/';
  // Кнопки 24h reminder ведут на специальные deep-link страницы клиента.
  if (action && data.booking_id) {
    targetUrl = `/?action=${encodeURIComponent(action)}&booking=${encodeURIComponent(data.booking_id)}`;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Если есть открытая вкладка приложения — фокусируем и передаём сообщение
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          client.postMessage({ type: 'PUSH_CLICK', data, action });
          return;
        }
      }
      // PWA не открыта — открываем url
      return clients.openWindow(targetUrl);
    })
  );
});
