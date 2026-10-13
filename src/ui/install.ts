// Is the app running as an installed (Home Screen) app, or in a browser tab?
export interface DisplayEnv {
  matchMedia?: (q: string) => { matches: boolean };
  navigator?: { standalone?: boolean };
}

export function isStandalone(w: DisplayEnv = window as unknown as DisplayEnv): boolean {
  if (w.navigator?.standalone === true) return true; // iOS Safari's own flag
  return !!w.matchMedia?.('(display-mode: standalone)').matches;
}
