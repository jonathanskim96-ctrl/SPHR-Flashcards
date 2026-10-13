// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Question, Response } from '../domain/types';
import { fakeBank, q } from '../../tests/helpers';
import { AnswerInput } from './AnswerInputs';
import { moveItem } from './ordering';

afterEach(cleanup);

function setup(question: Question, order?: string[]) {
  const onChange = vi.fn<(r: Response | null) => void>();
  const ids =
    order ??
    (question.type === 'mc' || question.type === 'multi'
      ? question.choices.map((c) => c.id)
      : question.type === 'ordering'
        ? question.items.map((c) => c.id)
        : question.type === 'matching'
          ? question.options.map((c) => c.id)
          : []);
  render(<AnswerInput q={question} order={ids} disabled={false} onChange={onChange} />);
  return { onChange, user: userEvent.setup(), last: () => onChange.mock.calls.at(-1)?.[0] };
}

describe('mc', () => {
  it('reports the chosen id and shows no letters', async () => {
    const { user, last } = setup(q(fakeBank(), 'fake1-q01'));
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Blue',
      'Green',
      'Purple',
      'Orange',
    ]);
    await user.click(screen.getByRole('button', { name: 'Purple' }));
    expect(last()).toEqual({ type: 'mc', choice: 'C' });
    expect(screen.getByRole('button', { name: 'Purple' })).toHaveProperty('ariaPressed', 'true');
  });

  it('shows the choices in the order it was given', () => {
    setup(q(fakeBank(), 'fake1-q01'), ['D', 'C', 'B', 'A']);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Orange',
      'Purple',
      'Green',
      'Blue',
    ]);
  });
});

describe('multi', () => {
  it('is complete only at exactly selectCount choices', async () => {
    const { user, last } = setup(q(fakeBank(), 'fake2-q01'));
    expect(screen.getByText('Choose 2 (0 chosen)')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Flux sprocket' }));
    expect(last()).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Zorb flange' }));
    expect(last()).toEqual({ type: 'multi', choices: ['A', 'D'] });
    await user.click(screen.getByRole('button', { name: /Park bench/ }));
    expect(last()).toBeNull();
    await user.click(screen.getByRole('button', { name: /Park bench/ }));
    expect(last()).toEqual({ type: 'multi', choices: ['A', 'D'] });
  });
});

describe('numeric', () => {
  it('uses a decimal keypad, shows the unit, and is incomplete while empty', async () => {
    const { user, last } = setup(q(fakeBank(), 'fake2-q02'));
    const input = screen.getByLabelText(/Your answer/);
    expect(input.getAttribute('inputmode')).toBe('decimal');
    expect(screen.getByText('$')).toBeTruthy();
    await user.type(input, '504,000');
    expect(last()).toEqual({ type: 'numeric', input: '504,000' });
    await user.clear(input);
    expect(last()).toBeNull();
  });
});

describe('text', () => {
  it('stops iOS from fixing her spelling', async () => {
    const { user, last } = setup(q(fakeBank(), 'fake2-q08'));
    const input = screen.getByLabelText(/Your answer/);
    expect(input.getAttribute('autocapitalize')).toBe('off');
    expect(input.getAttribute('autocorrect')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.getAttribute('autocomplete')).toBe('off');
    await user.type(input, 'WW');
    expect(last()).toEqual({ type: 'text', input: 'WW' });
    await user.clear(input);
    expect(last()).toBeNull();
  });
});

describe('ordering', () => {
  const rows = () => screen.getAllByRole('listitem').map((li) => li.textContent);

  it('reports the starting order at once and labels every row', () => {
    const { last } = setup(q(fakeBank(), 'fake2-q10'), ['B', 'A', 'C', 'D', 'E']);
    expect(last()).toEqual({ type: 'ordering', order: ['B', 'A', 'C', 'D', 'E'] });
    expect(
      screen.getByRole('button', { name: 'Item 2 of 5: Attach the flux sprocket, move up' }),
    ).toBeTruthy();
  });

  it('moves rows with the up and down buttons; the ends cannot move further', async () => {
    const { user, last } = setup(q(fakeBank(), 'fake2-q10'), ['B', 'A', 'C', 'D', 'E']);
    await user.click(
      screen.getByRole('button', { name: 'Item 2 of 5: Attach the flux sprocket, move up' }),
    );
    expect(last()).toEqual({ type: 'ordering', order: ['A', 'B', 'C', 'D', 'E'] });
    await user.click(
      screen.getByRole('button', { name: 'Item 1 of 5: Attach the flux sprocket, move down' }),
    );
    expect(last()).toEqual({ type: 'ordering', order: ['B', 'A', 'C', 'D', 'E'] });
    expect(
      screen
        .getByRole('button', { name: 'Item 1 of 5: Paint the widget blue, move up' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(
      screen
        .getByRole('button', { name: 'Item 5 of 5: Tighten the zorb flange, move down' })
        .hasAttribute('disabled'),
    ).toBe(true);
  });

  it('moves a row by tapping it and then "Move here"', async () => {
    const { user, last } = setup(q(fakeBank(), 'fake2-q10'), ['A', 'B', 'C', 'D', 'E']);
    await user.click(
      screen.getByRole('button', { name: 'Item 1 of 5: Attach the flux sprocket, tap to select' }),
    );
    const here = screen.getAllByRole('button', { name: 'Move here' });
    expect(here).toHaveLength(4);
    await user.click(here[2]!); // the row now at position 4
    expect(last()).toEqual({ type: 'ordering', order: ['B', 'C', 'D', 'A', 'E'] });
    expect(rows()[3]).toContain('Attach the flux sprocket');
    expect(screen.queryByRole('button', { name: 'Move here' })).toBeNull();
  });

  it('tapping the selected row again clears the selection', async () => {
    const { user } = setup(q(fakeBank(), 'fake2-q10'), ['A', 'B', 'C', 'D', 'E']);
    const tap = { name: 'Item 1 of 5: Attach the flux sprocket, tap to select' };
    await user.click(screen.getByRole('button', tap));
    await user.click(screen.getByRole('button', tap));
    expect(screen.queryByRole('button', { name: 'Move here' })).toBeNull();
  });

  it('has a keyboard-reachable drag handle on every row', () => {
    setup(q(fakeBank(), 'fake2-q10'));
    expect(screen.getAllByRole('button', { name: /^Drag: Item \d of 5/ })).toHaveLength(5);
  });

  it('moveItem clamps and ignores bad positions', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 9)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, -4)).toEqual(['c', 'a', 'b']);
    expect(moveItem(['a', 'b', 'c'], 5, 0)).toEqual(['a', 'b', 'c']);
  });
});

describe('matching', () => {
  it('pairs by tapping a prompt then an option; a used option leaves the pool', async () => {
    const { user, last } = setup(q(fakeBank(), 'fake2-q11'));
    await user.click(screen.getByRole('button', { name: /Sprocketron/ }));
    await user.click(screen.getByRole('button', { name: 'Spins sprockets' }));
    expect(screen.queryByRole('button', { name: 'Spins sprockets' })).toBeNull();
    expect(last()).toBeNull();
    // After a pairing the next unpaired prompt is active, so options can be tapped in a row.
    await user.click(screen.getByRole('button', { name: 'Bends flanges' }));
    await user.click(screen.getByRole('button', { name: 'Looks inside gizmos' }));
    await user.click(screen.getByRole('button', { name: 'Turns parts into widgets' }));
    expect(last()).toEqual({
      type: 'matching',
      pairs: { '1': 'B', '2': 'D', '3': 'A', '4': 'E' },
    });
    // The extra option stays in the pool.
    expect(screen.getByRole('button', { name: 'Sings to widgets' })).toBeTruthy();
  });

  it('undoes a pair by tapping it, which returns the option to the pool', async () => {
    const { user, last } = setup(q(fakeBank(), 'fake2-q11'));
    for (const t of ['Spins sprockets', 'Bends flanges', 'Looks inside gizmos', 'Sings to widgets'])
      await user.click(screen.getByRole('button', { name: t }));
    expect(last()).not.toBeNull();
    await user.click(screen.getByRole('button', { name: /Widgetizer/ }));
    expect(last()).toBeNull();
    expect(screen.getByRole('button', { name: 'Sings to widgets' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Turns parts into widgets' }));
    expect(last()).toEqual({
      type: 'matching',
      pairs: { '1': 'B', '2': 'D', '3': 'A', '4': 'E' },
    });
  });

  it('tapping the active prompt again deselects it, and tapping an option with no open prompt starts at the first free one', async () => {
    const { user, last } = setup(q(fakeBank(), 'fake2-q11'));
    const flange = screen.getByRole('button', { name: /Flangeomatic/ });
    await user.click(flange);
    expect(flange.getAttribute('aria-pressed')).toBe('true');
    await user.click(flange);
    expect(flange.getAttribute('aria-pressed')).toBe('false');
    await user.click(screen.getByRole('button', { name: 'Sings to widgets' }));
    expect(screen.getByRole('button', { name: /Sprocketron.*Sings to widgets/ })).toBeTruthy();
    expect(last()).toBeNull();
  });
});

describe('disabled', () => {
  it('locks the inputs once the answer is checked', () => {
    render(
      <AnswerInput
        q={q(fakeBank(), 'fake1-q01')}
        order={['A', 'B']}
        disabled
        onChange={() => {}}
      />,
    );
    for (const b of screen.getAllByRole('button')) expect(b.hasAttribute('disabled')).toBe(true);
  });
});
