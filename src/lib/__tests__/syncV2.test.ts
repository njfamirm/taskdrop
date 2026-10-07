import {
  handleVaultRequest,
  type RecordRow,
  type VaultRequest,
  type VaultStorage,
} from "../../../cloudflare/src/vaultCore.ts";
import { decryptRecord, encryptRecord } from "@/lib/crypto.ts";
import { SyncError, syncCycle, type CycleDeps } from "@/lib/sync/cycle.ts";
import { createState, scanDirty, type SyncState } from "@/lib/sync/records.ts";
import { DEFAULT_DB, type DB, type Task } from "@/lib/types.ts";
import { describe, expect, it } from "vite-plus/test";

class MemoryStorage implements VaultStorage {
  rows = new Map<string, RecordRow>();
  meta = new Map<string, number>();
  get(key: string) {
    return this.rows.get(key) ?? null;
  }
  put(row: RecordRow) {
    this.rows.set(row.key, row);
  }
  since(seq: number, limit: number) {
    return [...this.rows.values()]
      .filter((r) => r.seq > seq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }
  count() {
    return this.rows.size;
  }
  getMeta(name: string) {
    return this.meta.get(name) ?? 0;
  }
  setMeta(name: string, v: number) {
    this.meta.set(name, v);
  }
  pruneTombstones(olderThan: number) {
    let max = 0;
    for (const [k, r] of this.rows) {
      if (r.del && r.at < olderThan) {
        max = Math.max(max, r.seq);
        this.rows.delete(k);
      }
    }
    return max;
  }
}

const VAULT = "TASK-TEST01";
const SECRET = "correct horse battery staple";
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

class World {
  server = new MemoryStorage();
  time = Date.UTC(2026, 9, 1, 12, 0, 0);
  advance(ms: number) {
    this.time += ms;
  }
  async request(req: VaultRequest) {
    return handleVaultRequest(this.server, JSON.parse(JSON.stringify(req)), this.time).reply;
  }
}

class Device {
  db: DB;
  state: SyncState;
  skew: number;
  secret: string;
  world: World;
  constructor(world: World, name: string, opts: { skew?: number; db?: DB; secret?: string } = {}) {
    this.world = world;
    this.skew = opts.skew ?? 0;
    this.secret = opts.secret ?? SECRET;
    this.db = opts.db ?? structuredClone(DEFAULT_DB);
    this.state = createState(
      `test|${VAULT}`,
      name
        .padEnd(8, "0")
        .slice(0, 8)
        .replace(/[^0-9a-f]/g, "a"),
    );
  }
  now = () => this.world.time + this.skew;
  iso = () => new Date(this.now()).toISOString();
  deps(): CycleDeps {
    return {
      state: this.state,
      getDb: () => this.db,
      applyDb: (fn) => {
        this.db = fn(this.db);
      },
      request: (req) => this.world.request(req) as never,
      encrypt: (k, p) => encryptRecord(p, this.secret, VAULT, k),
      decrypt: (k, b) => decryptRecord(b, this.secret, VAULT, k),
      saveState: () => {},
      now: this.now,
    };
  }
  sync() {
    return syncCycle(this.deps());
  }
  /** The app stamps edits the moment the db changes, not when the network round happens */
  commit(db: DB) {
    this.db = db;
    scanDirty(this.db, this.state, this.now());
  }
  task(id: string) {
    return this.db.tasks.find((t) => t.id === id);
  }
  edit(id: string, patch: Partial<Task>) {
    this.commit({
      ...this.db,
      tasks: this.db.tasks.map((t) =>
        t.id === id ? { ...t, ...patch, updatedAt: this.iso() } : t,
      ),
    });
  }
  add(id: string, patch: Partial<Task> = {}) {
    const t: Task = {
      id,
      title: `task ${id}`,
      description: null,
      due: null,
      repeat: "none",
      priority: "none",
      done: false,
      createdAt: this.iso(),
      updatedAt: this.iso(),
      doneAt: null,
      deletedAt: null,
      notifiedAt: null,
      tags: [],
      ...patch,
    };
    this.commit({ ...this.db, tasks: [t, ...this.db.tasks] });
  }
}

describe("sync v2", () => {
  it("removing a due date reaches the other device (the original bug)", async () => {
    const w = new World();
    const a = new Device(w, "aaaaaaa1");
    const b = new Device(w, "bbbbbbb2");
    a.add("t1", { due: "2026-10-02T09:00:00.000Z" });
    await a.sync();
    await b.sync();
    expect(b.task("t1")?.due).toBe("2026-10-02T09:00:00.000Z");

    w.advance(5000);
    a.edit("t1", { due: null });
    await a.sync();
    w.advance(5000);
    await b.sync();
    expect(b.task("t1")?.due).toBeNull();
  });

  it("an old device opening later does not override newer data and sends nothing", async () => {
    const w = new World();
    const a = new Device(w, "aaaaaaa1");
    const old = new Device(w, "bbbbbbb2");
    a.add("t1", { title: "v1" });
    await a.sync();
    await old.sync();

    for (let i = 2; i <= 5; i++) {
      w.advance(DAY);
      a.edit("t1", { title: `v${i}` });
      await a.sync();
    }
    w.advance(30 * DAY);
    const r = await old.sync();
    expect(r.pushed).toBe(0);
    expect(old.task("t1")?.title).toBe("v5");
    await a.sync();
    expect(a.task("t1")?.title).toBe("v5");
  });

  it("a real offline edit wins only if it is newer", async () => {
    const w = new World();
    const a = new Device(w, "aaaaaaa1");
    const b = new Device(w, "bbbbbbb2");
    a.add("t1", { title: "base" });
    a.add("t2", { title: "base" });
    await a.sync();
    await b.sync();

    w.advance(MIN);
    b.edit("t1", { title: "b-early" }); // offline edits
    w.advance(MIN);
    a.edit("t1", { title: "a-late" });
    a.edit("t2", { title: "a-early" });
    w.advance(MIN);
    b.edit("t2", { title: "b-late" });
    await a.sync();
    await b.sync();
    await a.sync();
    expect(a.task("t1")?.title).toBe("a-late");
    expect(b.task("t1")?.title).toBe("a-late");
    expect(a.task("t2")?.title).toBe("b-late");
    expect(b.task("t2")?.title).toBe("b-late");
  });

  it("device clock skew does not drop or reorder updates", async () => {
    const w = new World();
    const a = new Device(w, "aaaaaaa1");
    const slow = new Device(w, "bbbbbbb2", { skew: -10 * MIN });
    const fast = new Device(w, "ccccccc3", { skew: +3 * 60 * MIN });
    a.add("t1", { title: "base" });
    await a.sync();
    await slow.sync();
    await fast.sync();

    w.advance(MIN);
    a.edit("t1", { title: "from-a" });
    await a.sync();
    await slow.sync();
    expect(slow.task("t1")?.title).toBe("from-a");

    w.advance(MIN);
    slow.edit("t1", { title: "from-slow" }); // slow clock, but really the latest edit
    await slow.sync();
    await fast.sync();
    expect(fast.task("t1")?.title).toBe("from-slow");

    w.advance(MIN);
    fast.edit("t1", { title: "from-fast" });
    await fast.sync();
    await a.sync();
    await slow.sync();
    expect(a.task("t1")?.title).toBe("from-fast");
    expect(slow.task("t1")?.title).toBe("from-fast");
  });

  it("concurrent edits on different tasks are both kept", async () => {
    const w = new World();
    const a = new Device(w, "aaaaaaa1");
    const b = new Device(w, "bbbbbbb2");
    a.add("t1");
    a.add("t2");
    await a.sync();
    await b.sync();
    a.edit("t1", { done: true });
    b.edit("t2", { priority: "high" });
    await a.sync();
    await b.sync();
    await a.sync();
    for (const d of [a, b]) {
      expect(d.task("t1")?.done).toBe(true);
      expect(d.task("t2")?.priority).toBe("high");
    }
  });

  it("deletions propagate and a tombstone is not resurrected by a stale device", async () => {
    const w = new World();
    const a = new Device(w, "aaaaaaa1");
    const b = new Device(w, "bbbbbbb2");
    a.add("t1");
    await a.sync();
    await b.sync();
    w.advance(MIN);
    a.edit("t1", { deletedAt: a.iso() });
    await a.sync();
    await b.sync();
    expect(b.task("t1")?.deletedAt).toBeTruthy();
    const r = await b.sync();
    expect(r.pushed).toBe(0);
  });

  it("tasks that vanish locally (import/replace) are deleted everywhere", async () => {
    const w = new World();
    const a = new Device(w, "aaaaaaa1");
    const b = new Device(w, "bbbbbbb2");
    a.add("t1");
    a.add("t2");
    await a.sync();
    await b.sync();
    w.advance(MIN);
    a.commit({ ...a.db, tasks: a.db.tasks.filter((t) => t.id !== "t1") });
    await a.sync();
    await b.sync();
    expect(b.task("t1")).toBeUndefined();
    expect(b.task("t2")).toBeDefined();
  });

  it("a ringing alarm never overrides a concurrent real edit, but the 'already rang' state syncs", async () => {
    const w = new World();
    const a = new Device(w, "aaaaaaa1");
    const b = new Device(w, "bbbbbbb2");
    a.add("t1", { due: "2026-10-01T12:00:00.000Z" });
    await a.sync();
    await b.sync();

    w.advance(MIN);
    b.edit("t1", { due: "2026-10-05T12:00:00.000Z", notifiedAt: null }); // user snoozes on B
    w.advance(MIN);
    a.commit({
      ...a.db,
      tasks: a.db.tasks.map((t) => (t.id === "t1" ? { ...t, notifiedAt: a.iso() } : t)), // A rings the old due
    });
    await a.sync();
    await b.sync();
    await a.sync();
    expect(a.task("t1")?.due).toBe("2026-10-05T12:00:00.000Z");
    expect(b.task("t1")?.due).toBe("2026-10-05T12:00:00.000Z");
    expect(a.task("t1")?.notifiedAt).toBeNull();
    expect(b.task("t1")?.notifiedAt).toBeNull();

    // plain ring (no edit) reaches the other device
    w.advance(MIN);
    a.commit({
      ...a.db,
      tasks: a.db.tasks.map((t) => (t.id === "t1" ? { ...t, notifiedAt: a.iso() } : t)),
    });
    await a.sync();
    await b.sync();
    expect(b.task("t1")?.notifiedAt).toBe(a.task("t1")?.notifiedAt);
  });

  it("settling: syncing twice in a row sends nothing", async () => {
    const w = new World();
    const a = new Device(w, "aaaaaaa1");
    const b = new Device(w, "bbbbbbb2");
    a.add("t1", { due: "2026-10-02T09:00:00.000Z", tags: ["x"] });
    await a.sync();
    await b.sync();
    expect((await a.sync()).pushed).toBe(0);
    expect((await b.sync()).pushed).toBe(0);
    expect((await a.sync()).pulled).toBe(0);
  });

  it("first sync of a device that already has local data merges by updatedAt", async () => {
    const w = new World();
    const a = new Device(w, "aaaaaaa1");
    a.add("shared", { title: "server-old" });
    a.add("server-only");
    await a.sync();
    w.advance(DAY);
    const fresh = new Device(w, "bbbbbbb2");
    fresh.add("local-only");
    // pretend this older local copy of "shared" is newer than what the server has
    w.advance(DAY);
    fresh.add("shared", { title: "local-newer" });
    await fresh.sync();
    await a.sync();
    for (const d of [a, fresh]) {
      expect(d.task("shared")?.title).toBe("local-newer");
      expect(d.task("server-only")).toBeDefined();
      expect(d.task("local-only")).toBeDefined();
    }
  });

  it("settings and memory are shared, new device adopts them", async () => {
    const w = new World();
    const a = new Device(w, "aaaaaaa1");
    a.commit({ ...a.db, aiMemory: "remember me", settings: { ...a.db.settings, theme: "light" } });
    await a.sync();
    const b = new Device(w, "bbbbbbb2");
    await b.sync();
    expect(b.db.aiMemory).toBe("remember me");
    expect(b.db.settings.theme).toBe("light");
    expect((await b.sync()).pushed).toBe(0);
  });

  it("a device that missed pruned tombstones resets and drops zombies", async () => {
    const w = new World();
    const a = new Device(w, "aaaaaaa1");
    const stale = new Device(w, "bbbbbbb2");
    a.add("t1");
    a.add("t2");
    await a.sync();
    await stale.sync();

    w.advance(MIN);
    a.edit("t1", { deletedAt: a.iso() });
    await a.sync();
    w.advance(31 * DAY);
    a.add("t3");
    await a.sync(); // triggers server-side pruning of the old tombstone
    expect(w.server.rows.has("task:t1")).toBe(false);

    await stale.sync();
    expect(stale.task("t1")).toBeUndefined();
    expect(stale.task("t2")).toBeDefined();
    expect(stale.task("t3")).toBeDefined();
  });

  it("if the server lost its data, devices repopulate it", async () => {
    const w = new World();
    const a = new Device(w, "aaaaaaa1");
    const b = new Device(w, "bbbbbbb2");
    a.add("t1");
    await a.sync();
    await b.sync();
    w.server = new MemoryStorage();
    await b.sync();
    const c = new Device(w, "ccccccc3");
    await c.sync();
    expect(c.task("t1")).toBeDefined();
  });

  it("wrong secret key fails loudly and does not advance the cursor", async () => {
    const w = new World();
    const a = new Device(w, "aaaaaaa1");
    a.add("t1");
    await a.sync();
    const bad = new Device(w, "bbbbbbb2", { secret: "nope" });
    await expect(bad.sync()).rejects.toBeInstanceOf(SyncError);
    expect(bad.state.lastSeq).toBe(0);
    expect(bad.state.boot).toBe(false);
    expect(bad.db.tasks).toHaveLength(0);
  });

  it("a retried push (lost ack) is idempotent", async () => {
    const w = new World();
    const a = new Device(w, "aaaaaaa1");
    a.add("t1");
    const deps = a.deps();
    let dropped = false;
    const send = (req: Parameters<CycleDeps["request"]>[0]) => w.request(req) as never;
    deps.request = async (req) => {
      const res = await Promise.resolve(send(req));
      if (req.t === "push" && !dropped) {
        dropped = true;
        throw new Error("network down after server stored the write");
      }
      return res;
    };
    await expect(syncCycle(deps)).rejects.toThrow();
    const seqAfterFirst = w.server.getMeta("seq");
    const r = await a.sync();
    expect(r.pushed).toBeGreaterThan(0);
    expect(w.server.getMeta("seq")).toBe(seqAfterFirst);
    const b = new Device(w, "bbbbbbb2");
    await b.sync();
    expect(b.task("t1")).toBeDefined();
  });

  it("edits made before the first sync cannot plant a skewed clock", async () => {
    const w = new World();
    const a = new Device(w, "aaaaaaa1");
    const fast = new Device(w, "ccccccc3", { skew: 3 * 60 * MIN });
    fast.add("early"); // created offline on a device whose clock is 3h ahead
    await fast.sync();
    w.advance(MIN);
    fast.edit("early", { title: "fast-edit" });
    await fast.sync();
    await a.sync();
    w.advance(MIN);
    a.edit("early", { title: "a-edit-later" });
    await a.sync();
    await fast.sync();
    expect(fast.task("early")?.title).toBe("a-edit-later");
    expect(fast.state.wall).toBeLessThanOrEqual(w.time + 5 * MIN);
  });

  it("sequential pushes keep seq and stored rows consistent", async () => {
    const w = new World();
    const r = await w.request({ t: "info" });
    expect(r.t).toBe("info");
    for (let i = 0; i < 3; i++) {
      await w.request({
        t: "push",
        recs: [{ k: `task:q${i}`, h: `01790856180000-0000${i}-aaaaaaaa`, d: 0, b: "x" }],
      });
    }
    expect(w.server.getMeta("seq")).toBe(3);
    expect(w.server.rows.size).toBe(3);
  });

  it("scales: a big vault bootstraps quickly and incrementally afterwards", async () => {
    const w = new World();
    const a = new Device(w, "aaaaaaa1");
    for (let i = 0; i < 6000; i++) a.add(`bulk-${i}`, { tags: ["t"], description: "x".repeat(40) });
    const t0 = Date.now();
    await a.sync();
    const b = new Device(w, "bbbbbbb2");
    await b.sync();
    expect(b.db.tasks).toHaveLength(6000);
    expect(Date.now() - t0).toBeLessThan(20_000);

    a.edit("bulk-7", { title: "edited" });
    const r = await a.sync();
    expect(r.pushed).toBe(1);
    const r2 = await b.sync();
    expect(r2.pulled).toBe(1);
    expect(b.task("bulk-7")?.title).toBe("edited");
  }, 60_000);
});
