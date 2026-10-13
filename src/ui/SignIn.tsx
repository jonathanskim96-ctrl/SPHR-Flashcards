// Sign-in screen: email + password only. No sign-up link (sign-ups are off).
import { useState, type FormEvent } from 'react';

export function SignIn({
  onSignIn,
  initialError = null,
}: {
  onSignIn: (email: string, password: string) => Promise<string | null>;
  initialError?: string | null;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    setError(null);
    const problem = await onSignIn(email.trim(), password);
    setBusy(false);
    if (problem) setError(problem);
  }

  return (
    <main className="page narrow">
      <h1>SPHR Flashcards</h1>
      <form onSubmit={(e) => void submit(e)} className="stack">
        <label>
          Email
          <input
            type="email"
            name="email"
            autoComplete="username"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="error">
            ✗ {error}
          </p>
        )}
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
