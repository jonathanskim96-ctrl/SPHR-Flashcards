// The Content-Security-Policy added to the built page (vite.config.ts) is as strict as
// BUILD_PLAN Phase 6 says: connect-src names only this site and the Supabase project.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

const { contentSecurityPolicy, checkSupabaseUrl } = await (async () => {
  const server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  try {
    return await server.ssrLoadModule('/vite.config.ts');
  } finally {
    await server.close();
  }
})();

test('connect-src is limited to this site and the Supabase origin', () => {
  const csp = contentSecurityPolicy('https://abcd.supabase.co');
  assert.match(csp, /connect-src 'self' https:\/\/abcd\.supabase\.co(;|$)/);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /style-src 'self'(;|$)/);
  assert.match(csp, /img-src 'self' data:/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
});

test('without a Supabase address only this site is allowed', () => {
  assert.match(contentSecurityPolicy(undefined), /connect-src 'self'(;|$)/);
});

test('a bad address stops the build instead of loosening the policy', () => {
  assert.throws(() => contentSecurityPolicy('not a url'));
});

test('the Supabase address must be the bare project address', () => {
  for (const ok of [undefined, '', 'https://qwerty7.supabase.co', 'http://supabase.test'])
    assert.doesNotThrow(() => checkSupabaseUrl(ok), String(ok));
  const bad = {
    'https://qwerty7.supabase.co/rest/v1/': /something extra/,
    'https://qwerty7.supabase.co/': /something extra/,
    'https://qwerty7.supabase.co ': /something extra/,
    'https://qwerty7.supabase.co\r\n': /something extra/,
    ' https://qwerty7.supabase.co': /something extra/,
    'https://qwerty7.supabase.co?x=1': /something extra/,
    'http://qwerty7.supabase.co': /must start with https/,
    NEZItdgU5HVC5lea: /not a web address/,
    'qwerty7.supabase.co': /not a web address/,
  };
  for (const [value, message] of Object.entries(bad)) {
    assert.throws(() => checkSupabaseUrl(value), message, JSON.stringify(value));
    // The message says how to fix it and never repeats the value (it might be a secret).
    assert.throws(
      () => checkSupabaseUrl(value),
      (e) => e.message.includes('Project URL') && !e.message.includes(value.trim()),
    );
    assert.throws(() => contentSecurityPolicy(value), message);
  }
});
