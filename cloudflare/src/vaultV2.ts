import {
  handleVaultRequest,
  type RecordRow,
  type VaultReply,
  type VaultRequest,
  type VaultStorage,
} from "./vaultCore.ts";

interface SqlCursor<T> {
  toArray(): T[];
  one(): T;
}

interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<T>;
}

interface DurableObjectState {
  storage: { sql: SqlStorage; transactionSync<T>(fn: () => T): T };
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(): WebSocket[];
  setWebSocketAutoResponse(pair: unknown): void;
}

declare const WebSocketRequestResponsePair: new (request: string, response: string) => unknown;

/** SQLite-backed storage living inside the Durable Object (strongly consistent, persistent) */
class SqlVaultStorage implements VaultStorage {
  private sql: SqlStorage;
  private seqCache: number | null = null;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, seq INTEGER NOT NULL, hlc TEXT NOT NULL, del INTEGER NOT NULL, blob TEXT NOT NULL, at INTEGER NOT NULL)",
    );
    sql.exec("CREATE INDEX IF NOT EXISTS records_seq ON records (seq)");
    sql.exec("CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value INTEGER NOT NULL)");
  }

  get(key: string): RecordRow | null {
    const rows = this.sql
      .exec<RecordRow>("SELECT key, seq, hlc, del, blob, at FROM records WHERE key = ?", key)
      .toArray();
    return rows[0] ?? null;
  }

  put(row: RecordRow): void {
    this.sql.exec(
      "INSERT INTO records (key, seq, hlc, del, blob, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET seq = excluded.seq, hlc = excluded.hlc, del = excluded.del, blob = excluded.blob, at = excluded.at",
      row.key,
      row.seq,
      row.hlc,
      row.del,
      row.blob,
      row.at,
    );
  }

  since(seq: number, limit: number): RecordRow[] {
    return this.sql
      .exec<RecordRow>(
        "SELECT key, seq, hlc, del, blob, at FROM records WHERE seq > ? ORDER BY seq ASC LIMIT ?",
        seq,
        limit,
      )
      .toArray();
  }

  invalidate(): void {
    this.seqCache = null;
  }

  count(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM records").one().n;
  }

  getMeta(name: string): number {
    if (name === "seq" && this.seqCache !== null) return this.seqCache;
    const rows = this.sql
      .exec<{ value: number }>("SELECT value FROM meta WHERE name = ?", name)
      .toArray();
    const value = rows[0]?.value ?? 0;
    if (name === "seq") this.seqCache = value;
    return value;
  }

  setMeta(name: string, value: number): void {
    this.sql.exec(
      "INSERT INTO meta (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
      name,
      value,
    );
    if (name === "seq") this.seqCache = value;
  }

  pruneTombstones(olderThan: number): number {
    const rows = this.sql
      .exec<{ m: number | null }>(
        "SELECT MAX(seq) AS m FROM records WHERE del = 1 AND at < ?",
        olderThan,
      )
      .toArray();
    const maxSeq = rows[0]?.m ?? 0;
    if (maxSeq > 0) this.sql.exec("DELETE FROM records WHERE del = 1 AND at < ?", olderThan);
    return maxSeq;
  }
}

/**
 * One Durable Object per vault. Holds every record of the vault in SQLite and tells connected
 * devices (WebSocket, hibernation API so idle sockets cost nothing) that something changed.
 * Clients always pull the actual data, so a missed hint can never lose an update.
 */
export class VaultV2 {
  private ctx: DurableObjectState;
  private store: SqlVaultStorage;

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.ctx = ctx;
    this.store = new SqlVaultStorage(ctx.storage.sql);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1] as unknown as WebSocket);
      return new Response(null, {
        status: 101,
        webSocket: pair[0],
      } as ResponseInit & { webSocket?: WebSocket });
    }

    if (request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ t: "error", code: "bad_request", message: "Invalid JSON" }, 400);
      }
      const { reply, changed } = this.process(body as VaultRequest);
      if (changed && reply.t === "push") this.broadcast(null, reply.seq);
      return json(reply, reply.t === "error" ? 400 : 200);
    }

    return json({ t: "error", code: "not_found", message: "Not found" }, 404);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    let msg: { id?: number; req?: VaultRequest };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const { reply, changed } = this.process(msg.req as VaultRequest);
    ws.send(JSON.stringify({ id: msg.id, res: reply }));
    if (changed && reply.t === "push") this.broadcast(ws, reply.seq);
  }

  webSocketClose(ws: WebSocket): void {
    try {
      ws.close(1000, "closed");
    } catch {}
  }

  private process(req: VaultRequest): { reply: VaultReply; changed: boolean } {
    try {
      return this.ctx.storage.transactionSync(() =>
        handleVaultRequest(this.store, req, Date.now()),
      );
    } catch (err) {
      this.store.invalidate();
      return {
        reply: {
          t: "error",
          code: "internal",
          message: err instanceof Error ? err.message : "Internal error",
        },
        changed: false,
      };
    }
  }

  private broadcast(except: WebSocket | null, seq: number): void {
    const hint = JSON.stringify({ t: "changed", seq });
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(hint);
      } catch {}
    }
  }
}

function json(data: object, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
