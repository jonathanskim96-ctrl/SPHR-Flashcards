// Installable-app plumbing: registers the service worker (offline use) and tells the screens
// when a newer version of the app has been installed in the background, so the "New version:
// Reload" banner can offer a reload. Nothing here reloads by itself: she may be mid-card.
export interface PwaState {
  /** A newer copy of the app is installed; reloading shows it. */
  updateReady: boolean;
  /** Why offline use could not be set up, if it couldn't. */
  error: string | null;
}

type Listener = () => void;

let state: PwaState = { updateReady: false, error: null };
const listeners = new Set<Listener>();

function set(patch: Partial<PwaState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export const pwaStore = {
  get: (): PwaState => state,
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  /** Tests only. */
  reset() {
    state = { updateReady: false, error: null };
  },
};

/** Minimal slice of `navigator.serviceWorker` that this file uses (so tests can fake it). */
export interface SwContainer {
  controller: unknown;
  register(url: string, options: { scope: string }): Promise<{ update(): Promise<unknown> }>;
  addEventListener(type: 'controllerchange', l: () => void): void;
}

export interface RegisterOptions {
  container?: SwContainer | undefined;
  base?: string;
  onVisible?: (cb: () => void) => void;
}

const CHECK_EVERY_MS = 60 * 60 * 1000;

/**
 * Registers `<base>sw.js`. The worker skips waiting and claims open pages (vite.config.ts), so
 * a *new* worker taking over a page that already had one means a new version is installed.
 * The very first install also takes control, but that is not an update.
 */
export async function registerServiceWorker({
  container = typeof navigator === 'undefined'
    ? undefined
    : (navigator.serviceWorker as SwContainer | undefined),
  base = import.meta.env.BASE_URL,
  onVisible = (cb) => document.addEventListener('visibilitychange', cb),
}: RegisterOptions = {}): Promise<void> {
  if (!container) {
    set({ error: 'this browser cannot keep the app for offline use' });
    return;
  }
  let hadController = !!container.controller;
  container.addEventListener('controllerchange', () => {
    if (hadController) set({ updateReady: true });
    hadController = true; // from now on this page has a worker, so the next change is an update
  });
  try {
    const reg = await container.register(`${base}sw.js`, { scope: base });
    const check = () => {
      reg.update().catch(() => {
        // Offline or the server is busy: try again at the next check.
      });
    };
    onVisible(() => {
      if (document.visibilityState === 'visible') check();
    });
    setInterval(check, CHECK_EVERY_MS);
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e) });
  }
}
