// Service worker: שומר את מעטפת האפליקציה לטעינה מהירה, ומציג התראות פוש לבעלת העסק.
const CACHE = 'gel-v1';
const SHELL = ['/', '/index.html', '/app.css', '/js/app.js', '/js/ui.js', '/js/customer.js', '/js/owner.js',
  '/vendor/supabase.js', '/vendor/heebo-hebrew.woff2', '/vendor/heebo-latin.woff2', '/icons/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// קבצי האפליקציה: קודם מהרשת (כדי שעדכונים יגיעו מיד), ואם אין רשת — מהמטמון.
// בקשות למסד ולשרת לא נשמרות במטמון אף פעם.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html'))));
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'הודעה', body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'תור', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    lang: 'he',
    dir: 'rtl',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if ('focus' in c) {
        c.postMessage({ type: 'navigate', url });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
