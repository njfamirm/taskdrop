/**
 * One sync round against a v2 relay: pull -> apply -> push. Transport, crypto and persistence are
 * injected so the exact same code runs in the app and in the multi-device tests.
 */
import type { DB } from "@/lib/types.ts";
import {
  applyRemote,
  buildPush,
  dropRecordsMissingOnServer,
  markPushed,
  pruneLocalTombstones,
  scanDirty,
  setServerTime,
  type PushItem,
  type RemoteRecord,
  type SyncState,
} from "@/lib/sync/records.ts";

interface WireRecord {
  k: string;
  s: number;
  h: string;
  d: 0 | 1;
  b: string;
}

type Reply =
  | { t: "info"; proto: 2; now: number; seq: number }
  | { t: "pull"; now: number; seq: number; reset: boolean; recs: WireRecord[]; more: boolean }
  | {
      t: "push";
      now: number;
      seq: number;
      results: ({ k: string; ok: true } | { k: string; ok: false; cur: WireRecord })[];
    }
  | { t: "error"; code: string; message: string };

type Request =
  | { t: "info" }
  | { t: "pull"; since: number }
  | { t: "push"; recs: { k: string; h: string; d: 0 | 1; b: string }[] };

export class SyncError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface CycleDeps {
  state: SyncState;
  getDb(): DB;
  /** Must invoke `fn` synchronously, exactly once, with the latest db */
  applyDb(fn: (db: DB) => DB): void;
  request(req: Request): Promise<Reply>;
  encrypt(recordKey: string, plain: string): Promise<string>;
  decrypt(recordKey: string, blob: string): Promise<string>;
  saveState(): void;
  now?(): number;
}

async function decode(d: CycleDeps, rec: WireRecord): Promise<RemoteRecord> {
  let plain: string;
  try {
    plain = await d.decrypt(rec.k, rec.b);
  } catch {
    throw new SyncError("decrypt", "Cannot decrypt vault data: wrong secret key?");
  }
  let v: unknown;
  try {
    v = JSON.parse(plain);
  } catch {
    throw new SyncError("decrypt", "Corrupted record in vault");
  }
  return { k: rec.k, h: rec.h, del: rec.d === 1, v };
}

function expect<T extends Reply["t"]>(reply: Reply, t: T): Extract<Reply, { t: T }> {
  if (reply.t === "error") throw new SyncError(reply.code, reply.message);
  if (reply.t !== t) throw new SyncError("protocol", `Unexpected reply ${reply.t}`);
  return reply as Extract<Reply, { t: T }>;
}

export async function pullAll(d: CycleDeps): Promise<number> {
  const s = d.state;
  let total = 0;
  let restarted = false;

  for (;;) {
    const bootstrap = !s.boot;
    let since = bootstrap ? 0 : s.lastSeq;
    let resetting = false;
    const seen = new Set<string>();
    let restart = false;

    for (;;) {
      const res = expect(await d.request({ t: "pull", since }), "pull");
      setServerTime(s, res.now, d.now?.());

      if (!bootstrap && !restarted && res.seq < s.lastSeq) {
        // The server has less history than we have already consumed: it lost data. Re-reconcile.
        s.boot = false;
        s.lastSeq = 0;
        s.synced = {};
        s.pending = {};
        restarted = true;
        restart = true;
        break;
      }
      if (res.reset) resetting = true;

      const decoded: RemoteRecord[] = [];
      for (const rec of res.recs) decoded.push(await decode(d, rec));
      d.applyDb((db) => applyRemote(db, s, decoded, bootstrap));
      // db and sync baseline must hit storage in the same tick, or a crash could leave them inconsistent
      d.saveState();
      for (const rec of decoded) seen.add(rec.k);
      total += decoded.length;

      if (res.more) {
        since = res.recs[res.recs.length - 1].s;
        if (!bootstrap && !resetting) s.lastSeq = since;
        d.saveState();
        continue;
      }

      if (resetting) {
        d.applyDb((db) => dropRecordsMissingOnServer(db, s, seen));
        d.saveState();
      }
      if (bootstrap) s.boot = true;
      s.lastSeq = res.seq;
      d.saveState();
      break;
    }

    if (!restart) return total;
  }
}

export async function pushPending(d: CycleDeps): Promise<number> {
  const s = d.state;
  let pushed = 0;

  for (let round = 0; round < 200; round++) {
    scanDirty(d.getDb(), s, d.now?.());
    const items = buildPush(d.getDb(), s);
    if (items.length === 0) break;

    const recs = await Promise.all(
      items.map(async (i) => ({
        k: i.k,
        h: i.h,
        d: (i.del ? 1 : 0) as 0 | 1,
        b: await d.encrypt(i.k, JSON.stringify(i.v)),
      })),
    );
    const res = expect(await d.request({ t: "push", recs }), "push");
    setServerTime(s, res.now, d.now?.());

    const byKey = new Map<string, PushItem>(items.map((i) => [i.k, i]));
    const rejected: WireRecord[] = [];
    for (const r of res.results) {
      const item = byKey.get(r.k);
      if (!item) continue;
      if (r.ok) {
        markPushed(s, item);
        pushed++;
      } else {
        rejected.push(r.cur);
      }
    }
    if (rejected.length > 0) {
      // Server holds a newer version: adopt it instead of fighting
      const decoded: RemoteRecord[] = [];
      for (const rec of rejected) decoded.push(await decode(d, rec));
      d.applyDb((db) => applyRemote(db, s, decoded, false));
    }
    d.saveState();
  }
  return pushed;
}

export async function syncCycle(d: CycleDeps): Promise<{ pulled: number; pushed: number }> {
  const pulled = await pullAll(d);
  d.applyDb((db) => pruneLocalTombstones(db, d.state, d.now?.()));
  d.saveState();
  const pushed = await pushPending(d);
  d.saveState();
  return { pulled, pushed };
}
