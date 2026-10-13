// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pwaStore, registerServiceWorker, type SwContainer } from './pwa';

function fakeContainer(opts: {
  controller?: boolean;
  registerError?: Error;
  updateFails?: boolean;
}) {
  let onChange = () => {};
  const update = vi.fn(async () => {
    if (opts.updateFails) throw new Error('offline');
  });
  const register = vi.fn(async () => {
    if (opts.registerError) throw opts.registerError;
    return { update };
  });
  const container: SwContainer = {
    controller: opts.controller ? {} : null,
    register,
    addEventListener: (_t, l) => {
      onChange = l;
    },
  };
  return { container, register, update, takeOver: () => onChange() };
}

beforeEach(() => {
  pwaStore.reset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('registerServiceWorker', () => {
  it('registers sw.js under the base path', async () => {
    const f = fakeContainer({});
    await registerServiceWorker({ container: f.container, base: '/SPHR-Flashcards/' });
    expect(f.register).toHaveBeenCalledWith('/SPHR-Flashcards/sw.js', {
      scope: '/SPHR-Flashcards/',
    });
    expect(pwaStore.get()).toEqual({ updateReady: false, error: null });
  });

  it('the first install taking control is not an update', async () => {
    const f = fakeContainer({ controller: false });
    await registerServiceWorker({ container: f.container, base: '/x/' });
    f.takeOver();
    expect(pwaStore.get().updateReady).toBe(false);
    f.takeOver(); // ...but a later worker taking over the same page is
    expect(pwaStore.get().updateReady).toBe(true);
  });

  it('a new worker taking over a page that had one is an update', async () => {
    const f = fakeContainer({ controller: true });
    const seen = vi.fn();
    pwaStore.subscribe(seen);
    await registerServiceWorker({ container: f.container, base: '/x/' });
    f.takeOver();
    expect(pwaStore.get().updateReady).toBe(true);
    expect(seen).toHaveBeenCalled();
  });

  it('checks for a newer version when the app comes back to the front, and hourly', async () => {
    const f = fakeContainer({ updateFails: true });
    let visible = () => {};
    await registerServiceWorker({
      container: f.container,
      base: '/x/',
      onVisible: (cb) => {
        visible = cb;
      },
    });
    visible();
    expect(f.update).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    visible();
    expect(f.update).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(f.update).toHaveBeenCalledTimes(2);
    expect(pwaStore.get().error).toBeNull(); // a failed check is not shown; the next one retries
  });

  it('says so when registration fails', async () => {
    const f = fakeContainer({ registerError: new Error('blocked') });
    await registerServiceWorker({ container: f.container, base: '/x/' });
    expect(pwaStore.get().error).toBe('blocked');
  });

  it('says so when the browser has no service workers', async () => {
    await registerServiceWorker({ container: undefined });
    expect(pwaStore.get().error).toMatch(/cannot keep the app/);
  });

  it('unsubscribe stops notifications', () => {
    const l = vi.fn();
    pwaStore.subscribe(l)();
    pwaStore.reset();
    expect(l).not.toHaveBeenCalled();
  });
});
