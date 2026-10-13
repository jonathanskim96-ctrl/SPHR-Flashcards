import { describe, expect, it } from 'vitest';
import { isStandalone } from './install';

const mq = (matches: boolean) => () => ({ matches });

describe('isStandalone', () => {
  it('is true for the display-mode media query', () => {
    expect(isStandalone({ matchMedia: mq(true) })).toBe(true);
  });
  it("is true for iOS Safari's navigator.standalone", () => {
    expect(isStandalone({ matchMedia: mq(false), navigator: { standalone: true } })).toBe(true);
  });
  it('is false in a browser tab', () => {
    expect(isStandalone({ matchMedia: mq(false), navigator: { standalone: false } })).toBe(false);
    expect(isStandalone({ navigator: {} })).toBe(false);
    expect(isStandalone({})).toBe(false);
  });
});
