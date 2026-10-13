// "New version: Reload" banner, shown when the service worker has installed a newer copy of
// the app (src/pwa.ts). She taps Reload when she is between cards.
import { useSyncExternalStore } from 'react';
import { pwaStore } from '../pwa';

export function UpdateBanner({ reload = () => window.location.reload() }: { reload?: () => void }) {
  const { updateReady } = useSyncExternalStore(pwaStore.subscribe, pwaStore.get);
  if (!updateReady) return null;
  return (
    <div role="status" className="update-banner">
      <span>New version available.</span>
      <button type="button" onClick={reload}>
        New version: Reload
      </button>
    </div>
  );
}

/** Settings footer line: says so if the app could not be set up for offline use. */
export function OfflineLine() {
  const { error } = useSyncExternalStore(pwaStore.subscribe, pwaStore.get);
  if (!error) return null;
  return <div role="status">Offline use is not available: {error}.</div>;
}
