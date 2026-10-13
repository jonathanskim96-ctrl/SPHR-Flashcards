// The lesson: a progress bar, the scenario (if any), the question, the answer area, Check,
// then feedback and Continue. Each answer is graded, saved through the one write path
// (guardedWrite) and queued for backup. Feedback never shows wrongReasons, otherNotes,
// citations or source: those fields are not read here.
import { useEffect, useState } from 'react';
import type { Session } from '../data/session';
import { buildAttempt } from '../data/answer';
import { grade, type Grade } from '../domain/grade';
import { refreshLesson } from '../domain/lesson';
import { displayOrder } from '../domain/shuffle';
import type { Bank, Labeled, Mode, Question, Response } from '../domain/types';
import { AnswerInput } from './AnswerInputs';
import type { AppEnv } from './deps';

export interface CardResult {
  correct: boolean;
  xp: number;
}

export function Lesson({
  session,
  bank,
  env,
  mode,
  initial,
  onEnd,
  onQuit,
}: {
  session: Session;
  bank: Bank;
  env: AppEnv;
  mode: Mode;
  initial: Question[];
  onEnd: (results: CardResult[]) => void;
  onQuit: () => void;
}) {
  const [queue, setQueue] = useState<Question[]>(initial);
  const [results, setResults] = useState<CardResult[]>([]);
  const [feedback, setFeedback] = useState<{ response: Response; grade: Grade; xp: number } | null>(
    null,
  );
  const [response, setResponse] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const current = queue[0];
  const currentId = current?.id;

  // A newer bank arrived (it only switches in between cards): use its version of the rest.
  const [seenBank, setSeenBank] = useState(bank);
  if (seenBank !== bank) {
    setSeenBank(bank);
    setQueue((q) => refreshLesson(q, bank));
  }

  // Hold a new bank back while a card is on screen.
  useEffect(() => {
    if (currentId) session.bank.beginCard();
  }, [currentId, session.bank]);
  useEffect(() => () => session.bank.endCard(), [session.bank]);

  useEffect(() => {
    if (!current) onEnd(results);
  }, [current, results, onEnd]);

  if (!current) return null;
  const total = results.length + queue.length;
  const scenario = current.scenarioId
    ? bank.scenarios.find((s) => s.id === current.scenarioId)
    : undefined;

  async function check() {
    if (!current || !response || busy) return;
    setBusy(true);
    setError(null);
    try {
      const attempt = buildAttempt({
        bank,
        question: current,
        response,
        mode,
        now: new Date(env.now()),
      });
      const written = await session.store.guardedWrite({ kind: 'attempt', attempt });
      if (!written.ok) {
        setError(`Your answer could not be saved: ${written.errors.join('; ')}`);
        return;
      }
      session.engine.noteAnswer();
      setFeedback({ response, grade: grade(current, response), xp: attempt.xp });
      setResults((r) => [...r, { correct: attempt.correct, xp: attempt.xp }]);
    } catch (e) {
      setError(`Your answer could not be saved: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function next() {
    setFeedback(null);
    setResponse(null);
    setQueue((q) => q.slice(1));
    session.bank.endCard();
  }

  return (
    <main className="page lesson">
      <header className="lesson-top">
        <button type="button" className="btn icon" onClick={onQuit} aria-label="Quit lesson">
          ✕
        </button>
        <progress
          max={total}
          value={results.length}
          aria-label={`Card ${Math.min(results.length + 1, total)} of ${total}`}
        />
        <span className="muted">
          {Math.min(results.length + 1, total)} / {total}
        </span>
      </header>

      {scenario && (
        <aside className="scenario" aria-label="Scenario">
          <h2>{scenario.title}</h2>
          <p>{scenario.text}</p>
        </aside>
      )}
      <p className="stem">{current.stem}</p>

      <QuestionBody
        key={`${current.id}:${current.revision}`}
        q={current}
        env={env}
        locked={feedback !== null}
        onResponse={setResponse}
      />

      {error && (
        <p role="alert" className="error">
          ✗ {error}
        </p>
      )}

      {feedback ? (
        <FeedbackPanel q={current} feedback={feedback} onContinue={next} />
      ) : (
        <div className="actions sticky">
          <button
            type="button"
            className="btn big"
            disabled={!response || busy}
            onClick={() => void check()}
          >
            Check
          </button>
        </div>
      )}
    </main>
  );
}

function QuestionBody({
  q,
  env,
  locked,
  onResponse,
}: {
  q: Question;
  env: AppEnv;
  locked: boolean;
  onResponse: (r: Response | null) => void;
}) {
  // Shuffled once each time the card is shown; no letters are displayed anywhere.
  const [order] = useState(() => displayOrder(q, env.rng));
  return <AnswerInput q={q} order={order} disabled={locked} onChange={onResponse} />;
}

const mark = (ok: boolean) => (ok ? '✓' : '✗');

function FeedbackPanel({
  q,
  feedback,
  onContinue,
}: {
  q: Question;
  feedback: { response: Response; grade: Grade; xp: number };
  onContinue: () => void;
}) {
  const { grade: g, response, xp } = feedback;
  return (
    <section
      className={`feedback ${g.correct ? 'right' : 'wrong'}`}
      role="status"
      aria-label="Feedback"
      aria-live="polite"
    >
      {g.correct ? (
        <p className="verdict">
          ✓ Correct! <span className="xp">+{xp} XP</span>
        </p>
      ) : (
        <>
          <p className="verdict">✗ Not quite</p>
          <CorrectAnswer q={q} response={response} grade={g} />
          <p className="explanation">{q.explanation}</p>
        </>
      )}
      <button type="button" className="btn big" onClick={onContinue} autoFocus>
        Continue
      </button>
    </section>
  );
}

function text(items: readonly Labeled[], id: string): string {
  return items.find((i) => i.id === id)?.text ?? id;
}

function CorrectAnswer({
  q,
  response,
  grade: g,
}: {
  q: Question;
  response: Response;
  grade: Grade;
}) {
  switch (q.type) {
    case 'mc':
      return <p>Correct answer: {text(q.choices, q.answer)}</p>;
    case 'multi':
      return (
        <>
          <p>Correct answers:</p>
          <ul>
            {q.answer.map((id) => (
              <li key={id}>{text(q.choices, id)}</li>
            ))}
          </ul>
          {response.type === 'multi' && (
            <>
              <p>Your choices:</p>
              <ul>
                {response.choices.map((id, i) => (
                  <li key={id}>
                    {mark(g.parts?.[i] ?? false)} {text(q.choices, id)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      );
    case 'numeric':
    case 'text':
      return <p>Correct answer: {q.displayAnswer}</p>;
    case 'ordering':
      return (
        <>
          <p>Correct order:</p>
          <ol>
            {q.answer.map((id) => (
              <li key={id}>{text(q.items, id)}</li>
            ))}
          </ol>
          {response.type === 'ordering' && (
            <>
              <p>Your order:</p>
              <ol>
                {response.order.map((id, i) => (
                  <li key={id}>
                    {mark(g.parts?.[i] ?? false)} {text(q.items, id)}
                  </li>
                ))}
              </ol>
            </>
          )}
        </>
      );
    case 'matching':
      return (
        <>
          <p>Correct pairs:</p>
          <ul>
            {q.prompts.map((p, i) => {
              const ok = g.parts?.[i] ?? false;
              const mine = response.type === 'matching' ? response.pairs[p.id] : undefined;
              return (
                <li key={p.id}>
                  {mark(ok)} {p.text} → {text(q.options, q.answer[p.id] as string)}
                  {!ok && mine !== undefined && <> (you chose: {text(q.options, mine)})</>}
                </li>
              );
            })}
          </ul>
        </>
      );
  }
}
