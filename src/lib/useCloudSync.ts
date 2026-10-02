import {
  checkVaultVersion,
  getWebSocketUrl,
  loadSyncConfig,
  pullFromVault,
  pushToVault,
  saveSyncConfig,
} from "@/lib/cloudSync.ts";
import { decryptData, encryptData } from "@/lib/crypto.ts";
import { mergeDBs } from "@/lib/syncEngine.ts";
import type { DB } from "@/lib/types.ts";
import { useEffect, useRef, useState } from "react";

interface AutoSyncOptions {
  db: DB;
  onApplyRemote: (newDb: DB) => void;
  onStatusMessage?: (msg: string) => void;
}

/** Max time to hold alarms waiting for the first sync (e.g. device is offline) */
const INITIAL_SYNC_TIMEOUT_MS = 4000;

/** Returns true once the first sync attempt settled, so stale local state doesn't ring alarms. */
export function useAutoCloudSync({ db, onApplyRemote }: AutoSyncOptions): boolean {
  const [initialSyncDone, setInitialSyncDone] = useState(() => {
    const c = loadSyncConfig();
    return !(c.serverUrl && c.vaultId && c.secretKey);
  });
  useEffect(() => {
    if (initialSyncDone) return;
    const timer = setTimeout(() => setInitialSyncDone(true), INITIAL_SYNC_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [initialSyncDone]);
  const wsRef = useRef<WebSocket | null>(null);
  const lastPushedJsonRef = useRef<string>("");
  const isSyncingRef = useRef<boolean>(false);
  const lastRemoteUpdatedRef = useRef<number>(0);
  const dbRef = useRef<DB>(db);
  dbRef.current = db;

  const onApplyRemoteRef = useRef(onApplyRemote);
  onApplyRemoteRef.current = onApplyRemote;

  // 1. Pull and merge remote vault state via HTTP (fallback or initial load)
  const syncPull = async () => {
    const config = loadSyncConfig();
    if (!config.serverUrl || !config.vaultId || !config.secretKey || isSyncingRef.current) {
      return;
    }

    try {
      isSyncingRef.current = true;
      const remote = await pullFromVault(
        config.serverUrl,
        config.vaultId,
        config.secretKey,
        config.authToken,
      );

      if (remote && remote.updatedAt > lastRemoteUpdatedRef.current) {
        lastRemoteUpdatedRef.current = remote.updatedAt;
        const currentLocal = dbRef.current;
        const currentLocalStr = JSON.stringify(currentLocal);
        const remoteStr = JSON.stringify(remote.db);

        if (remoteStr !== currentLocalStr) {
          const merged = mergeDBs(currentLocal, remote.db);
          const mergedStr = JSON.stringify(merged);
          lastPushedJsonRef.current = mergedStr;
          onApplyRemoteRef.current(merged);

          // If merge generated local modifications, push merged state back to vault
          if (mergedStr !== remoteStr) {
            void pushToVault(
              config.serverUrl,
              config.vaultId,
              config.secretKey,
              merged,
              config.authToken,
            );
          }
        }

        saveSyncConfig({ ...config, lastSyncedAt: remote.updatedAt, enabled: true });
      }
    } catch {
      // Fail silently in background
    } finally {
      isSyncingRef.current = false;
      setInitialSyncDone(true);
    }
  };

  // 2. Manage real-time WebSocket connection for instant synchronization
  useEffect(() => {
    let isMounted = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingInterval: ReturnType<typeof setInterval> | null = null;
    let backoffMs = 1000;

    const connectWs = () => {
      if (!isMounted) return;
      const config = loadSyncConfig();
      if (!config.serverUrl || !config.vaultId || !config.secretKey) {
        return;
      }

      const wsUrl = getWebSocketUrl(config.serverUrl, config.vaultId, config.authToken);
      if (!wsUrl) return;

      try {
        if (wsRef.current) {
          wsRef.current.close();
          wsRef.current = null;
        }

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          backoffMs = 1000;
          ws.send(JSON.stringify({ type: "init", vaultId: config.vaultId }));
        };

        ws.onmessage = async (e) => {
          try {
            const data = JSON.parse(e.data as string) as {
              type?: string;
              payload?: string;
              updatedAt?: number;
            };

            if (
              (data.type === "remote_update" || data.type === "init") &&
              data.payload &&
              data.updatedAt
            ) {
              if (data.updatedAt > lastRemoteUpdatedRef.current) {
                lastRemoteUpdatedRef.current = data.updatedAt;
                const plainText = await decryptData(data.payload, config.secretKey);
                const remoteDb = JSON.parse(plainText) as DB;

                const currentLocal = dbRef.current;
                const currentLocalStr = JSON.stringify(currentLocal);
                const remoteStr = JSON.stringify(remoteDb);

                if (remoteStr !== currentLocalStr) {
                  const merged = mergeDBs(currentLocal, remoteDb);
                  const mergedStr = JSON.stringify(merged);
                  lastPushedJsonRef.current = mergedStr;
                  onApplyRemoteRef.current(merged);
                }

                saveSyncConfig({ ...config, lastSyncedAt: data.updatedAt, enabled: true });
              }
              setInitialSyncDone(true);
            }
          } catch {
            // Error parsing message
          }
        };

        ws.onerror = () => {
          // Handled by onclose
        };

        ws.onclose = () => {
          wsRef.current = null;
          if (isMounted) {
            reconnectTimer = setTimeout(() => {
              backoffMs = Math.min(backoffMs * 1.5, 15000);
              connectWs();
            }, backoffMs);
          }
        };
      } catch {
        // Fallback
      }
    };

    connectWs();

    // Heartbeat ping every 45s to keep connection alive
    pingInterval = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "ping" }));
      }
    }, 45000);

    // Re-verify version when tab gains focus or device goes online
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          connectWs();
        } else {
          const config = loadSyncConfig();
          if (config.serverUrl && config.vaultId) {
            void checkVaultVersion(config.serverUrl, config.vaultId, config.authToken).then(
              (ver) => {
                if (ver && ver.updatedAt > lastRemoteUpdatedRef.current) {
                  void syncPull();
                }
              },
            );
          }
        }
      }
    };

    const handleOnline = () => {
      connectWs();
      void syncPull();
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("online", handleOnline);

    return () => {
      isMounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingInterval) clearInterval(pingInterval);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("online", handleOnline);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  // 3. Debounced local push to server (1s debounce)
  useEffect(() => {
    const config = loadSyncConfig();
    if (!config.serverUrl || !config.vaultId || !config.secretKey) {
      return;
    }

    const currentJson = JSON.stringify(db);
    if (!lastPushedJsonRef.current) {
      lastPushedJsonRef.current = currentJson;
      void syncPull();
      return;
    }

    if (lastPushedJsonRef.current === currentJson) {
      return;
    }

    const timer = setTimeout(async () => {
      try {
        isSyncingRef.current = true;
        const now = Date.now();
        const cipher = await encryptData(currentJson, config.secretKey);

        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              type: "push",
              vaultId: config.vaultId,
              payload: cipher,
              updatedAt: now,
              version: 1,
            }),
          );
          lastPushedJsonRef.current = currentJson;
          lastRemoteUpdatedRef.current = now;
          saveSyncConfig({ ...config, lastSyncedAt: now, enabled: true });
        } else {
          const res = await pushToVault(
            config.serverUrl,
            config.vaultId,
            config.secretKey,
            db,
            config.authToken,
          );
          lastPushedJsonRef.current = currentJson;
          lastRemoteUpdatedRef.current = res.updatedAt;
          saveSyncConfig({ ...config, lastSyncedAt: res.updatedAt, enabled: true });
        }
      } catch {
        // Fail silently
      } finally {
        isSyncingRef.current = false;
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [db]);

  return initialSyncDone;
}
