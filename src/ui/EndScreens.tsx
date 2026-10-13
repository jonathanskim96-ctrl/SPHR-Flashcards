// Lesson end and "All caught up".
import type { CardResult } from './Lesson';

export function LessonEnd({
  results,
  onKeepGoing,
  onDone,
}: {
  results: CardResult[];
  onKeepGoing: () => void;
  onDone: () => void;
}) {
  const xp = results.reduce((n, r) => n + r.xp, 0);
  const right = results.filter((r) => r.correct).length;
  return (
    <main className="page narrow center">
      <h1>Lesson complete</h1>
      <p className="big-number">+{xp} XP</p>
      <p>
        {right} of {results.length} correct
      </p>
      <div className="actions">
        <button type="button" className="btn big" onClick={onKeepGoing}>
          Keep going
        </button>
        <button type="button" className="btn secondary" onClick={onDone}>
          Done
        </button>
      </div>
    </main>
  );
}

export function CaughtUp({
  mistakes,
  canStudyAhead,
  onMistakes,
  onAhead,
  onHome,
}: {
  mistakes: number;
  canStudyAhead: boolean;
  onMistakes: () => void;
  onAhead: () => void;
  onHome: () => void;
}) {
  return (
    <main className="page narrow center">
      <h1>All caught up</h1>
      <p>There is nothing more to study right now. Come back tomorrow.</p>
      <div className="actions">
        {mistakes > 0 && (
          <button type="button" className="btn big" onClick={onMistakes}>
            Practice Mistakes ({mistakes})
          </button>
        )}
        {canStudyAhead && (
          <button type="button" className="btn secondary" onClick={onAhead}>
            Study ahead
          </button>
        )}
        <button type="button" className="btn secondary" onClick={onHome}>
          Back to Home
        </button>
      </div>
    </main>
  );
}
