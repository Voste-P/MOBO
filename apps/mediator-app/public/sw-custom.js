// Clear all caches when a new service worker activates (deploy = fresh code).
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(cacheNames.map((c) => caches.delete(c))))
      .then(() => self.clients.claim())
      .then(() =>
        self.clients.matchAll({ type: 'window' }).then((clients) => {
          clients.forEach((client) => client.postMessage({ type: 'SW_UPDATED' }));
        })
      )
  );
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'buzzma-background-sync') {
    event.waitUntil(Promise.resolve());
  }
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'buzzma-periodic-sync') {
    event.waitUntil(Promise.resolve());
  }
});

self.addEventListener('push', (event) => {
  const data = event.data?.json?.() || {};
  const title = data.title || 'BUZZMA Mediator';
  const options = {
    body: data.body || 'You have a new update.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: {
      url: data.url || '/',
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    })
  );
});
