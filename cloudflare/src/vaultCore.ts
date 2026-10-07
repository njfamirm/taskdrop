/**
 * Sync protocol v2 core: per-record last-writer-wins store with a server-assigned sequence.
 *
 * The relay never sees plaintext. Each record is an opaque encrypted `blob` plus plaintext
 * metadata (`key`, `hlc`, `del`). Ordering decisions use the hybrid logical clock (`hlc`) that the
 * clients generate, while "what changed since I last looked" uses `seq`, which only the server
 * increments. That split is what makes the protocol immune to device clock skew when pulling.
 *
 * This file is storage-agnostic so it can be unit-tested without Cloudflare (see VaultStorage).
 */

export interface RecordRow {
  key: string;
  seq: number;
  hlc: string;
  del: number;
  blob: string;
  at: number;
}

export interface VaultStorage {
  get(key: string): RecordRow | null;
  put(row: RecordRow): void;
  /** Rows with seq > since, ascending by seq */
  since(seq: number, limit: number): RecordRow[];
  count(): number;
  getMeta(name: string): number;
  setMeta(name: string, value: number): void;
  /** Delete tombstones written before `olderThan`; returns the highest seq that was removed (0 if none) */
  pruneTombstones(olderThan: number): number;
}

export interface WireRecord {
  k: string;
  s: number;
  h: string;
  d: 0 | 1;
  b: string;
}

export type VaultRequest =
  | { t: "info" }
  | { t: "pull"; since: number }
  | { t: "push"; recs: { k: string; h: string; d: 0 | 1; b: string }[] };

export type VaultReply =
  | { t: "info"; proto: 2; now: number; seq: number }
  | { t: "pull"; now: number; seq: number; reset: boolean; recs: WireRecord[]; more: boolean }
  | {
      t: "push";
      now: number;
      seq: number;
      results: ({ k: string; ok: true } | { k: string; ok: false; cur: WireRecord })[];
    }
  | { t: "error"; code: string; message: string };

export const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MAX_PUSH_RECORDS = 200;
export const MAX_BLOB_CHARS = 256 * 1024;
export const MAX_RECORDS_PER_VAULT = 100_000;
const PULL_MAX_ROWS = 500;
const PULL_MAX_CHARS = 700 * 1024;

const KEY_RE = /^[a-z]{1,12}(:[A-Za-z0-9_.-]{1,100})?$/;
const HLC_RE = /^\d{14}-\d{5}-[0-9a-f]{8}$/;

function toWire(row: RecordRow): WireRecord {
  return { k: row.key, s: row.seq, h: row.hlc, d: row.del ? 1 : 0, b: row.blob };
}

function error(code: string, message: string): VaultReply {
  return { t: "error", code, message };
}

/** Processes one request. `changed` tells the caller whether other connected devices must be notified. */
export function handleVaultRequest(
  store: VaultStorage,
  req: VaultRequest,
  now: number,
): { reply: VaultReply; changed: boolean } {
  const reply = (r: VaultReply, changed = false) => ({ reply: r, changed });

  if (!req || typeof req !== "object") return reply(error("bad_request", "Invalid request"));

  if (req.t === "info") {
    return reply({ t: "info", proto: 2, now, seq: store.getMeta("seq") });
  }

  if (req.t === "pull") {
    let since = Number.isFinite(req.since) && req.since > 0 ? Math.floor(req.since) : 0;
    let reset = false;
    // The client is older than the oldest tombstone we still keep: it may have missed deletions
    if (since > 0 && since < store.getMeta("prunedSeq")) {
      since = 0;
      reset = true;
    }
    const rows: WireRecord[] = [];
    let chars = 0;
    let more = false;
    for (const row of store.since(since, PULL_MAX_ROWS + 1)) {
      if (
        rows.length >= PULL_MAX_ROWS ||
        (rows.length > 0 && chars + row.blob.length > PULL_MAX_CHARS)
      ) {
        more = true;
        break;
      }
      rows.push(toWire(row));
      chars += row.blob.length;
    }
    return reply({ t: "pull", now, seq: store.getMeta("seq"), reset, recs: rows, more });
  }

  if (req.t === "push") {
    if (!Array.isArray(req.recs) || req.recs.length === 0 || req.recs.length > MAX_PUSH_RECORDS) {
      return reply(error("bad_request", `recs must contain 1-${MAX_PUSH_RECORDS} records`));
    }
    for (const r of req.recs) {
      if (
        !r ||
        typeof r.k !== "string" ||
        !KEY_RE.test(r.k) ||
        typeof r.h !== "string" ||
        !HLC_RE.test(r.h) ||
        typeof r.b !== "string" ||
        r.b.length === 0 ||
        r.b.length > MAX_BLOB_CHARS
      ) {
        return reply(error("bad_record", "Malformed record"));
      }
    }

    maybePrune(store, now);

    // Reject over-quota batches before writing anything so seq and rows can never diverge
    const newKeys = new Set(req.recs.filter((r) => !store.get(r.k)).map((r) => r.k));
    if (store.count() + newKeys.size > MAX_RECORDS_PER_VAULT) {
      return reply(error("quota", "Vault record limit reached"));
    }

    const results: Extract<VaultReply, { t: "push" }>["results"] = [];
    let seq = store.getMeta("seq");
    let changed = false;
    for (const r of req.recs) {
      const cur = store.get(r.k);
      if (cur && r.h <= cur.hlc) {
        // Same hlc = retry of a write we already stored (lost ack): treat as success
        results.push(
          r.h === cur.hlc ? { k: r.k, ok: true } : { k: r.k, ok: false, cur: toWire(cur) },
        );
        continue;
      }
      seq++;
      store.put({ key: r.k, seq, hlc: r.h, del: r.d ? 1 : 0, blob: r.b, at: now });
      results.push({ k: r.k, ok: true });
      changed = true;
    }
    if (changed) store.setMeta("seq", seq);
    return reply({ t: "push", now, seq, results }, changed);
  }

  return reply(error("bad_request", "Unknown request type"));
}

function maybePrune(store: VaultStorage, now: number) {
  if (now - store.getMeta("lastPrune") < PRUNE_INTERVAL_MS) return;
  store.setMeta("lastPrune", now);
  const maxSeq = store.pruneTombstones(now - TOMBSTONE_RETENTION_MS);
  if (maxSeq > store.getMeta("prunedSeq")) store.setMeta("prunedSeq", maxSeq);
}
