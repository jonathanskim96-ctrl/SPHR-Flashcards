// Grading, one rule per type (BUILD_PLAN 1b; decided by the owner, do not loosen).
// All-or-nothing: only `correct` drives XP and scheduling. `parts` is feedback only.
import { norm } from './textNorm';
import type { Question, Response } from './types';

export interface Grade {
  correct: boolean;
  /** multi: per chosen option; ordering: per position; matching: per prompt (prompt order). */
  parts?: boolean[];
}

const NUMBER_RE = /^-?(\d+\.?\d*|\.\d+)$/;

/** Numeric input → number, or null when it is not a plain number after the allowed clean-up. */
export function parseNumeric(input: string, unit: string): number | null {
  let s = input.toLowerCase();
  const u = unit.toLowerCase();
  if (u !== '') s = s.split(u).join('');
  s = s.replace(/[$%,]/g, '').replace(/\s+/g, '');
  return NUMBER_RE.test(s) ? Number(s) : null;
}

export function grade(q: Question, r: Response): Grade {
  switch (q.type) {
    case 'mc':
      return { correct: r.type === 'mc' && r.choice === q.answer };
    case 'multi': {
      if (r.type !== 'multi') return { correct: false };
      const parts = r.choices.map((c) => q.answer.includes(c));
      const chosen = new Set(r.choices);
      const correct =
        chosen.size === r.choices.length &&
        chosen.size === q.answer.length &&
        q.answer.every((a) => chosen.has(a));
      return { correct, parts };
    }
    case 'numeric': {
      if (r.type !== 'numeric') return { correct: false };
      const x = parseNumeric(r.input, q.answer.unit);
      return {
        correct: x !== null && Math.abs(x - q.answer.value) <= q.answer.tolerance + 1e-9,
      };
    }
    case 'text': {
      if (r.type !== 'text') return { correct: false };
      const n = norm(r.input);
      return { correct: q.accepted.some((a) => norm(a) === n) };
    }
    case 'ordering': {
      if (r.type !== 'ordering') return { correct: false };
      const parts = q.answer.map((id, i) => r.order[i] === id);
      return { correct: r.order.length === q.answer.length && parts.every(Boolean), parts };
    }
    case 'matching': {
      if (r.type !== 'matching') return { correct: false };
      const parts = q.prompts.map((p) => r.pairs[p.id] === q.answer[p.id]);
      return { correct: parts.every(Boolean), parts };
    }
  }
}
