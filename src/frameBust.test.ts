import { describe, expect, it, vi } from 'vitest';
import { bustFrame, type FrameWindow } from './frameBust';

function win(framed: boolean, throws = false) {
  const top = { location: {} as { href: string } } as FrameWindow;
  if (throws)
    Object.defineProperty(top.location, 'href', {
      set() {
        throw new Error('SecurityError');
      },
    });
  const self = {
    location: { href: 'https://example.test/app' },
    top: null,
  } as unknown as FrameWindow;
  self.self = self;
  self.top = framed ? top : self;
  return { self, top };
}

describe('bustFrame', () => {
  it('does nothing when the app is the top page', () => {
    const hide = vi.fn();
    expect(bustFrame(win(false).self, hide)).toBe(false);
    expect(hide).not.toHaveBeenCalled();
  });
  it('hides the app and loads it as the top page when framed', () => {
    const w = win(true);
    const hide = vi.fn();
    expect(bustFrame(w.self, hide)).toBe(true);
    expect(hide).toHaveBeenCalled();
    expect(w.top.location.href).toBe('https://example.test/app');
  });
  it('stays hidden when the top page cannot be navigated', () => {
    const hide = vi.fn();
    expect(bustFrame(win(true, true).self, hide)).toBe(true);
    expect(hide).toHaveBeenCalled();
  });
  it('copes with no accessible top page', () => {
    const w = win(true);
    w.self.top = null;
    expect(bustFrame(w.self, () => {})).toBe(true);
  });
});
