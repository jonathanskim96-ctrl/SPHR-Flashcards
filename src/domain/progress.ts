// Progress bars and badges (BUILD_PLAN 1g). Retired questions are not counted.
import { stateOf } from './replay';
import { mastered } from './schedule';
import { AREA_IDS, LEVELS, type AreaId, type Bank, type CardState, type Level } from './types';

export interface Counts {
  active: number;
  seen: number;
  mastered: number;
}

export interface TierProgress extends Counts {
  /** Every active card in this area+tier is mastered. */
  badge: boolean;
}

export type Progress = Record<AreaId, Record<Level, TierProgress>>;

const empty = (): TierProgress => ({ active: 0, seen: 0, mastered: 0, badge: false });

export function computeProgress(bank: Bank, states: ReadonlyMap<string, CardState>): Progress {
  const p = {} as Progress;
  for (const a of AREA_IDS) p[a] = { K: empty(), A: empty(), S: empty() };
  for (const q of bank.questions) {
    if (q.status !== 'active') continue;
    const t = p[q.area][q.level];
    const s = stateOf(states, q.id);
    t.active++;
    if (s.box > 0) t.seen++;
    if (mastered(s)) t.mastered++;
  }
  for (const a of AREA_IDS)
    for (const l of LEVELS) {
      const t = p[a][l];
      t.badge = t.active > 0 && t.mastered === t.active;
    }
  return p;
}

/** Totals across the selected areas (all tiers). */
export function totals(progress: Progress, areas: readonly AreaId[]): Counts {
  const c: Counts = { active: 0, seen: 0, mastered: 0 };
  for (const a of areas)
    for (const l of LEVELS) {
      c.active += progress[a][l].active;
      c.seen += progress[a][l].seen;
      c.mastered += progress[a][l].mastered;
    }
  return c;
}
