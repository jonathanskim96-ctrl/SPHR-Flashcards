// The Content-Security-Policy added to the built page (vite.config.ts) is as strict as
// BUILD_PLAN Phase 6 says: connect-src names only this site and the Supabase project.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

const { contentSecurityPolicy } = await (async () => {
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
  const csp = contentSecurityPolicy('https://abcd.supabase.co/some/path');
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
