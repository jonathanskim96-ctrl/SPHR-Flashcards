// Frame-busting: if another site puts this app inside a frame, hide it and load it as the
// top page instead. (The CSP's frame-ancestors can't be set from a meta tag, so this is the
// second line of defence.) Called once, first thing, from main.tsx.
export interface FrameWindow {
  self: FrameWindow;
  top: FrameWindow | null;
  location: { href: string };
}

export function bustFrame(win: FrameWindow, hide: () => void): boolean {
  if (win.top === win.self) return false;
  hide();
  try {
    if (win.top) win.top.location.href = win.self.location.href;
  } catch {
    // A sandboxed frame may not navigate the top page; the app stays hidden.
  }
  return true;
}
