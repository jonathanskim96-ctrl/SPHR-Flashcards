// The service worker's reminder handlers (public/push-sw.js), run in a fake worker scope.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../public/push-sw.js', import.meta.url), 'utf8');
// Objects made inside the worker's realm have their own prototypes; compare plain copies.
const plain = (v) => JSON.parse(JSON.stringify(v));
const SCOPE = 'https://jonathanskim96-ctrl.github.io/SPHR-Flashcards/';

function worker(windows = []) {
  const handlers = {};
  const shown = [];
  const opened = [];
  const self = {
    registration: {
      scope: SCOPE,
      showNotification: async (title, options) => void shown.push({ title, options }),
    },
    addEventListener: (type, fn) => (handlers[type] = fn),
  };
  const clients = {
    matchAll: async (opts) => {
      assert.deepEqual(plain(opts), { type: 'window', includeUncontrolled: true });
      return windows;
    },
    openWindow: async (url) => void opened.push(url),
  };
  vm.runInNewContext(SOURCE, { self, clients, URL });
  /** Fires an event and waits for what it passed to waitUntil. */
  const fire = async (type, extra = {}) => {
    let wait = Promise.resolve();
    handlers[type]({ ...extra, waitUntil: (p) => (wait = p) });
    await wait;
  };
  return { handlers, shown, opened, fire };
}

test('a push shows the fixed reminder, whatever the message says', async () => {
  const w = worker();
  const hostile = { text: () => '<img src=x onerror=alert(1)>', json: () => ({ title: 'x' }) };
  await w.fire('push', { data: hostile });
  await w.fire('push', { data: null });
  assert.equal(w.shown.length, 2);
  for (const n of w.shown) {
    assert.equal(n.title, 'SPHR Flashcards');
    assert.deepEqual(plain(n.options), {
      body: 'You should practice some questions',
      icon: `${SCOPE}icons/icon-192.png`,
      badge: `${SCOPE}icons/icon-192.png`,
      tag: 'daily-reminder',
    });
  }
});

test('tapping the notification brings an open app to the front', async () => {
  let focused = 0;
  let closed = 0;
  const other = { url: 'https://example.com/', focus: async () => assert.fail('wrong window') };
  const app = { url: `${SCOPE}#settings`, focus: async () => void focused++ };
  const w = worker([other, app]);
  await w.fire('notificationclick', { notification: { close: () => void closed++ } });
  assert.equal(closed, 1);
  assert.equal(focused, 1);
  assert.deepEqual(w.opened, []);
});

test('tapping the notification opens the app when it is not open', async () => {
  const w = worker([
    { url: 'https://example.com/', focus: async () => assert.fail('wrong window') },
  ]);
  await w.fire('notificationclick', { notification: { close() {} } });
  assert.deepEqual(w.opened, [SCOPE]);
});
