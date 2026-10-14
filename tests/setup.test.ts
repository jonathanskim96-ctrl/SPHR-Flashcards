// The screen tests' wait limit (tests/setup.ts, loaded through vite.config.ts `setupFiles`) is
// in force in every test file without importing it (audit L17).
import { getConfig } from '@testing-library/dom';
import { expect, it } from 'vitest';

it('screen tests wait up to 10 seconds for something to appear', () => {
  expect(getConfig().asyncUtilTimeout).toBe(10_000);
});
