// Bank model: defensive normalizer, version comparison and answer fingerprint.
// Anything from the network, the cache or a file is untrusted: malformed questions are
// dropped and reported, never allowed to crash the app.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  AREA_IDS,
  LEVELS,
  QUESTION_TYPES,
  type Area,
  type AreaId,
  type Bank,
  type Labeled,
  type Level,
  type LevelInfo,
  type Question,
  type QuestionType,
  type Scenario,
} from './types';

export const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)+$/;
const VERSION_RE = /^(\d{4}-\d{2}-\d{2})\.(\d+)$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isArea = (v: unknown): v is AreaId => AREA_IDS.includes(v as AreaId);
const isLevel = (v: unknown): v is Level => LEVELS.includes(v as Level);
const unique = (xs: readonly string[]) => new Set(xs).size === xs.length;

export interface Dropped {
  id: string;
  reason: string;
}

export type NormalizeResult =
  { ok: true; bank: Bank; dropped: Dropped[] } | { ok: false; error: string };

function labeled(v: unknown): Labeled[] | null {
  if (!Array.isArray(v)) return null;
  const out: Labeled[] = [];
  for (const x of v) {
    if (!isObj(x) || !isStr(x.id) || !isStr(x.text)) return null;
    out.push({ id: x.id, text: x.text });
  }
  return unique(out.map((x) => x.id)) ? out : null;
}

function parseQuestion(raw: Obj, scenarioIds: ReadonlySet<string>): Question | string {
  const type = raw.type as QuestionType;
  if (!QUESTION_TYPES.includes(type)) return `unknown type ${String(raw.type)}`;
  if (!isArea(raw.area)) return 'invalid area';
  if (!isLevel(raw.level)) return 'invalid level';
  if (raw.status !== 'active' && raw.status !== 'retired') return 'invalid status';
  if (!Number.isInteger(raw.revision) || (raw.revision as number) < 1) return 'invalid revision';
  if (!isStr(raw.stem)) return 'missing stem';
  if (!isStr(raw.explanation)) return 'missing explanation';
  const scenarioId = raw.scenarioId ?? null;
  if (scenarioId !== null && !(typeof scenarioId === 'string' && scenarioIds.has(scenarioId)))
    return 'unknown scenario';
  const outline = Array.isArray(raw.outline) ? raw.outline.filter(isStr) : [];
  const base = {
    id: raw.id as string,
    area: raw.area,
    level: raw.level,
    outline,
    category: isStr(raw.category) ? raw.category : null,
    scenarioId,
    stem: raw.stem,
    explanation: raw.explanation,
    revision: raw.revision as number,
    status: raw.status,
    added: typeof raw.added === 'string' ? raw.added : '',
  } as const;

  switch (type) {
    case 'mc': {
      const choices = labeled(raw.choices);
      if (!choices || choices.length < 2) return 'invalid choices';
      if (typeof raw.answer !== 'string' || !choices.some((c) => c.id === raw.answer))
        return 'answer is not a choice';
      return { ...base, type, choices, answer: raw.answer };
    }
    case 'multi': {
      const choices = labeled(raw.choices);
      if (!choices || choices.length < 2) return 'invalid choices';
      const ids = choices.map((c) => c.id);
      const answer = raw.answer;
      if (
        !Array.isArray(answer) ||
        answer.length === 0 ||
        !answer.every((a) => typeof a === 'string' && ids.includes(a)) ||
        !unique(answer as string[]) ||
        answer.length >= choices.length
      )
        return 'invalid answer';
      if (raw.selectCount !== answer.length) return 'selectCount must equal the number of answers';
      return { ...base, type, choices, answer: answer as string[], selectCount: answer.length };
    }
    case 'numeric': {
      const a = raw.answer;
      if (!isObj(a)) return 'invalid answer';
      const { value, tolerance, unit } = a;
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'invalid answer value';
      if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0)
        return 'invalid tolerance';
      if (typeof unit !== 'string') return 'invalid unit';
      const displayAnswer = isStr(raw.displayAnswer)
        ? raw.displayAnswer
        : `${value}${unit ? ` ${unit}` : ''}`;
      return { ...base, type, answer: { value, tolerance, unit }, displayAnswer };
    }
    case 'text': {
      const acc = raw.accepted;
      if (!Array.isArray(acc) || acc.length === 0 || !acc.every(isStr)) return 'invalid accepted';
      const accepted = acc as string[];
      const displayAnswer = isStr(raw.displayAnswer) ? raw.displayAnswer : (accepted[0] as string);
      return { ...base, type, accepted, displayAnswer };
    }
    case 'ordering': {
      const items = labeled(raw.items);
      if (!items || items.length < 2) return 'invalid items';
      const ids = items.map((i) => i.id);
      const answer = raw.answer;
      if (
        !Array.isArray(answer) ||
        answer.length !== ids.length ||
        !answer.every((a) => typeof a === 'string' && ids.includes(a)) ||
        !unique(answer as string[])
      )
        return 'answer must be a permutation of the items';
      return { ...base, type, items, answer: answer as string[] };
    }
    case 'matching': {
      const prompts = labeled(raw.prompts);
      const options = labeled(raw.options);
      if (!prompts || prompts.length === 0 || !options || options.length < prompts.length)
        return 'invalid prompts or options';
      const a = raw.answer;
      if (!isObj(a)) return 'invalid answer';
      const optionIds = options.map((o) => o.id);
      const answer: Record<string, string> = {};
      for (const p of prompts) {
        const v = a[p.id];
        if (typeof v !== 'string' || !optionIds.includes(v)) return 'answer must map every prompt';
        answer[p.id] = v;
      }
      if (Object.keys(a).length !== prompts.length) return 'answer has extra keys';
      if (!unique(Object.values(answer))) return 'an option is used twice';
      return {
        ...base,
        type,
        prompts,
        options,
        answer,
        note: isStr(raw.note) ? raw.note : null,
      };
    }
  }
}

export function normalizeBank(input: unknown): NormalizeResult {
  if (!isObj(input)) return { ok: false, error: 'not a question bank' };
  if (input.schemaVersion !== 1)
    return { ok: false, error: `unsupported schemaVersion ${String(input.schemaVersion)}` };
  if (typeof input.bankVersion !== 'string' || !VERSION_RE.test(input.bankVersion))
    return { ok: false, error: 'invalid bankVersion' };

  const areas: Area[] = [];
  if (Array.isArray(input.areas))
    for (const a of input.areas)
      if (isObj(a) && isArea(a.id) && isStr(a.name) && !areas.some((x) => x.id === a.id))
        areas.push({ id: a.id, name: a.name });
  if (areas.length !== AREA_IDS.length) return { ok: false, error: 'areas must list the 5 areas' };
  areas.sort((x, y) => x.id - y.id);

  if (!isObj(input.levels)) return { ok: false, error: 'missing levels' };
  const levels = {} as Record<Level, LevelInfo>;
  for (const l of LEVELS) {
    const info = input.levels[l];
    if (
      !isObj(info) ||
      !Number.isInteger(info.points) ||
      (info.points as number) < 0 ||
      (info.points as number) > 3
    )
      return { ok: false, error: `invalid levels.${l}` };
    levels[l] = { name: isStr(info.name) ? info.name : l, points: info.points as number };
  }

  const dropped: Dropped[] = [];
  const scenarios: Scenario[] = [];
  for (const s of Array.isArray(input.scenarios) ? input.scenarios : []) {
    const id = isObj(s) && typeof s.id === 'string' ? s.id : '?';
    if (!isObj(s) || !ID_RE.test(id) || !isArea(s.area) || !isStr(s.text))
      dropped.push({ id, reason: 'malformed scenario' });
    else if (scenarios.some((x) => x.id === id))
      dropped.push({ id, reason: 'duplicate scenario id' });
    else scenarios.push({ id, area: s.area, title: isStr(s.title) ? s.title : '', text: s.text });
  }
  const scenarioIds = new Set(scenarios.map((s) => s.id));

  const questions: Question[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(input.questions) ? input.questions : []) {
    const id = isObj(raw) && typeof raw.id === 'string' ? raw.id : '?';
    if (!isObj(raw) || !ID_RE.test(id)) {
      dropped.push({ id, reason: 'invalid id' });
      continue;
    }
    if (seen.has(id)) {
      dropped.push({ id, reason: 'duplicate id' });
      continue;
    }
    const q = parseQuestion(raw, scenarioIds);
    if (typeof q === 'string') dropped.push({ id, reason: q });
    else {
      seen.add(id);
      questions.push(q);
    }
  }

  return {
    ok: true,
    bank: { schemaVersion: 1, bankVersion: input.bankVersion, areas, levels, scenarios, questions },
    dropped,
  };
}

/** Compares `YYYY-MM-DD.n` versions: negative if a < b. Invalid versions sort lowest. */
export function compareBankVersion(a: string, b: string): number {
  const ma = VERSION_RE.exec(a);
  const mb = VERSION_RE.exec(b);
  if (!ma || !mb) return (ma ? 1 : 0) - (mb ? 1 : 0);
  if (ma[1] !== mb[1]) return (ma[1] as string) < (mb[1] as string) ? -1 : 1;
  return Math.sign(Number(ma[2]) - Number(mb[2]));
}

/** JSON with object keys sorted at every level, so equal data always gives equal text. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isObj(v))
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

const byId = (xs: Labeled[]) =>
  [...xs].sort((x, y) => (x.id < y.id ? -1 : 1)).map(({ id, text }) => ({ id, text }));

/** The fields that decide grading. Not the stem, explanation, scenario, citations or notes. */
function gradedFields(q: Question): Record<string, unknown> {
  switch (q.type) {
    case 'mc':
      return { type: q.type, answer: q.answer, choices: byId(q.choices) };
    case 'multi':
      return {
        type: q.type,
        answer: [...q.answer].sort(),
        selectCount: q.selectCount,
        choices: byId(q.choices),
      };
    case 'numeric':
      return { type: q.type, answer: q.answer };
    case 'text':
      return { type: q.type, accepted: [...q.accepted].sort() };
    case 'ordering':
      return { type: q.type, answer: q.answer, items: byId(q.items) };
    case 'matching':
      return {
        type: q.type,
        answer: q.answer,
        prompts: byId(q.prompts),
        options: byId(q.options),
      };
  }
}

/**
 * Answer fingerprint: first 16 hex chars of SHA-256 over the graded fields. A wording fix
 * keeps it (progress kept); a change to the answer or any choice text changes it (that
 * card's schedule restarts). Choice order in the file does not matter.
 */
export function answerFp(q: Question): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(gradedFields(q))))).slice(0, 16);
}
