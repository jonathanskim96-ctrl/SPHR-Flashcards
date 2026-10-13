// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../domain/validate';
import { harness } from '../../tests/uiHarness';
import sampleExport from '../../tests/fixtures/sample-export.json';
import { TZ } from '../../tests/helpers';
import { checkDraft, REMINDER_TIMES, timeLabel } from './Settings';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
beforeEach(() => localStorage.clear());

type User = ReturnType<typeof userEvent.setup>;
async function openSettings(user: User) {
  await user.click(await screen.findByRole('button', { name: 'Settings' }));
  return screen.findByRole('heading', { name: 'Settings' });
}
const file = (name: string, text: string) => new File([text], name, { type: 'application/json' });
const upload = (user: User, f: File) => user.upload(screen.getByLabelText('Progress file'), f);

describe('Settings: study pace', () => {
  it('shows the current values and the build id', async () => {
    const { user } = await harness();
    await openSettings(user);
    expect((screen.getByLabelText(/New cards per day/) as HTMLInputElement).value).toBe('15');
    expect((screen.getByLabelText(/Cards per lesson/) as HTMLInputElement).value).toBe('10');
    expect((screen.getByLabelText(/Daily XP goal/) as HTMLInputElement).value).toBe('30');
    expect((screen.getByLabelText(/Exam date/) as HTMLInputElement).value).toBe('2026-12-15');
    expect(screen.getByText(/^Build /)).toBeTruthy();
  });

  it('rejects bad values with a plain message and saves nothing', async () => {
    const { user, server } = await harness();
    await openSettings(user);
    const goal = screen.getByLabelText(/Daily XP goal/);
    await user.clear(goal);
    await user.type(goal, '3.5');
    const lesson = screen.getByLabelText(/Cards per lesson/);
    await user.clear(lesson);
    await user.type(lesson, '4');
    const perDay = screen.getByLabelText(/New cards per day/);
    await user.clear(perDay);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const alert = screen.getByRole('alert').textContent!;
    expect(alert).toContain('Daily XP goal must be a whole number from 5 to 200.');
    expect(alert).toContain('Lesson length must be a whole number from 5 to 30.');
    expect(alert).toContain('New cards per day must be a whole number from 1 to 50.');
    expect(screen.queryByText('✓ Saved')).toBeNull();
    expect(server.settings?.value.dailyXpGoal ?? 30).toBe(30);
  });

  it('saves good values, and Home uses them', async () => {
    const { user } = await harness();
    await openSettings(user);
    const goal = screen.getByLabelText(/Daily XP goal/);
    await user.clear(goal);
    await user.type(goal, '50');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('✓ Saved')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back to Home' }));
    expect(await screen.findByRole('img', { name: "Today's goal: 0 of 50 XP" })).toBeTruthy();
  });

  it('keeps what she is typing when the phone re-reads its data (e.g. after a sync or export)', async () => {
    const { user } = await harness();
    await openSettings(user);
    const goal = screen.getByLabelText(/Daily XP goal/) as HTMLInputElement;
    await user.clear(goal);
    await user.type(goal, '77');
    URL.createObjectURL = () => 'blob:test';
    URL.revokeObjectURL = () => {};
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await user.click(screen.getByRole('button', { name: 'Export progress' }));
    await screen.findByText('✓ Exported 0 answers.');
    await waitFor(() => expect(screen.queryByText('Never exported')).toBeNull()); // data was re-read
    expect(goal.value).toBe('77');
  });

  it('checkDraft explains each problem, including a bad date', () => {
    const base = defaultSettings(TZ);
    const bad = checkDraft(
      { newPerDay: '0', lessonSize: 'x', dailyXpGoal: '201', examDate: '2026-02-30' },
      base,
    );
    expect(bad).toEqual({
      ok: false,
      errors: [
        'New cards per day must be a whole number from 1 to 50.',
        'Lesson length must be a whole number from 5 to 30.',
        'Daily XP goal must be a whole number from 5 to 200.',
        'Exam date must be a real date.',
      ],
    });
    expect(
      checkDraft(
        { newPerDay: '15', lessonSize: '10', dailyXpGoal: '30', examDate: '2026-12-15' },
        base,
      ),
    ).toEqual({
      ok: true,
      settings: base,
    });
  });
});

describe('Settings: daily reminder', () => {
  it('turns on at once, changes time in 15-minute steps, and shows the time zone', async () => {
    const { user } = await harness();
    await openSettings(user);
    expect(screen.getByText(`Time zone: ${TZ}`)).toBeTruthy();
    const sw = screen.getByRole('switch', { name: 'Remind me every day' }) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    await user.click(sw);
    await waitFor(() => expect(sw.checked).toBe(true));
    const time = screen.getByLabelText('Time') as HTMLSelectElement;
    expect(time.options).toHaveLength(96);
    expect(time.value).toBe('15:00');
    await user.selectOptions(time, '08:45');
    await waitFor(() => expect(time.value).toBe('08:45'));
    expect(within(time).getByRole('option', { name: '8:45 AM' })).toBeTruthy();
  });

  it('asks before turning off, and Cancel leaves it on', async () => {
    const { user } = await harness();
    await openSettings(user);
    const sw = screen.getByRole('switch') as HTMLInputElement;
    await user.click(sw);
    await waitFor(() => expect(sw.checked).toBe(true));
    await user.click(sw);
    const dialog = screen.getByRole('dialog', { name: 'Turn off the daily reminder?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sw.checked).toBe(true);
    await user.click(sw);
    await user.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(sw.checked).toBe(false));
  });

  it('Escape closes a dialog without doing anything', async () => {
    const { user } = await harness();
    await openSettings(user);
    const sw = screen.getByRole('switch') as HTMLInputElement;
    await user.click(sw);
    await waitFor(() => expect(sw.checked).toBe(true));
    await user.click(sw);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sw.checked).toBe(true);
  });

  it('formats times', () => {
    expect(timeLabel('00:00')).toBe('12:00 AM');
    expect(timeLabel('12:15')).toBe('12:15 PM');
    expect(timeLabel('15:00')).toBe('3:00 PM');
    expect(REMINDER_TIMES[0]).toBe('00:00');
    expect(REMINDER_TIMES.at(-1)).toBe('23:45');
  });
});

describe('Settings: backup status, export and import', () => {
  function stubDownload() {
    const blobs: Blob[] = [];
    URL.createObjectURL = (b: Blob | MediaSource) => {
      blobs.push(b as Blob);
      return 'blob:test';
    };
    URL.revokeObjectURL = () => {};
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    return { blobs, click };
  }

  it('shows the sync status line', async () => {
    const { user } = await harness();
    await openSettings(user);
    expect(await screen.findByText('All answers backed up')).toBeTruthy();
    expect(screen.getByText('Never exported')).toBeTruthy();
  });

  it('exports every answer and the settings, and remembers when', async () => {
    const { user } = await harness();
    await openSettings(user);
    const { blobs, click } = stubDownload();
    await user.click(screen.getByRole('button', { name: 'Export progress' }));
    expect(await screen.findByText('✓ Exported 0 answers.')).toBeTruthy();
    expect(click).toHaveBeenCalledOnce();
    const out = JSON.parse(await blobs[0]!.text());
    expect(out).toMatchObject({ format: 'sphr-flashcards-progress', version: 1, attempts: [] });
    expect(out.settings.examDate).toBe('2026-12-15');
    await waitFor(() => expect(screen.queryByText('Never exported')).toBeNull());
  });

  it('says so when the export fails', async () => {
    const { user } = await harness();
    await openSettings(user);
    URL.createObjectURL = () => {
      throw new Error('no memory');
    };
    await user.click(screen.getByRole('button', { name: 'Export progress' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Export failed: no memory');
  });

  it('previews an import, asks to confirm, adds only the new answers, and is idempotent', async () => {
    const { user } = await harness();
    await openSettings(user);
    await upload(user, file('progress.json', JSON.stringify(sampleExport)));
    const dialog = await screen.findByRole('dialog', { name: 'Import progress?' });
    expect(dialog.textContent).toContain('36 new answers, 0 already present, 0 rejected.');
    expect(dialog.textContent).toContain('nothing is removed');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Also restore settings' }));
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    expect(await screen.findByText(/Imported 36 new answers\. Settings restored\./)).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByLabelText(/Cards per lesson/) as HTMLInputElement).value).toBe('12'),
    );
    // Importing the same file again adds nothing, and the Import button is off.
    await upload(user, file('progress.json', JSON.stringify(sampleExport)));
    const again = await screen.findByRole('dialog', { name: 'Import progress?' });
    expect(again.textContent).toContain('0 new answers, 36 already present');
    expect(within(again).getByRole('button', { name: 'Import' }).hasAttribute('disabled')).toBe(
      true,
    );
    await user.click(within(again).getByRole('button', { name: 'Cancel' }));
  });

  it('lists rejected answers and does not restore unreadable settings', async () => {
    const { user } = await harness();
    await openSettings(user);
    const bad: { attempts: { xp: number }[]; settings: unknown } = structuredClone(sampleExport);
    bad.attempts[0]!.xp = 99;
    bad.settings = { nope: true };
    await upload(user, file('p.json', JSON.stringify(bad)));
    const dialog = await screen.findByRole('dialog', { name: 'Import progress?' });
    expect(dialog.textContent).toContain('35 new answers, 0 already present, 1 rejected.');
    expect(dialog.textContent).toContain('#1:');
    expect(dialog.textContent).toContain('could not be read');
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('✓ Imported 35 new answers.')).toBeTruthy();
  });

  it('refuses a file that is not a progress export, with a message', async () => {
    const { user } = await harness();
    await openSettings(user);
    await upload(user, file('x.json', 'not json at all'));
    expect((await screen.findByRole('alert')).textContent).toContain('not valid JSON');
    expect(screen.queryByRole('dialog')).toBeNull();
    await upload(user, file('y.json', JSON.stringify({ format: 'something-else' })));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'not an SPHR Flashcards progress export',
      ),
    );
  });

  it('says so when the file cannot be read', async () => {
    const { user } = await harness();
    await openSettings(user);
    const f = file('p.json', '{}');
    f.text = () => Promise.reject(new Error('read failed'));
    await upload(user, f);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not read the file: read failed',
    );
  });
});

describe('Settings: sign out', () => {
  it('asks first, then signs out and returns to the sign-in screen', async () => {
    const { user, signOutSpy } = await harness();
    await openSettings(user);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    const dialog = screen.getByRole('dialog', { name: 'Sign out?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(signOutSpy).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await user.click(
      within(screen.getByRole('dialog', { name: 'Sign out?' })).getByRole('button', {
        name: 'Sign out',
      }),
    );
    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(signOutSpy).toHaveBeenCalledOnce();
  });

  it('is refused while answers are not backed up, and offers an export', async () => {
    const { user, server, signOutSpy } = await harness();
    server.offline = true;
    await user.click(await screen.findByRole('button', { name: 'Start lesson' }));
    await screen.findByRole('button', { name: 'Check' });
    await user.click(document.querySelector('button.option') as HTMLElement);
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Quit lesson' }));
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    expect(await screen.findByText(/1 answer waiting to back up/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getAllByRole('button').at(-1)!);
    const alert = await screen.findByText(
      /You can't sign out yet: 1 answer and a settings change are not backed up/,
    );
    expect(alert).toBeTruthy();
    expect(signOutSpy).not.toHaveBeenCalled();
    const box = alert.closest('[role="alert"]') as HTMLElement;
    expect(within(box).getByRole('button', { name: 'Export progress' })).toBeTruthy();
  });
});
