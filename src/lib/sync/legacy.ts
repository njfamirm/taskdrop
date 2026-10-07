/**
 * Bridge to the legacy snapshot protocol (whole encrypted db in one blob).
 *
 * Apps that were not updated yet still talk that protocol. While such an app is alive, updated
 * apps mirror to it: merge its snapshot into the local db when it changes and keep writing ours.
 * "Alive" means somebody else wrote the legacy snapshot in the last 14 days, so the bridge (and
 * its KV traffic) switches itself off once every old app is gone. On relays that do not speak
 * v2 at all (self-hosted older worker) it is the primary protocol.
 */
import { checkVaultVersion, pullFromVault, pushToVault, type SyncConfig } from "@/lib/cloudSync.ts";
import { hashOf, type SyncState } from "@/lib/sync/records.ts";
import { mergeDBs } from "@/lib/syncEngine.ts";
import type { DB } from "@/lib/types.ts";

const ACTIVE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const ACTIVE_CHECK_MS = 30_000;
const IDLE_CHECK_MS = 60 * 60_000;
const NO_LEGACY_RECHECK_MS = 60 * 60_000;

export interface LegacyHost {
  getDb(): DB;
  applyDb(fn: (db: DB) => DB): void;
}

function fingerprint(db: DB): string {
  return hashOf({ tasks: db.tasks, notes: db.notes, reports: db.reports });
}

/** Tasks/notes/reports follow the usual LWW merge; settings and memory stay owned by v2 */
function mergeLegacy(local: DB, remote: DB): DB {
  const merged = mergeDBs(local, remote);
  const same =
    JSON.stringify([merged.tasks, merged.notes, merged.reports]) ===
    JSON.stringify([local.tasks, local.notes, local.reports]);
  if (same) return local;
  return {
    ...local,
    tasks: merged.tasks,
    notes: merged.notes,
    reports: merged.reports,
    aiMemory: local.aiMemory || merged.aiMemory,
  };
}

/**
 * One mirroring step. Best effort in bridge mode (caller swallows errors), authoritative when
 * `primary` (relay without v2).
 */
export async function mirrorLegacy(
  host: LegacyHost,
  state: SyncState,
  cfg: SyncConfig,
  opts: { primary: boolean; force?: boolean },
): Promise<void> {
  const L = state.legacy;
  const now = Date.now();
  const active = L.activeUntil > now;
  const interval = opts.primary ? 0 : active ? ACTIVE_CHECK_MS : IDLE_CHECK_MS;
  if (!opts.force && now - L.checkedAt < interval) return;
  L.checkedAt = now;

  const ver = await checkVaultVersion(cfg.serverUrl, cfg.vaultId, cfg.authToken);
  // No legacy snapshot exists (every vault created after v2): look again only once an hour
  if (!ver && !opts.primary) L.checkedAt = now + NO_LEGACY_RECHECK_MS;

  if (ver && ver.updatedAt !== L.seenAt) {
    const remote = await pullFromVault(cfg.serverUrl, cfg.vaultId, cfg.secretKey, cfg.authToken);
    if (remote) {
      host.applyDb((db) => mergeLegacy(db, remote.db));
      // Somebody else wrote it (our own writes update seenAt) so an old app is alive
      L.activeUntil = Math.max(L.activeUntil, remote.updatedAt + ACTIVE_WINDOW_MS);
      L.seenAt = remote.updatedAt;
    }
  }

  const writeNeeded = opts.primary || L.activeUntil > now;
  if (!writeNeeded) return;
  const db = host.getDb();
  const fp = fingerprint(db);
  if (fp === L.wroteHash) return;
  const res = await pushToVault(cfg.serverUrl, cfg.vaultId, cfg.secretKey, db, cfg.authToken);
  L.seenAt = res.updatedAt;
  L.wroteHash = fp;
}
