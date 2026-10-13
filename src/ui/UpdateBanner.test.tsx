// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pwaStore, registerServiceWorker, type SwContainer } from '../pwa';
import { OfflineLine, UpdateBanner } from './UpdateBanner';

beforeEach(() => pwaStore.reset());
afterEach(cleanup);

describe('UpdateBanner', () => {
  it('is hidden until a new version is installed, then Reload reloads', async () => {
    const reload = vi.fn();
    render(<UpdateBanner reload={reload} />);
    expect(screen.queryByRole('button', { name: /Reload/ })).toBeNull();
    let takeOver = () => {};
    const container: SwContainer = {
      controller: {},
      register: async () => ({ update: async () => {} }),
      addEventListener: (_t, l) => {
        takeOver = l;
      },
    };
    await registerServiceWorker({ container, base: '/x/', onVisible: () => {} });
    act(() => takeOver());
    await userEvent.click(await screen.findByRole('button', { name: 'New version: Reload' }));
    expect(reload).toHaveBeenCalled();
  });
});

describe('OfflineLine', () => {
  it('is empty normally and explains a failure', async () => {
    const { container } = render(<OfflineLine />);
    expect(container.textContent).toBe('');
    await registerServiceWorker({ container: undefined });
    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      expect.stringContaining('Offline use is not available'),
    );
  });
});
