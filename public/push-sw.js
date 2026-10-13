// The daily reminder, inside the service worker (loaded by sw.js through importScripts;
// see vite.config.ts). Every push shows the same fixed notification: iOS requires a visible
// notification for each push, and nothing from the push message is ever displayed.
// Tapping the notification opens the app, or brings it to the front if it is already open.
// Tested by scripts/push-sw.test.mjs and e2e/pwa.spec.ts.
/* global self, clients */
'use strict';

const REMINDER_TITLE = 'SPHR Flashcards';
const REMINDER_BODY = 'You should practice some questions';

self.addEventListener('push', (event) => {
  const scope = self.registration.scope;
  event.waitUntil(
    self.registration.showNotification(REMINDER_TITLE, {
      body: REMINDER_BODY,
      icon: new URL('icons/icon-192.png', scope).href,
      badge: new URL('icons/icon-192.png', scope).href,
      tag: 'daily-reminder',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const scope = self.registration.scope;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((open) => {
      const app = open.find((c) => c.url.startsWith(scope));
      if (app) return app.focus();
      return clients.openWindow(scope);
    }),
  );
});
