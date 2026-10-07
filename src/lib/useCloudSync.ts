import { loadSyncConfig } from "@/lib/cloudSync.ts";
import { syncClient } from "@/lib/sync/client.ts";
import type { DB } from "@/lib/types.ts";
import { useEffect, useRef, useState } from "react";

interface AutoSyncOptions {
  db: DB;
  getDb: () => DB;
  /** Must apply `fn` synchronously and persist the result */
  applyDb: (fn: (db: DB) => DB) => void;
}

/** Max time to hold alarms waiting for the first sync (e.g. device is offline) */
const INITIAL_SYNC_TIMEOUT_MS = 4000;

/**
 * Runs background cloud sync for the lifetime of the app.
 * Returns true once the first sync attempt settled, so stale local state doesn't ring alarms.
 */
export function useAutoCloudSync({ db, getDb, applyDb }: AutoSyncOptions): boolean {
  const [settled, setSettled] = useState(() => {
    const c = loadSyncConfig();
    return !(c.serverUrl && c.vaultId && c.secretKey);
  });

  const hostRef = useRef({ getDb, applyDb });
  hostRef.current = { getDb, applyDb };

  useEffect(() => {
    syncClient.attach({
      getDb: () => hostRef.current.getDb(),
      applyDb: (fn) => hostRef.current.applyDb(fn),
    });
    if (syncClient.getStatus().settled) setSettled(true);
    const unsubscribe = syncClient.subscribe((s) => {
      if (s.settled) setSettled(true);
    });
    const timer = setTimeout(() => setSettled(true), INITIAL_SYNC_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
      unsubscribe();
      syncClient.detach();
    };
  }, []);

  // Stamp local edits the moment they happen so offline edits keep their real order
  useEffect(() => {
    syncClient.notifyLocalChange();
  }, [db]);

  return settled;
}
