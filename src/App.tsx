// The app shell: restores the saved login, opens the user's session on this phone, and
// switches between the screens. Screens live in src/ui.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openSession, type Session } from './data/session';
import { errorText } from './data/store';
import { buildLesson, type Selection } from './domain/lesson';
import type { Mode, Question } from './domain/types';
import type { AuthApi } from './ui/auth';
import type { PushDeps } from './data/push';
import { NO_PUSH, productionDeps, type AppDeps, type AppEnv } from './ui/deps';
import { CaughtUp, LessonEnd } from './ui/EndScreens';
import { Home, mistakesCount } from './ui/Home';
import { Lesson, type CardResult } from './ui/Lesson';
import { ReminderOffer, showReminderOffer, useReminderRefresh } from './ui/reminder';
import { Settings } from './ui/Settings';
import { SignIn } from './ui/SignIn';
import { UpdateBanner } from './ui/UpdateBanner';
import { useStudy } from './ui/useStudy';

type Phase =
  | { name: 'starting' }
  | { name: 'signed-out'; error: string | null }
  | { name: 'ready'; session: Session };

export function App(props: { makeDeps?: () => AppDeps }) {
  return (
    <>
      <UpdateBanner />
      <Root {...props} />
    </>
  );
}

function Root({ makeDeps = productionDeps }: { makeDeps?: () => AppDeps }) {
  const built = useMemo(() => {
    try {
      return { deps: makeDeps(), error: null };
    } catch (e) {
      return { deps: null, error: errorText(e) };
    }
  }, [makeDeps]);
  if (!built.deps)
    return (
      <main className="page narrow">
        <h1>SPHR Flashcards</h1>
        <p role="alert" className="error">
          ✗ {built.error}
        </p>
      </main>
    );
  return <Gate deps={built.deps} />;
}

function Gate({ deps }: { deps: AppDeps }) {
  const [phase, setPhase] = useState<Phase>({ name: 'starting' });
  const started = useRef(false);

  const open = useCallback(
    async (userId: string): Promise<string | null> => {
      try {
        const session = await openSession({
          userId,
          backend: deps.backend,
          ...deps.sessionOptions,
        });
        setPhase({ name: 'ready', session });
        return null;
      } catch (e) {
        return `Could not open your data on this phone: ${errorText(e)}`;
      }
    },
    [deps],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    deps.auth.currentUser().then(
      async (user) => {
        if (!user) return setPhase({ name: 'signed-out', error: null });
        const problem = await open(user.id);
        if (problem) setPhase({ name: 'signed-out', error: problem });
      },
      (e: unknown) =>
        setPhase({ name: 'signed-out', error: `Could not check your sign-in: ${errorText(e)}` }),
    );
  }, [deps, open]);

  if (phase.name === 'starting')
    return (
      <main className="page narrow">
        <h1>SPHR Flashcards</h1>
        <p role="status">Loading…</p>
      </main>
    );
  if (phase.name === 'signed-out')
    return (
      <SignIn
        initialError={phase.error}
        onSignIn={async (email, password) => {
          const r = await deps.auth.signIn(email, password);
          return r.ok ? open(r.user.id) : r.error;
        }}
      />
    );
  return (
    <Main
      session={phase.session}
      auth={deps.auth}
      env={deps.env}
      push={deps.push ?? NO_PUSH}
      onSignedOut={() => setPhase({ name: 'signed-out', error: null })}
    />
  );
}

type Screen =
  | { name: 'home' }
  | { name: 'settings' }
  | { name: 'lesson'; mode: Mode; selection: Selection; questions: Question[]; run: number }
  | { name: 'end'; mode: Mode; selection: Selection; results: CardResult[] }
  | { name: 'caught-up'; selection: Selection };

function Main({
  session,
  auth,
  env,
  push,
  onSignedOut,
}: {
  session: Session;
  auth: AuthApi;
  env: AppEnv;
  push: PushDeps;
  onSignedOut: () => void;
}) {
  const { study, error } = useStudy(session, env);
  const reminderRefresh = useReminderRefresh(
    session,
    push,
    study?.settings.reminderEnabled ?? false,
    env.installed && !!study,
  );
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const runs = useRef(0);

  const start = (mode: Mode, selection: Selection) => {
    if (!study?.bank) return;
    const questions = buildLesson({
      bank: study.bank,
      states: study.states,
      settings: study.settings,
      today: study.today,
      selection,
      mode,
    });
    setScreen(
      questions.length
        ? { name: 'lesson', mode, selection, questions, run: ++runs.current }
        : { name: 'caught-up', selection },
    );
  };

  const onEnd = useCallback(
    (mode: Mode, selection: Selection) => (results: CardResult[]) =>
      setScreen({ name: 'end', mode, selection, results }),
    [],
  );

  if (error && !study)
    return (
      <main className="page narrow">
        <h1>SPHR Flashcards</h1>
        <p role="alert" className="error">
          ✗ {error}
        </p>
      </main>
    );
  if (!study)
    return (
      <main className="page narrow">
        <p role="status">Loading…</p>
      </main>
    );

  const errorBanner = error && (
    <p role="alert" className="error banner">
      ✗ {error}
    </p>
  );

  let body;
  switch (screen.name) {
    case 'settings':
      body = (
        <Settings
          session={session}
          study={study}
          auth={auth}
          env={env}
          push={push}
          reminderRefresh={reminderRefresh}
          onBack={() => setScreen({ name: 'home' })}
          onSignedOut={onSignedOut}
        />
      );
      break;
    case 'lesson':
      body = study.bank && (
        <Lesson
          key={screen.run}
          session={session}
          bank={study.bank}
          env={env}
          mode={screen.mode}
          initial={screen.questions}
          onEnd={onEnd(screen.mode, screen.selection)}
          onQuit={() => setScreen({ name: 'home' })}
        />
      );
      break;
    case 'end':
      body = (
        <LessonEnd
          results={screen.results}
          onKeepGoing={() => start(screen.mode, screen.selection)}
          onDone={() => setScreen({ name: 'home' })}
        />
      );
      break;
    case 'caught-up': {
      const ahead =
        study.bank &&
        buildLesson({
          bank: study.bank,
          states: study.states,
          settings: study.settings,
          today: study.today,
          selection: screen.selection,
          mode: 'ahead',
        }).length > 0;
      body = (
        <CaughtUp
          mistakes={mistakesCount(study, screen.selection)}
          canStudyAhead={!!ahead}
          onMistakes={() => start('mistakes', screen.selection)}
          onAhead={() => start('ahead', screen.selection)}
          onHome={() => setScreen({ name: 'home' })}
        />
      );
      break;
    }
    default:
      body = (
        <Home
          study={study}
          onStart={start}
          onSettings={() => setScreen({ name: 'settings' })}
          offer={
            showReminderOffer(study, push, env.installed) && (
              <ReminderOffer session={session} push={push} study={study} />
            )
          }
        />
      );
  }
  return (
    <>
      {errorBanner}
      {body}
    </>
  );
}
