// @vitest-environment jsdom
// The daily reminder on screen (Phase 7): Settings switch, the one-time Home card, and the
// start-up refresh, with a fake iPhone (permission + PushManager) and the fake server.
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStore } from '../data/store';
import { harness } from '../../tests/uiHarness';
import { refreshProblem, timeLabel } from './reminder';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
beforeEach(() => localStorage.clear());

type User = ReturnType<typeof userEvent.setup>;
async function openSettings(user: User) {
  await user.click(await screen.findByRole('button', { name: 'Settings' }));
  await screen.findByRole('heading', { name: 'Settings' });
  return screen.getByRole('switch', { name: 'Remind me every day' }) as HTMLInputElement;
}
const offerCard = () => screen.queryByRole('region', { name: 'Daily reminder offer' });

describe('Settings: turning the reminder on', () => {
  it('asks for permission first, from the tap, then subscribes and saves on the server', async () => {
    const { user, browser, server } = await harness();
    const sw = await openSettings(user);
    await user.click(sw);
    await waitFor(() => expect(sw.checked).toBe(true));
    expect(browser.log.slice(0, 4)).toEqual([
      'requestPermission',
      'pushManager',
      'getSubscription',
      'subscribe true',
    ]);
    expect(server.pushCalls[0]).toBe('save https://web.push.apple.com/sub-1');
    expect(server.subscriptions.get('https://web.push.apple.com/sub-1')?.disabled).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("Don't Allow: stays off and shows how to allow notifications in iPhone Settings", async () => {
    const { user, server } = await harness({ answer: 'denied' });
    const sw = await openSettings(user);
    await user.click(sw);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Notifications are turned off for this app');
    expect(alert.textContent).toContain('Allow Notifications');
    expect(within(alert).getAllByRole('listitem')).toHaveLength(4);
    expect(sw.checked).toBe(false);
    expect(server.pushCalls).toEqual([]);
  });

  it('a permission asked earlier and refused: says so at once, without a prompt', async () => {
    const { user, browser } = await harness({ permission: 'denied', answer: 'denied' });
    const sw = await openSettings(user);
    await user.click(sw);
    expect((await screen.findByRole('alert')).textContent).toContain('Allow Notifications');
    expect(browser.log).toEqual(['requestPermission']);
    expect(sw.checked).toBe(false);
  });

  it('the prompt closed without an answer: stays off', async () => {
    const { user } = await harness({ answer: 'default' });
    const sw = await openSettings(user);
    await user.click(sw);
    expect((await screen.findByRole('alert')).textContent).toContain('were not allowed');
    expect(sw.checked).toBe(false);
  });

  it('no push on this phone, or no key configured: explains, stays off', async () => {
    const { user } = await harness({ permission: null });
    const sw = await openSettings(user);
    await user.click(sw);
    expect((await screen.findByRole('alert')).textContent).toContain('cannot show notifications');
    expect(sw.checked).toBe(false);
    cleanup();
    const second = await harness({ noVapidKey: true });
    const sw2 = await openSettings(second.user);
    await second.user.click(sw2);
    expect((await screen.findByRole('alert')).textContent).toContain('not set up yet');
    expect(sw2.checked).toBe(false);
  });

  it('offline: shows the error and stays off (try again when online)', async () => {
    const { user, server } = await harness();
    const sw = await openSettings(user);
    server.offline = true;
    await user.click(sw);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not turn on the reminder: Saving to the server failed',
    );
    expect(sw.checked).toBe(false);
  });

  it('the switch is disabled while the phone is asking', async () => {
    const { user, browser } = await harness();
    let answer: (p: 'granted') => void = () => {};
    browser.push.platform.requestPermission = () => new Promise((r) => (answer = r));
    const sw = await openSettings(user);
    await user.click(sw);
    expect(screen.getByText('Turning on the reminder…')).toBeTruthy();
    expect(sw.disabled).toBe(true);
    await act(async () => answer('granted'));
    await waitFor(() => expect(sw.checked).toBe(true));
    expect(sw.disabled).toBe(false);
  });

  it('a time chosen while it is turning on is kept (audit L6)', async () => {
    const { user, browser } = await harness();
    let answer: (p: 'granted') => void = () => {};
    browser.push.platform.requestPermission = () => new Promise((r) => (answer = r));
    const sw = await openSettings(user);
    await user.click(sw);
    await user.selectOptions(screen.getByRole('combobox'), '08:00');
    await waitFor(() =>
      expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('08:00'),
    );
    await act(async () => answer('granted'));
    await waitFor(() => expect(sw.checked).toBe(true));
    // Before the fix the switch saved the settings from the moment of the tap: back to 3 PM.
    await new Promise((r) => setTimeout(r, 100));
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('08:00');
  });
});

describe('Settings: turning the reminder off', () => {
  it('asks first, then saves off and disables this phone on the server', async () => {
    const { user, server } = await harness();
    const sw = await openSettings(user);
    await user.click(sw);
    await waitFor(() => expect(sw.checked).toBe(true));
    await user.click(sw);
    await user.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(sw.checked).toBe(false));
    await waitFor(() =>
      expect(server.pushCalls).toContain('disable https://web.push.apple.com/sub-1'),
    );
    expect(server.subscriptions.get('https://web.push.apple.com/sub-1')?.disabled).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offline: off on the phone at once, with a note that the server is told later', async () => {
    const { user, server } = await harness();
    const sw = await openSettings(user);
    await user.click(sw);
    await waitFor(() => expect(sw.checked).toBe(true));
    server.offline = true;
    await user.click(sw);
    await user.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(sw.checked).toBe(false));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'stops once your settings back up',
    );
  });
});

describe('Every app start (reminder on)', () => {
  it('re-saves the existing subscription without asking for permission', async () => {
    const { server, browser } = await harness({
      permission: 'granted',
      subscribed: true,
      serverSettings: { reminderEnabled: true },
    });
    await waitFor(() =>
      expect(server.pushCalls).toEqual(['save https://web.push.apple.com/earlier']),
    );
    expect(browser.log).not.toContain('requestPermission');
    expect(browser.log).not.toContain('subscribe true');
  });

  it('subscribes again when the old subscription expired', async () => {
    const { server, browser } = await harness({
      permission: 'granted',
      serverSettings: { reminderEnabled: true },
    });
    await waitFor(() =>
      expect(server.pushCalls).toEqual(['save https://web.push.apple.com/sub-1']),
    );
    expect(browser.log).not.toContain('requestPermission');
  });

  it('runs again when the app comes back to the front', async () => {
    const { server } = await harness({
      permission: 'granted',
      subscribed: true,
      serverSettings: { reminderEnabled: true },
    });
    await waitFor(() => expect(server.pushCalls).toHaveLength(1));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(server.pushCalls).toHaveLength(2));
  });

  it('does nothing while the reminder is off, or in a browser tab', async () => {
    const off = await harness({ permission: 'granted', subscribed: true });
    await screen.findByRole('button', { name: 'Settings' });
    expect(off.server.pushCalls).toEqual([]);
    cleanup();
    const tab = await harness({
      installed: false,
      permission: 'granted',
      subscribed: true,
      serverSettings: { reminderEnabled: true },
    });
    await screen.findByRole('button', { name: 'Settings' });
    expect(tab.server.pushCalls).toEqual([]);
    expect(tab.browser.log).toEqual([]);
  });

  it('on, but notifications are blocked on this phone: Settings says how to fix it', async () => {
    const { user } = await harness({
      permission: 'denied',
      serverSettings: { reminderEnabled: true },
    });
    const sw = await openSettings(user);
    expect(sw.checked).toBe(true);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('no reminder will arrive');
    expect(alert.textContent).toContain('Allow Notifications');
  });

  it('on, but never allowed on this phone (another device turned it on)', async () => {
    const { user } = await harness({ serverSettings: { reminderEnabled: true } });
    await openSettings(user);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Turn the reminder off and on again',
    );
  });

  it('a failed refresh is shown in Settings', async () => {
    const { user, browser } = await harness({
      permission: 'granted',
      serverSettings: { reminderEnabled: true },
    });
    browser.push.platform.pushManager = () => Promise.reject(new Error('no worker'));
    await openSettings(user);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect((await screen.findByRole('alert')).textContent).toContain('no worker');
  });
});

describe('Home: the one-time reminder card', () => {
  it('offers the reminder at its time; Turn on asks from the tap and turns it on', async () => {
    const { user, browser, server } = await harness();
    const card = await screen.findByRole('region', { name: 'Daily reminder offer' });
    expect(card.textContent).toContain('Turn on daily reminder (3:00 PM)?');
    await user.click(within(card).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(offerCard()).toBeNull());
    expect(browser.log[0]).toBe('requestPermission');
    expect(server.pushCalls[0]).toBe('save https://web.push.apple.com/sub-1');
    const sw = await openSettings(user);
    expect(sw.checked).toBe(true);
  });

  it('Not now hides it for good on this phone', async () => {
    const { user, browser } = await harness();
    const card = await screen.findByRole('region', { name: 'Daily reminder offer' });
    await user.click(within(card).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(offerCard()).toBeNull());
    expect(browser.log).toEqual([]);
    // Away and back: still gone.
    await openSettings(user);
    await user.click(screen.getByRole('button', { name: 'Back to Home' }));
    await screen.findByRole('button', { name: 'Start lesson' });
    expect(offerCard()).toBeNull();
  });

  it('Not now: a failed save is shown, not swallowed (audit L10)', async () => {
    const { user } = await harness();
    const card = await screen.findByRole('region', { name: 'Daily reminder offer' });
    vi.spyOn(LocalStore.prototype, 'setMeta').mockRejectedValueOnce(new Error('disk full'));
    await user.click(within(card).getByRole('button', { name: 'Not now' }));
    expect((await within(card).findByRole('alert')).textContent).toContain(
      'Could not save: disk full',
    );
  });

  it("Don't Allow: the card explains how to allow, and Not now closes it", async () => {
    const { user } = await harness({ answer: 'denied' });
    const card = await screen.findByRole('region', { name: 'Daily reminder offer' });
    await user.click(within(card).getByRole('button', { name: 'Turn on' }));
    expect((await within(card).findByRole('alert')).textContent).toContain('Allow Notifications');
    await user.click(within(card).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(offerCard()).toBeNull());
  });

  it('not offered in a browser tab, when already on, without push, or without a key', async () => {
    for (const opts of [
      { installed: false },
      { serverSettings: { reminderEnabled: true } },
      { permission: null },
      { noVapidKey: true },
    ]) {
      await harness(opts);
      await screen.findByRole('button', { name: 'Start lesson' });
      expect(offerCard(), JSON.stringify(opts)).toBeNull();
      cleanup();
    }
  });
});

describe('helpers', () => {
  it('timeLabel and refreshProblem', () => {
    expect(timeLabel('00:00')).toBe('12:00 AM');
    expect(timeLabel('15:45')).toBe('3:45 PM');
    expect(refreshProblem(null)).toBeNull();
    expect(refreshProblem({ state: 'ok' })).toBeNull();
    expect(refreshProblem({ state: 'off' })).toBeNull();
    expect(refreshProblem({ state: 'not-set-up' })).toEqual({ kind: 'not-set-up' });
    expect(refreshProblem({ state: 'unsupported' })).toEqual({ kind: 'unsupported' });
  });
});
