/**
 * Runs the real client sync code against a live relay (wrangler dev or production-like worker).
 * Skipped unless SYNC_E2E_URL is set, e.g.:  SYNC_E2E_URL=http://localhost:8799 vp test --run syncV2.e2e
 */
import { decryptRecord, encryptRecord } from "@/lib/crypto.ts";
import { syncCycle, type CycleDeps } from "@/lib/sync/cycle.ts";
import { createState, scanDirty, type SyncState } from "@/lib/sync/records.ts";
import { DEFAULT_DB, type DB, type Task } from "@/lib/types.ts";
import { describe, expect, it } from "vite-plus/test";

const BASE = process.env.SYNC_E2E_URL;
const SECRET = "e2e secret";

class Peer {
  db: DB = structuredClone(DEFAULT_DB);
  state: SyncState;
  vault: string;
  constructor(vault: string, device: string) {
    this.vault = vault;
    this.state = createState(`e2e|${vault}`, device);
  }
  deps(): CycleDeps {
    return {
      state: this.state,
      getDb: () => this.db,
      applyDb: (fn) => {
        this.db = fn(this.db);
      },
      request: async (req) => {
        const res = await fetch(`${BASE}/v2/api/${this.vault}`, {
          method: "POST",
          body: JSON.stringify(req),
        });
        return (await res.json()) as never;
      },
      encrypt: (k, p) => encryptRecord(p, SECRET, this.vault, k),
      decrypt: (k, b) => decryptRecord(b, SECRET, this.vault, k),
      saveState: () => {},
    };
  }
  sync() {
    return syncCycle(this.deps());
  }
  edit(id: string, patch: Partial<Task>) {
    const now = new Date().toISOString();
    const exists = this.db.tasks.some((t) => t.id === id);
    const base: Task = {
      id,
      title: id,
      description: null,
      due: null,
      repeat: "none",
      priority: "none",
      done: false,
      createdAt: now,
      updatedAt: now,
      doneAt: null,
      deletedAt: null,
      notifiedAt: null,
      tags: [],
    };
    this.db = {
      ...this.db,
      tasks: exists
        ? this.db.tasks.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: now } : t))
        : [{ ...base, ...patch }, ...this.db.tasks],
    };
    scanDirty(this.db, this.state);
  }
}

describe.skipIf(!BASE)("sync v2 against a live relay", () => {
  it("syncs two devices over HTTP, removing a due date included", async () => {
    const vault = `E2E-${Date.now()}`;
    const a = new Peer(vault, "aaaaaaaa");
    const b = new Peer(vault, "bbbbbbbb");
    a.edit("t1", { due: "2026-10-09T09:00:00.000Z" });
    await a.sync();
    await b.sync();
    expect(b.db.tasks[0].due).toBe("2026-10-09T09:00:00.000Z");
    await new Promise((r) => setTimeout(r, 20));
    a.edit("t1", { due: null });
    await a.sync();
    await b.sync();
    expect(b.db.tasks[0].due).toBeNull();
    expect((await b.sync()).pushed).toBe(0);
  });

  it("rejects malformed and oversized input", async () => {
    const vault = `E2E-BAD-${Date.now()}`;
    const post = async (body: unknown) =>
      (await (
        await fetch(`${BASE}/v2/api/${vault}`, { method: "POST", body: JSON.stringify(body) })
      ).json()) as {
        t: string;
        code?: string;
      };
    expect((await post({ t: "nope" })).t).toBe("error");
    expect((await post({ t: "push", recs: [] })).t).toBe("error");
    expect(
      (
        await post({
          t: "push",
          recs: [{ k: "../x", h: "00000000000001-00000-aaaaaaaa", d: 0, b: "x" }],
        })
      ).t,
    ).toBe("error");
    expect((await post({ t: "push", recs: [{ k: "task:1", h: "bad", d: 0, b: "x" }] })).t).toBe(
      "error",
    );
    const big = "x".repeat(300 * 1024);
    expect(
      (
        await post({
          t: "push",
          recs: [{ k: "task:1", h: "00000000000001-00000-aaaaaaaa", d: 0, b: big }],
        })
      ).t,
    ).toBe("error");
  });

  it("broadcasts a change hint over WebSocket to other devices only", async () => {
    const vault = `E2E-WS-${Date.now()}`;
    const wsBase = BASE!.replace(/^http/, "ws");
    const open = (): Promise<WebSocket> =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`${wsBase}/v2/ws/${vault}`);
        ws.onopen = () => resolve(ws);
        ws.onerror = () => reject(new Error("ws error"));
      });
    const listener = await open();
    const writer = await open();
    const hints: unknown[] = [];
    const writerMsgs: unknown[] = [];
    const raw: string[] = [];
    listener.onmessage = (e) => {
      raw.push(e.data as string);
      if (e.data !== "pong") hints.push(JSON.parse(e.data as string));
    };
    writer.onmessage = (e) => writerMsgs.push(JSON.parse(e.data as string));

    const a = new Peer(vault, "aaaaaaaa");
    a.edit("t1", {});
    // push through the socket
    const rec = {
      k: "task:ws1",
      h: "01790856180000-00000-aaaaaaaa",
      d: 0,
      b: await encryptRecord("{}", SECRET, vault, "task:ws1"),
    };
    writer.send(JSON.stringify({ id: 1, req: { t: "push", recs: [rec] } }));
    await new Promise((r) => setTimeout(r, 500));
    expect(hints).toEqual([{ t: "changed", seq: 1 }]);
    expect(writerMsgs).toHaveLength(1);
    expect((writerMsgs[0] as { id: number }).id).toBe(1);

    listener.send("ping");
    await new Promise((r) => setTimeout(r, 200));
    expect(raw).toContain("pong");
    listener.close();
    writer.close();
  });

  it("survives a vault with thousands of records (paging)", async () => {
    const vault = `E2E-BULK-${Date.now()}`;
    const a = new Peer(vault, "aaaaaaaa");
    for (let i = 0; i < 1500; i++) a.edit(`bulk-${i}`, { tags: ["x"] });
    const t0 = Date.now();
    await a.sync();
    const b = new Peer(vault, "bbbbbbbb");
    await b.sync();
    expect(b.db.tasks).toHaveLength(1500);
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 90_000);
});
