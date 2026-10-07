import { loadDB, saveDB } from "@/lib/store.ts";
import type { DB } from "@/lib/types.ts";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * App database state. Writes are applied synchronously to a ref and to localStorage, so every
 * reader (including the background sync engine) always sees the latest committed db and
 * "update" never works on a stale snapshot.
 */
export function useDB() {
  const [db, setDbState] = useState<DB>(() => loadDB());
  const dbRef = useRef<DB>(db);

  const commit = useCallback((next: DB) => {
    dbRef.current = next;
    try {
      saveDB(next);
    } catch {
      // Storage full or blocked: keep working in memory
    }
    setDbState(next);
  }, []);

  // Synchronize state across multiple browser tabs
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "daily.db.v1") commit(loadDB());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [commit]);

  const setDb = commit;
  const update = useCallback((fn: (prev: DB) => DB) => commit(fn(dbRef.current)), [commit]);
  const getDb = useCallback(() => dbRef.current, []);
  return { db, setDb, update, getDb };
}
