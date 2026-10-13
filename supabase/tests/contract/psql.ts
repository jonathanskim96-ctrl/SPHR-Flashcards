// Runs SQL on the throwaway database started by supabase/tests/run.sh (it exports the
// connection settings). Values are passed as psql variables, exactly as the app's JSON.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set: run this through ./supabase/tests/run.sh`);
  return v;
};

export type SqlResult = { ok: true; out: string } | { ok: false; error: string };

export function sql(script: string, vars: Record<string, string> = {}): SqlResult {
  const args = [
    '-X',
    '-q',
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-h',
    env('PGHOST'),
    '-p',
    env('PGPORT'),
  ];
  args.push('-d', env('PGDATABASE'), '-U', 'postgres');
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  try {
    const out = execFileSync(join(env('PG_BIN'), 'psql'), args, {
      input: script,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, out: out.trim() };
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return { ok: false, error: (err.stderr || err.message).trim() };
  }
}

/** Like sql(), but any error fails the test. */
export function sqlOk(script: string, vars: Record<string, string> = {}): string {
  const r = sql(script, vars);
  if (!r.ok) throw new Error(r.error);
  return r.out;
}
