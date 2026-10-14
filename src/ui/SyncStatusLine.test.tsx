// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { SyncStatus } from '../data/sync';
import { SyncStatusView } from './SyncStatusLine';

const base: SyncStatus = {
  running: false,
  offline: false,
  pendingAnswers: 0,
  pendingSettings: false,
  lastSyncAt: null,
  lastError: null,
  notices: [],
};
const html = (s: SyncStatus | null) =>
  renderToStaticMarkup(<SyncStatusView status={s} onDismiss={() => undefined} />);

describe('SyncStatusView', () => {
  it('shows the status line', () => {
    expect(html(null)).toContain('Checking backup…');
    expect(html(base)).toContain('All answers backed up');
    expect(html(base)).not.toContain('Dismiss');
    expect(html({ ...base, pendingAnswers: 3, offline: true })).toContain(
      '3 answers waiting to back up (offline)',
    );
    expect(html({ ...base, pendingAnswers: 1, lastError: 'Failed to fetch' })).toContain(
      'Last sync failed: Failed to fetch',
    );
  });

  it('shows notices until dismissed, as plain text', () => {
    const out = html({
      ...base,
      notices: ['1 answer could not be saved: <img src=x onerror=alert(1)>'],
    });
    expect(out).toContain('role="alert"');
    expect(out).toContain('Dismiss');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).not.toContain('<img');
  });

  it('shows an error when dismissing fails (audit L10)', async () => {
    const user = userEvent.setup();
    render(
      <SyncStatusView
        status={{ ...base, notices: ['a notice'] }}
        onDismiss={() => Promise.reject(new Error('disk full'))}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect((await screen.findByText('Could not dismiss: disk full')).getAttribute('role')).toBe(
      'alert',
    );
  });
});

afterEach(cleanup);
