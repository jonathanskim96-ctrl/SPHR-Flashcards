// The sync status line for Settings (BUILD_PLAN Phase 3): "All answers backed up" /
// "3 answers waiting to back up" / the last error, plus any notices (an answer the server
// refused, a settings conflict) until she dismisses them. Text nodes only.
import { useEffect, useState } from 'react';
import type { LocalStore } from '../data/store';
import { syncStatusText, type SyncEngine, type SyncStatus } from '../data/sync';

export function useSyncStatus(engine: SyncEngine, store: LocalStore): SyncStatus | null {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  useEffect(() => {
    let live = true;
    const refresh = () => {
      engine.status().then(
        (s) => {
          if (live) setStatus(s);
        },
        (e: unknown) => {
          if (live)
            setStatus((old) => ({
              ...(old ?? EMPTY),
              lastError: `Could not read the sync status: ${String(e)}`,
            }));
        },
      );
    };
    refresh();
    const offEngine = engine.subscribe(refresh);
    const offStore = store.subscribe(refresh);
    return () => {
      live = false;
      offEngine();
      offStore();
    };
  }, [engine, store]);
  return status;
}

const EMPTY: SyncStatus = {
  running: false,
  offline: false,
  pendingAnswers: 0,
  pendingSettings: false,
  lastSyncAt: null,
  lastError: null,
  notices: [],
};

export function SyncStatusView({
  status,
  onDismiss,
}: {
  status: SyncStatus | null;
  onDismiss: () => void;
}) {
  if (!status) return <p role="status">Checking backup…</p>;
  return (
    <div>
      <div role="status">
        {syncStatusText(status).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {status.notices.length > 0 && (
        <div role="alert">
          <ul>
            {status.notices.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
          <button type="button" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

export function SyncStatusLine({ engine, store }: { engine: SyncEngine; store: LocalStore }) {
  const status = useSyncStatus(engine, store);
  return <SyncStatusView status={status} onDismiss={() => void store.dismissNotices()} />;
}
