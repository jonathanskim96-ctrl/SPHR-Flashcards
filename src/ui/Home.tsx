// Home: XP and the daily-goal ring, five area cards with three tier rows each, the area and
// tier pickers, Start lesson and Mistakes. Not shown, by the owner's choice: a due-today
// counter, an exam countdown, a streak.
import { useEffect, useState, type ReactNode } from 'react';
import type { Selection } from '../domain/lesson';
import { stateOf } from '../domain/replay';
import { AREA_IDS, LEVELS, type AreaId, type Level, type Mode } from '../domain/types';
import type { Study } from './useStudy';

export const TIER_LABELS: Record<Level, string> = {
  K: 'Knowledge',
  A: 'Application',
  S: 'Synthesis',
};

const STORAGE_KEY = 'sphr-selection';

/** Her last area/tier choice is remembered on this phone (a convenience; never required). */
export function loadSelection(): Selection {
  const all: Selection = { areas: [...AREA_IDS], tiers: [...LEVELS] };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<{
      areas: unknown[];
      tiers: unknown[];
    }> | null;
    const areas = AREA_IDS.filter((a) => raw?.areas?.includes(a));
    const tiers = LEVELS.filter((l) => raw?.tiers?.includes(l));
    return areas.length && tiers.length ? { areas, tiers } : all;
  } catch {
    return all;
  }
}

function saveSelection(s: Selection) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Private mode or blocked storage: the choice just isn't remembered.
  }
}

/**
 * Mistakes cards she can practise now: the same cards a Mistakes lesson would offer, so a card
 * answered today (it waits until tomorrow) is not counted (audit M2, owner's decision).
 */
export function mistakesCount(study: Study, selection: Selection): number {
  if (!study.bank) return 0;
  return study.bank.questions.filter((q) => {
    const s = stateOf(study.states, q.id);
    return (
      q.status === 'active' &&
      selection.areas.includes(q.area) &&
      selection.tiers.includes(q.level) &&
      s.inMistakes &&
      s.lastAnswered !== study.today
    );
  }).length;
}

const RING_R = 34;
const RING_C = 2 * Math.PI * RING_R;

export function GoalRing({ xp, goal }: { xp: number; goal: number }) {
  const done = xp >= goal;
  const frac = Math.min(1, xp / goal);
  return (
    <svg
      width="88"
      height="88"
      viewBox="0 0 88 88"
      role="img"
      aria-label={`Today's goal: ${xp} of ${goal} XP${done ? ', reached' : ''}`}
    >
      <circle cx="44" cy="44" r={RING_R} className="ring-track" fill="none" strokeWidth="9" />
      <circle
        cx="44"
        cy="44"
        r={RING_R}
        className="ring-fill"
        fill="none"
        strokeWidth="9"
        strokeLinecap="round"
        strokeDasharray={`${frac * RING_C} ${RING_C}`}
        transform="rotate(-90 44 44)"
      />
      <text x="44" y="42" textAnchor="middle" className="ring-text">
        {done ? '✓' : xp}
      </text>
      <text x="44" y="60" textAnchor="middle" className="ring-sub">
        / {goal}
      </text>
    </svg>
  );
}

export function Home({
  study,
  onStart,
  onSettings,
  offer,
}: {
  study: Study;
  onStart: (mode: Mode, selection: Selection) => void;
  onSettings: () => void;
  /** The one-time daily-reminder card, when it is offered. */
  offer?: ReactNode;
}) {
  const [selection, setSelection] = useState<Selection>(loadSelection);
  useEffect(() => saveSelection(selection), [selection]);

  const toggleArea = (a: AreaId) =>
    setSelection((s) => {
      const areas = s.areas.includes(a) ? s.areas.filter((x) => x !== a) : [...s.areas, a];
      return areas.length ? { ...s, areas: AREA_IDS.filter((x) => areas.includes(x)) } : s;
    });
  const toggleTier = (t: Level) =>
    setSelection((s) => {
      const tiers = s.tiers.includes(t) ? s.tiers.filter((x) => x !== t) : [...s.tiers, t];
      return tiers.length ? { ...s, tiers: LEVELS.filter((x) => tiers.includes(x)) } : s;
    });

  const { bank, progress } = study;
  const mistakes = mistakesCount(study, selection);

  return (
    <main className="page">
      <header className="topbar">
        <h1>SPHR Flashcards</h1>
        <button type="button" className="btn icon" onClick={onSettings} aria-label="Settings">
          ⚙
        </button>
      </header>

      {offer}

      <section className="xp-row" aria-label="Experience points">
        <div>
          <p className="xp-total">{study.xpTotal} XP</p>
          <p className="muted">Total</p>
        </div>
        <GoalRing xp={study.xpToday} goal={study.settings.dailyXpGoal} />
      </section>

      {study.bankStatus.lastError && !bank && (
        <p role="alert" className="error">
          ✗ Could not load the questions: {study.bankStatus.lastError}
        </p>
      )}
      {!bank || !progress ? (
        <p role="status">Loading questions…</p>
      ) : (
        <>
          <section aria-label="Tiers to study">
            <div className="chips" role="group" aria-label="Tiers">
              {LEVELS.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="chip"
                  aria-pressed={selection.tiers.includes(t)}
                  onClick={() => toggleTier(t)}
                >
                  {selection.tiers.includes(t) ? '✓ ' : ''}
                  {t} · {TIER_LABELS[t]}
                </button>
              ))}
            </div>
          </section>

          <div className="areas">
            {bank.areas.map((area) => {
              const on = selection.areas.includes(area.id);
              return (
                <section key={area.id} className={`area ${on ? 'on' : ''}`}>
                  <button
                    type="button"
                    className="area-title"
                    aria-pressed={on}
                    onClick={() => toggleArea(area.id)}
                  >
                    {on ? '✓ ' : ''}
                    {area.id}. {area.name}
                  </button>
                  {LEVELS.map((t) => {
                    const p = progress[area.id][t];
                    return (
                      <div key={t} className="tier-row">
                        <span className="tier-name">{TIER_LABELS[t]}</span>
                        <progress
                          max={Math.max(p.active, 1)}
                          value={p.mastered}
                          aria-label={`${area.name}, ${TIER_LABELS[t]}: ${p.mastered} of ${p.active} mastered`}
                        />
                        <span className="tier-count">
                          {p.mastered}/{p.active}
                        </span>
                        {p.badge && (
                          <span className="badge" role="img" aria-label="Mastered">
                            ★ Mastered
                          </span>
                        )}
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </div>

          <div className="actions">
            <button type="button" className="btn big" onClick={() => onStart('lesson', selection)}>
              Start lesson
            </button>
            {mistakes > 0 && (
              <button
                type="button"
                className="btn secondary"
                onClick={() => onStart('mistakes', selection)}
              >
                Mistakes ({mistakes})
              </button>
            )}
          </div>
        </>
      )}
    </main>
  );
}
