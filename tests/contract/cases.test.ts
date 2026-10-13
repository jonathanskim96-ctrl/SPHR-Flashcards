// The app's validator against the shared boundary table. The same table runs against the
// real database in supabase/tests/contract/contract.test.ts.
import { describe, expect, it } from 'vitest';
import { validateAttempt, validateSettings, validateSubscription } from '../../src/domain/validate';
import { fakeBank } from '../helpers';
import { attemptCases, settingsCases, subscriptionCases } from './cases';

const now = Date.now();
describe('shared boundary table, app side', () => {
  it.each(attemptCases(fakeBank(), now).map((c) => [c.name, c] as const))('answer: %s', (_, c) => {
    expect(validateAttempt(c.value, now).ok).toBe(c.accept);
  });
  it.each(settingsCases().map((c) => [c.name, c] as const))('settings: %s', (_, c) => {
    expect(validateSettings(c.value).ok).toBe(c.accept !== false);
  });
  it.each(subscriptionCases().map((c) => [c.name, c] as const))('subscription: %s', (_, c) => {
    expect(validateSubscription(c.value).ok).toBe(c.accept);
  });
  it('case names are unique', () => {
    for (const cases of [attemptCases(fakeBank(), now), settingsCases(), subscriptionCases()]) {
      const names = cases.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});
