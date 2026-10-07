/**
 * Runtime of cloud sync: owns the connection, schedules rounds and persists the sync state.
 * The data logic lives in records.ts / cycle.ts (pure and unit-tested); this file only glues it
 * to the network, timers, tabs and localStorage.
 */
import {
  getAuthHeaders,
  getWebSocketUrlV2,
  loadSyncConfig,
  resolveEffectiveServerUrl,
  saveSyncConfig,
  type SyncConfig,
} from "@/lib/cloudSync.ts";
import { decryptRecord, encryptRecord } from "@/lib/crypto.ts";
import { SyncError, syncCycle, type CycleDeps } from "@/lib/sync/cycle.ts";
import { mirrorLegacy } from "@/lib/sync/legacy.ts";
import { createState, scanDirty, type SyncState } from "@/lib/sync/records.ts";
import type { DB } from "@/lib/types.ts";

export interface SyncHost {
  getDb(): DB;
  /** Must call `fn` synchronously, exactly once, and persist the result before returning */
  applyDb(fn: (db: DB) => DB): void;
}

export type SyncPhase = "off" | "idle" | "syncing" | "offline" | "error";

export interface SyncStatus {
  phase: SyncPhase;
  message?: string;
  lastSyncedAt?: number;
  /** First round settled (success or failure): safe to start alarms */
  settled: boolean;
}

type Request = Parameters<CycleDeps["request"]>[0];
type Reply = Awaited<ReturnType<CycleDeps["request"]>>;

const STATE_KEY = "taskdrop_sync_v2";
const LOCK_NAME = "taskdrop-sync-v2";
const LOCAL_DEBOUNCE_MS = 800;
const STATE_SAVE_DEBOUNCE_MS = 500;
const RPC_TIMEOUT_MS = 20_000;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const POLL_TICK_MS = 20_000;

function scopeOf(cfg: SyncConfig): string {
  return `${resolveEffectiveServerUrl(cfg.serverUrl)}|${cfg.vaultId}`;
}

function isConfigured(cfg: SyncConfig): boolean {
  return Boolean(cfg.serverUrl?.trim() && cfg.vaultId?.trim() && cfg.secretKey?.trim());
}

function loadState(scope: string): SyncState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as SyncState;
      if (parsed && parsed.v === 2 && parsed.scope === scope) return parsed;
      if (parsed && parsed.v === 2 && parsed.device) return createState(scope, parsed.device);
    }
  } catch {}
  return createState(scope);
}

class SyncClient {
  private host: SyncHost | null = null;
  private started = false;
  private gen = 0;
  private lockRelease: (() => void) | null = null;
  private leader = false;

  private state: SyncState | null = null;
  private mode: "unknown" | "v2" | "legacy" = "unknown";
  private status: SyncStatus = { phase: "off", settled: false };
  private listeners = new Set<(s: SyncStatus) => void>();

  private chain: Promise<unknown> = Promise.resolve();
  private queued = false;
  private localTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private retryMs = 5000;

  private ws: WebSocket | null = null;
  private wsBackoff = 1000;
  private wsReconnect: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private rpcId = 0;
  private rpcWaiters = new Map<
    number,
    {
      resolve: (r: Reply) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /* ------------------------------- public API ------------------------------ */

  getStatus(): SyncStatus {
    return this.status;
  }

  subscribe(fn: (s: SyncStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  attach(host: SyncHost) {
    this.host = host;
    this.start();
  }

  detach() {
    this.stop();
    this.host = null;
  }

  /** (Re)evaluates the stored config: starts syncing once it is complete, restarts on vault change */
  configure() {
    if (!this.host) return;
    if (!this.started) this.start();
    else if (this.leader) this.kick();
  }

  /** Call whenever the local db changed: stamps edits immediately and schedules a push */
  notifyLocalChange() {
    if (!this.started || !this.leader || !this.state || !this.host) return;
    scanDirty(this.host.getDb(), this.state);
    this.scheduleSave();
    if (
      this.mode === "legacy" ||
      Object.keys(this.state.pending).length > 0 ||
      this.legacyWatch()
    ) {
      if (this.localTimer) clearTimeout(this.localTimer);
      this.localTimer = setTimeout(() => this.kick(), LOCAL_DEBOUNCE_MS);
    }
  }

  /** Manual "Sync now": resolves when a full round finished, rejects with the reason otherwise */
  async syncNow(): Promise<void> {
    if (!this.host) return;
    if (!this.started) this.start();
    if (!this.leader) {
      await new Promise((r) => setTimeout(r, 300));
      if (!this.leader) return; // another tab is the sync leader; data reaches us through storage
    }
    this.retryMs = 5000;
    const result = this.exclusive(() => this.runOnce(true));
    await result;
  }

  /* ------------------------------- lifecycle ------------------------------- */

  private start() {
    if (this.started || !this.host) return;
    this.started = true;
    const gen = ++this.gen;
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (locks?.request) {
      void locks.request(
        LOCK_NAME,
        () =>
          new Promise<void>((release) => {
            if (!this.started || gen !== this.gen) {
              release();
              return;
            }
            this.lockRelease = release;
            this.becomeLeader();
          }),
      );
    } else {
      this.becomeLeader();
    }
  }

  private stop() {
    this.started = false;
    this.leader = false;
    this.gen++;
    this.flushState();
    for (const t of [this.localTimer, this.saveTimer, this.retryTimer, this.wsReconnect]) {
      if (t) clearTimeout(t);
    }
    this.localTimer = this.saveTimer = this.retryTimer = this.wsReconnect = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.closeWs();
    window.removeEventListener("online", this.onOnline);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.flushState);
    this.lockRelease?.();
    this.lockRelease = null;
    this.state = null;
    this.mode = "unknown";
  }

  private becomeLeader() {
    this.leader = true;
    window.addEventListener("online", this.onOnline);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pagehide", this.flushState);
    let tick = 0;
    this.pollTimer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      tick++;
      if (this.mode === "legacy") this.kick();
      else if (this.legacyWatch() && tick % 2 === 0) this.kick();
      else if (!this.wsOpen() && tick % 6 === 0) this.kick();
    }, POLL_TICK_MS);
    this.kick();
  }

  private onOnline = () => {
    this.retryMs = 5000;
    this.connectWs();
    this.kick();
  };

  private onVisibility = () => {
    if (document.visibilityState === "hidden") {
      this.flushState();
      return;
    }
    this.connectWs();
    this.kick();
  };

  /* --------------------------------- rounds -------------------------------- */

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  private kick() {
    if (!this.started || !this.leader || this.queued) return;
    this.queued = true;
    void this.exclusive(async () => {
      this.queued = false;
      try {
        await this.runOnce(false);
      } catch {
        // already reported through status; retry scheduling happens in runOnce
      }
    });
  }

  private legacyWatch(): boolean {
    return !!this.state && this.state.legacy.activeUntil > Date.now();
  }

  private setStatus(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l(this.status);
  }

  private async runOnce(manual: boolean): Promise<void> {
    const host = this.host;
    if (!host || !this.started || !this.leader) return;

    const cfg = loadSyncConfig();
    if (!isConfigured(cfg)) {
      this.setStatus({ phase: "off", message: undefined, settled: true });
      return;
    }
    const scope = scopeOf(cfg);
    if (!this.state || this.state.scope !== scope) {
      this.state = loadState(scope);
      this.mode = "unknown";
      this.closeWs();
    }
    const state = this.state;

    this.setStatus({ phase: "syncing", message: undefined });
    try {
      if (this.mode === "unknown") this.mode = await this.probe(cfg);

      if (this.mode === "legacy") {
        await mirrorLegacy(host, state, cfg, { primary: true, force: manual });
      } else {
        // Bring data from not-yet-updated apps in before the first v2 reconcile
        if (!state.boot) await this.mirror(host, state, cfg, true);
        await syncCycle(this.deps(cfg, host, state));
        await this.mirror(host, state, cfg, false);
        this.connectWs();
      }

      this.flushState();
      this.retryMs = 5000;
      const lastSyncedAt = Date.now();
      saveSyncConfig({ ...loadSyncConfig(), lastSyncedAt, enabled: true });
      this.setStatus({ phase: "idle", message: undefined, lastSyncedAt, settled: true });
    } catch (err) {
      this.flushState();
      this.handleError(err);
      if (manual) throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private async mirror(host: SyncHost, state: SyncState, cfg: SyncConfig, force: boolean) {
    try {
      await mirrorLegacy(host, state, cfg, { primary: false, force });
    } catch {
      // The bridge is best effort; v2 data is never affected by it
    }
  }

  private handleError(err: unknown) {
    const settled = true;
    if (err instanceof SyncError) {
      if (err.code === "auth") {
        this.setStatus({ phase: "error", message: err.message, settled });
        return;
      }
      if (err.code === "decrypt" || err.code === "quota") {
        this.setStatus({ phase: "error", message: err.message, settled });
        return;
      }
    }
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    const message = err instanceof Error ? err.message : String(err);
    this.setStatus({ phase: offline ? "offline" : "error", message, settled });
    this.scheduleRetry();
  }

  private scheduleRetry() {
    if (this.retryTimer || !this.started) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 5 * 60_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.kick();
    }, wait);
  }

  /* -------------------------------- transport ------------------------------ */

  private async probe(cfg: SyncConfig): Promise<"v2" | "legacy"> {
    const res = await this.http(cfg, { t: "info" }, true);
    if (res === "unsupported") return "legacy";
    return "v2";
  }

  private async http(
    cfg: SyncConfig,
    req: Request,
    probing = false,
  ): Promise<Reply | "unsupported"> {
    const base = resolveEffectiveServerUrl(cfg.serverUrl).replace(/\/+$/, "");
    const res = await fetch(`${base}/v2/api/${encodeURIComponent(cfg.vaultId)}`, {
      method: "POST",
      headers: getAuthHeaders(cfg.authToken),
      body: JSON.stringify(req),
    });
    if (res.status === 401)
      throw new SyncError("auth", "Invalid Server Auth Token (401 Unauthorized)");
    if (probing && (res.status === 404 || res.status === 405)) return "unsupported";
    let body: Reply;
    try {
      body = (await res.json()) as Reply;
    } catch {
      throw new Error(`Server error (${res.status})`);
    }
    if (!res.ok && body.t !== "error") throw new Error(`Server error (${res.status})`);
    return body;
  }

  private wsOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  private async request(cfg: SyncConfig, req: Request): Promise<Reply> {
    if (this.wsOpen()) {
      try {
        return await this.wsRpc(req);
      } catch {
        // fall through to HTTP: the socket is probably dying
      }
    }
    return (await this.http(cfg, req)) as Reply;
  }

  private wsRpc(req: Request): Promise<Reply> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error("no socket"));
    return new Promise<Reply>((resolve, reject) => {
      const id = ++this.rpcId;
      const timer = setTimeout(() => {
        this.rpcWaiters.delete(id);
        reject(new Error("rpc timeout"));
      }, RPC_TIMEOUT_MS);
      this.rpcWaiters.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ id, req }));
      } catch (e) {
        clearTimeout(timer);
        this.rpcWaiters.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private connectWs() {
    if (this.ws || !this.started || !this.leader || this.mode !== "v2") return;
    const cfg = loadSyncConfig();
    if (!isConfigured(cfg)) return;
    const url = getWebSocketUrlV2(cfg.serverUrl, cfg.vaultId, cfg.authToken);
    if (!url) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.wsBackoff = 1000;
      this.startPing();
      this.kick(); // catch up with anything that happened while we were disconnected
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      if (e.data === "pong") {
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        return;
      }
      let msg: { id?: number; res?: Reply; t?: string; seq?: number };
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (typeof msg.id === "number" && msg.res) {
        const w = this.rpcWaiters.get(msg.id);
        if (w) {
          clearTimeout(w.timer);
          this.rpcWaiters.delete(msg.id);
          w.resolve(msg.res);
        }
      } else if (msg.t === "changed" && typeof msg.seq === "number") {
        if (!this.state || msg.seq > this.state.lastSeq) this.kick();
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.stopPing();
      for (const [id, w] of this.rpcWaiters) {
        clearTimeout(w.timer);
        w.reject(new Error("socket closed"));
        this.rpcWaiters.delete(id);
      }
      if (!this.started || this.wsReconnect) return;
      const wait = this.wsBackoff;
      this.wsBackoff = Math.min(this.wsBackoff * 1.6, 30_000);
      this.wsReconnect = setTimeout(() => {
        this.wsReconnect = null;
        this.connectWs();
      }, wait);
    };
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.wsOpen()) return;
      try {
        this.ws?.send("ping");
      } catch {
        return;
      }
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => this.ws?.close(), PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = this.pongTimer = null;
  }

  private closeWs() {
    this.stopPing();
    if (this.wsReconnect) clearTimeout(this.wsReconnect);
    this.wsReconnect = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch {}
    }
    for (const [id, w] of this.rpcWaiters) {
      clearTimeout(w.timer);
      w.reject(new Error("socket closed"));
      this.rpcWaiters.delete(id);
    }
  }

  /* -------------------------------- persistence ---------------------------- */

  private deps(cfg: SyncConfig, host: SyncHost, state: SyncState): CycleDeps {
    return {
      state,
      getDb: () => host.getDb(),
      applyDb: (fn) => host.applyDb(fn),
      request: (req) => this.request(cfg, req),
      encrypt: (k, plain) => encryptRecord(plain, cfg.secretKey, cfg.vaultId, k),
      decrypt: (k, blob) => decryptRecord(blob, cfg.secretKey, cfg.vaultId, k),
      saveState: () => this.saveNow(),
    };
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, STATE_SAVE_DEBOUNCE_MS);
  }

  private saveNow() {
    if (!this.state) return;
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(this.state));
    } catch {
      // storage full: keep running in memory, the next start simply re-reconciles
    }
  }

  private flushState = () => {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.saveNow();
  };
}

export const syncClient = new SyncClient();
