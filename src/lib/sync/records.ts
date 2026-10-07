/**
 * Client side of sync protocol v2: pure, storage-free logic.
 *
 * The local database keeps its shape. For syncing, it is viewed as a set of independent records
 * (one per task / note / report, plus settings and memory). Every record that differs from what
 * the server is known to have is "pending" and carries a hybrid logical clock (hlc) assigned at
 * the moment of the edit. Remote records win only when their hlc is newer, so an old device
 * can never overwrite newer data, and only records a device actually changed are ever sent.
 */
import { normalizeDB, normalizeNote, normalizeReport, normalizeTask } from "@/lib/store.ts";
import type { DB, Note, Report, Task } from "@/lib/types.ts";

export const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Remote clocks further ahead than this are ignored so one broken device clock cannot drag the rest */
const MAX_CLOCK_AHEAD_MS = 24 * 60 * 60 * 1000;

export interface SyncedEntry {
  /** Hash of the local record content last known to match the server */
  h: string;
  hlc: string;
  /** Server holds a tombstone for this record */
  del?: boolean;
  /** Record is absent locally and the server knows it (deleted by this or another device) */
  gone?: boolean;
}

export interface PendingEntry {
  hlc: string;
  /** Hash of the local content this hlc was assigned to ("gone" for removals) */
  h: string;
}

export interface SyncState {
  v: 2;
  /** serverUrl|vaultId this state belongs to */
  scope: string;
  device: string;
  /** First full reconcile with the server finished */
  boot: boolean;
  lastSeq: number;
  wall: number;
  counter: number;
  /** serverNow - Date.now(), so every device stamps writes with (approximately) server time */
  offset: number;
  synced: Record<string, SyncedEntry>;
  pending: Record<string, PendingEntry>;
  /** Bridge to the legacy snapshot protocol used by apps that were not updated yet */
  legacy: { seenAt: number; activeUntil: number; wroteHash: string; checkedAt: number };
}

export interface RemoteRecord {
  k: string;
  h: string;
  del: boolean;
  /** Decoded payload; null means "record was removed" */
  v: unknown;
}

export interface PushItem {
  k: string;
  h: string;
  del: boolean;
  v: unknown;
  /** Content hash this item was built from */
  hash: string;
}

/* --------------------------------- hashing --------------------------------- */

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/** cyrb53: small, fast, good-enough change detector (not security relevant) */
export function hashOf(value: unknown): string {
  const str = stableStringify(value);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/* ----------------------------------- clock ---------------------------------- */

export function newDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createState(scope: string, device = newDeviceId()): SyncState {
  return {
    v: 2,
    scope,
    device,
    boot: false,
    lastSeq: 0,
    wall: 0,
    counter: 0,
    offset: 0,
    synced: {},
    pending: {},
    legacy: { seenAt: 0, activeUntil: 0, wroteHash: "", checkedAt: 0 },
  };
}

function formatHlc(wall: number, counter: number, device: string): string {
  return `${String(wall).padStart(14, "0")}-${String(counter).padStart(5, "0")}-${device}`;
}

function parseHlc(h: string): { wall: number; counter: number } | null {
  const m = /^(\d{14})-(\d{5})-[0-9a-f]{8}$/.exec(h);
  return m ? { wall: Number(m[1]), counter: Number(m[2]) } : null;
}

export function setServerTime(state: SyncState, serverNow: number, localNow = Date.now()) {
  state.offset = serverNow - localNow;
}

/** New timestamp, strictly greater than every timestamp this device has issued or seen */
export function tick(state: SyncState, localNow = Date.now()): string {
  const now = localNow + state.offset;
  if (now > state.wall) {
    state.wall = now;
    state.counter = 0;
  } else {
    state.counter++;
  }
  return formatHlc(state.wall, state.counter, state.device);
}

/** Move our clock past a remote timestamp so the next local edit is ordered after it */
export function observe(state: SyncState, hlc: string, localNow = Date.now()) {
  const p = parseHlc(hlc);
  if (!p || p.wall > localNow + state.offset + MAX_CLOCK_AHEAD_MS) return;
  if (p.wall > state.wall || (p.wall === state.wall && p.counter > state.counter)) {
    state.wall = p.wall;
    state.counter = p.counter;
  }
}

/* ------------------------------ record mapping ------------------------------ */

interface LocalRecord {
  value: unknown;
  hash: string;
  del: boolean;
}

const hashCache = new WeakMap<object, string>();

function cachedHash(obj: object, compute: () => string): string {
  let h = hashCache.get(obj);
  if (h === undefined) {
    h = compute();
    hashCache.set(obj, h);
  }
  return h;
}

function ringValue(t: Task) {
  return { id: t.id, due: t.due, notifiedAt: t.notifiedAt };
}

/**
 * notifiedAt is deliberately excluded from the task hash: ringing an alarm is not a user edit
 * and must never win against a concurrent real edit. It travels as its own `ring:` record.
 */
function taskHash(t: Task): string {
  return cachedHash(t, () => hashOf({ ...t, notifiedAt: null }));
}

function localRecords(db: DB): Map<string, LocalRecord> {
  const out = new Map<string, LocalRecord>();
  for (const t of db.tasks) {
    out.set(`task:${t.id}`, { value: t, hash: taskHash(t), del: !!t.deletedAt });
    if (t.notifiedAt && !t.deletedAt) {
      const v = ringValue(t);
      out.set(`ring:${t.id}`, { value: v, hash: hashOf(v), del: false });
    }
  }
  for (const n of db.notes) {
    out.set(`note:${n.id}`, { value: n, hash: cachedHash(n, () => hashOf(n)), del: !!n.deletedAt });
  }
  for (const r of db.reports) {
    out.set(`report:${r.date}`, {
      value: r,
      hash: cachedHash(r, () => hashOf(r)),
      del: !!r.deletedAt,
    });
  }
  out.set("settings", {
    value: db.settings,
    hash: cachedHash(db.settings, () => hashOf(db.settings)),
    del: false,
  });
  const memory = { text: db.aiMemory ?? "" };
  out.set("memory", { value: memory, hash: hashOf(memory), del: false });
  return out;
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf(":");
  return i === -1 ? [key, ""] : [key.slice(0, i), key.slice(i + 1)];
}

function updatedAtMs(v: unknown): number {
  const x = v as { updatedAt?: string; createdAt?: string } | null;
  const t = new Date(x?.updatedAt || x?.createdAt || 0).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Validates/normalizes a remote value the way the local store would. null = unusable */
function normalizeRemote(key: string, value: unknown): LocalRecord | null {
  const [kind, id] = splitKey(key);
  switch (kind) {
    case "task": {
      const t = normalizeTask(value);
      return t && t.id === id ? { value: t, hash: taskHash(t), del: !!t.deletedAt } : null;
    }
    case "note": {
      const n = normalizeNote(value);
      return n && n.id === id ? { value: n, hash: hashOf(n), del: !!n.deletedAt } : null;
    }
    case "report": {
      const r = normalizeReport(value);
      return r && r.date === id ? { value: r, hash: hashOf(r), del: !!r.deletedAt } : null;
    }
    case "settings": {
      if (typeof value !== "object" || value === null) return null;
      const settings = normalizeDB({ settings: value }).settings;
      return { value: settings, hash: hashOf(settings), del: false };
    }
    case "memory": {
      const text = (value as { text?: unknown } | null)?.text;
      if (typeof text !== "string") return null;
      const memory = { text: text.trim() };
      return { value: memory, hash: hashOf(memory), del: false };
    }
    default:
      return null;
  }
}

/** Keyed, O(1) mutable view of a db used while applying many remote records */
class Collection<T> {
  private map = new Map<string, T>();
  private original: string[];
  private originalSet: Set<string>;
  private added = new Set<string>();
  constructor(items: T[], idOf: (x: T) => string) {
    this.original = items.map(idOf);
    this.originalSet = new Set(this.original);
    items.forEach((it, i) => this.map.set(this.original[i], it));
  }
  get(id: string) {
    return this.map.get(id);
  }
  set(id: string, item: T) {
    if (!this.originalSet.has(id)) this.added.add(id);
    this.map.set(id, item);
  }
  delete(id: string) {
    this.map.delete(id);
  }
  /** Existing items keep their position; brand-new ones go to the front, newest first */
  toArray(): T[] {
    const fresh = [...this.added]
      .map((id) => this.map.get(id))
      .filter((x): x is T => x !== undefined)
      .reverse();
    const kept = this.original.map((id) => this.map.get(id)).filter((x): x is T => x !== undefined);
    return [...fresh, ...kept];
  }
}

class Working {
  tasks: Collection<Task>;
  notes: Collection<Note>;
  reports: Collection<Report>;
  settings: DB["settings"];
  aiMemory: string;
  changed = false;
  private db: DB;
  constructor(db: DB) {
    this.db = db;
    this.tasks = new Collection(db.tasks, (t) => t.id);
    this.notes = new Collection(db.notes, (n) => n.id);
    this.reports = new Collection(db.reports, (r) => r.date);
    this.settings = db.settings;
    this.aiMemory = db.aiMemory ?? "";
  }

  get(key: string): LocalRecord | null {
    const [kind, id] = splitKey(key);
    switch (kind) {
      case "task": {
        const t = this.tasks.get(id);
        return t ? { value: t, hash: taskHash(t), del: !!t.deletedAt } : null;
      }
      case "note": {
        const n = this.notes.get(id);
        return n ? { value: n, hash: hashOf(n), del: !!n.deletedAt } : null;
      }
      case "report": {
        const r = this.reports.get(id);
        return r ? { value: r, hash: hashOf(r), del: !!r.deletedAt } : null;
      }
      case "settings":
        return { value: this.settings, hash: hashOf(this.settings), del: false };
      case "memory": {
        const memory = { text: this.aiMemory };
        return { value: memory, hash: hashOf(memory), del: false };
      }
      case "ring": {
        const t = this.tasks.get(id);
        if (!t || !t.notifiedAt || t.deletedAt) return null;
        const v = ringValue(t);
        return { value: v, hash: hashOf(v), del: false };
      }
      default:
        return null;
    }
  }

  /** Writes a remote value (null = removal). Returns false when the value is unusable. */
  set(key: string, value: unknown): boolean {
    const [kind, id] = splitKey(key);
    if (kind === "ring") {
      const v = value as { due?: unknown; notifiedAt?: unknown } | null;
      if (!v || typeof v.notifiedAt !== "string") return false;
      const t = this.tasks.get(id);
      if (!t || t.deletedAt || t.due !== (v.due ?? null)) return true;
      if (t.notifiedAt && t.notifiedAt >= v.notifiedAt) return true;
      this.tasks.set(id, { ...t, notifiedAt: v.notifiedAt });
      this.changed = true;
      return true;
    }
    if (value === null) {
      if (kind === "task") this.tasks.delete(id);
      else if (kind === "note") this.notes.delete(id);
      else if (kind === "report") this.reports.delete(id);
      else return true;
      this.changed = true;
      return true;
    }
    const rec = normalizeRemote(key, value);
    if (!rec)
      return (
        kind !== "task" &&
        kind !== "note" &&
        kind !== "report" &&
        kind !== "settings" &&
        kind !== "memory"
      );
    this.changed = true;
    if (kind === "task") {
      const t = rec.value as Task;
      const old = this.tasks.get(id);
      // Keep "already rang" state of this device when the due date did not change
      if (
        old &&
        old.due === t.due &&
        old.notifiedAt &&
        (!t.notifiedAt || old.notifiedAt > t.notifiedAt)
      ) {
        this.tasks.set(id, { ...t, notifiedAt: old.notifiedAt });
      } else {
        this.tasks.set(id, t);
      }
    } else if (kind === "note") this.notes.set(id, rec.value as Note);
    else if (kind === "report") this.reports.set(id, rec.value as Report);
    else if (kind === "settings") this.settings = rec.value as DB["settings"];
    else if (kind === "memory") this.aiMemory = (rec.value as { text: string }).text;
    return true;
  }

  toDB(): DB {
    if (!this.changed) return this.db;
    return {
      ...this.db,
      settings: this.settings,
      aiMemory: this.aiMemory,
      tasks: this.tasks.toArray(),
      notes: this.notes.toArray(),
      reports: this.reports.toArray(),
    };
  }
}

/* --------------------------------- scanning --------------------------------- */

/** Detects local edits since the last sync and stamps them with a fresh hlc. Mutates `state`. */
export function scanDirty(db: DB, state: SyncState, localNow = Date.now()) {
  // Before the first reconcile the server clock offset is unknown and records are compared by
  // their own updatedAt instead, so stamping now would only plant a skewed clock in our hlc
  if (!state.boot) return;
  const records = localRecords(db);

  for (const [key, rec] of records) {
    const base = state.synced[key];
    if (key === "memory" && !base && (rec.value as { text: string }).text === "") continue;
    if (base && !base.gone && base.h === rec.hash) {
      delete state.pending[key];
      continue;
    }
    const p = state.pending[key];
    if (!p || p.h !== rec.hash) state.pending[key] = { hlc: tick(state, localNow), h: rec.hash };
  }

  for (const [key, base] of Object.entries(state.synced)) {
    if (records.has(key)) continue;
    const [kind] = splitKey(key);
    // Only kinds we own can be "deleted by absence"; unknown kinds belong to newer app versions
    if (kind !== "task" && kind !== "note" && kind !== "report") continue;
    if (base.gone || base.del) {
      // already deleted on the server (or a tombstone we pruned locally): nothing to tell anyone
      delete state.pending[key];
      continue;
    }
    const p = state.pending[key];
    if (!p || p.h !== "gone") state.pending[key] = { hlc: tick(state, localNow), h: "gone" };
  }
}

/** Builds the next batch of pending records (call scanDirty first). */
export function buildPush(
  db: DB,
  state: SyncState,
  maxItems = 100,
  maxChars = 400_000,
): PushItem[] {
  const records = localRecords(db);
  const items: PushItem[] = [];
  let chars = 0;
  for (const [key, p] of Object.entries(state.pending)) {
    const rec = records.get(key);
    const item: PushItem =
      p.h === "gone" || !rec
        ? { k: key, h: p.hlc, del: true, v: null, hash: "gone" }
        : { k: key, h: p.hlc, del: rec.del, v: rec.value, hash: rec.hash };
    const size = JSON.stringify(item.v).length + 200;
    if (items.length > 0 && chars + size > maxChars) break;
    items.push(item);
    chars += size;
    if (items.length >= maxItems) break;
  }
  return items;
}

/** The server stored (or already had) this exact write */
export function markPushed(state: SyncState, item: PushItem) {
  state.synced[item.k] = {
    h: item.hash === "gone" ? "" : item.hash,
    hlc: item.h,
    ...(item.del ? { del: true } : {}),
    ...(item.hash === "gone" ? { gone: true } : {}),
  };
  if (state.pending[item.k]?.hlc === item.h) delete state.pending[item.k];
}

/* ---------------------------------- applying -------------------------------- */

function localHlc(state: SyncState, key: string): string {
  return state.pending[key]?.hlc ?? state.synced[key]?.hlc ?? "";
}

/**
 * Applies records received from the server. Returns the new db (same object when nothing changed).
 * `bootstrap`: first reconcile on this device, where local data of unknown age meets server data;
 * the record's own `updatedAt` decides because no hlc exists for it yet.
 */
export function applyRemote(
  db: DB,
  state: SyncState,
  recs: RemoteRecord[],
  bootstrap: boolean,
): DB {
  const work = new Working(db);
  for (const rec of recs) {
    observe(state, rec.h);
    const key = rec.k;
    const [kind] = splitKey(key);
    const mergeable = kind === "task" || kind === "note" || kind === "report";
    const local = work.get(key);
    const gone = rec.v === null;
    const delFlag = rec.del ? { del: true } : {};

    if (!bootstrap && rec.h <= localHlc(state, key)) continue;

    // A deletion of something this device never had: just remember it, don't materialize a tombstone
    if (rec.del && mergeable && !local) {
      state.synced[key] = { h: "", hlc: rec.h, del: true, gone: true };
      delete state.pending[key];
      continue;
    }

    if (bootstrap && local && !gone) {
      const remote = normalizeRemote(key, rec.v);
      if (remote && remote.hash === local.hash) {
        state.synced[key] = { h: local.hash, hlc: rec.h, ...delFlag };
        delete state.pending[key];
        continue;
      }
      if (mergeable && updatedAtMs(local.value) > updatedAtMs(rec.v)) {
        // Local copy is genuinely newer: keep it; scanDirty sends it with an hlc after this one
        state.synced[key] = { h: "", hlc: rec.h, ...delFlag };
        delete state.pending[key];
        continue;
      }
    }

    work.set(key, rec.v);
    const after = work.get(key);
    state.synced[key] = gone
      ? { h: "", hlc: rec.h, del: true, gone: true }
      : { h: after?.hash ?? "", hlc: rec.h, ...delFlag };
    delete state.pending[key];
  }
  return work.toDB();
}

/**
 * After a server-side tombstone cleanup the server can no longer tell us about old deletions.
 * Anything this device had in sync with the server that the server no longer lists was deleted.
 */
export function dropRecordsMissingOnServer(db: DB, state: SyncState, seen: Set<string>): DB {
  const work = new Working(db);
  for (const [key, base] of Object.entries(state.synced)) {
    const [kind] = splitKey(key);
    if (seen.has(key) || base.gone || state.pending[key]) continue;
    if (kind !== "task" && kind !== "note" && kind !== "report" && kind !== "ring") continue;
    if (kind !== "ring") work.set(key, null);
    state.synced[key] = { h: "", hlc: base.hlc, del: true, gone: true };
  }
  return work.toDB();
}

/** Local tombstones are only needed until the server (and every device) has seen them */
export function pruneLocalTombstones(db: DB, state: SyncState, now = Date.now()): DB {
  const old = (iso: string | null | undefined) =>
    !!iso && now - new Date(iso).getTime() > TOMBSTONE_RETENTION_MS;
  const syncedOk = (key: string) => !!state.synced[key] && !state.pending[key];
  const tasks = db.tasks.filter((t) => !(old(t.deletedAt) && syncedOk(`task:${t.id}`)));
  const notes = db.notes.filter((n) => !(old(n.deletedAt) && syncedOk(`note:${n.id}`)));
  const reports = db.reports.filter((r) => !(old(r.deletedAt) && syncedOk(`report:${r.date}`)));
  if (
    tasks.length === db.tasks.length &&
    notes.length === db.notes.length &&
    reports.length === db.reports.length
  ) {
    return db;
  }
  return { ...db, tasks, notes, reports };
}
