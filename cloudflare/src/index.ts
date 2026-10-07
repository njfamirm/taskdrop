export { VaultV2 } from "./vaultV2.ts";

export interface KVNamespace {
  get<T = string>(
    key: string,
    type?: "text" | "json" | "arrayBuffer" | "stream",
  ): Promise<T | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ServerWebSocket extends WebSocket {
  accept(): void;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: string,
    listener: (event: MessageEvent | CloseEvent | Event) => void,
  ): void;
}

declare global {
  class WebSocketPair {
    0: WebSocket;
    1: ServerWebSocket;
  }
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): Fetcher;
}

export interface DurableObjectId {
  toString(): string;
}

export interface Fetcher {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>;
}

export interface Env {
  VAULTS: KVNamespace;
  VAULT_ROOMS?: DurableObjectNamespace;
  VAULT_V2?: DurableObjectNamespace;
  ASSETS?: Fetcher;
  AUTH_TOKEN?: string;
}

interface SyncPayload {
  payload: string;
  version?: number;
  updatedAt?: number;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Auth-Token, X-Vault-Key, If-None-Match",
  "Access-Control-Expose-Headers": "ETag",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(
  data: object,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.AUTH_TOKEN || !env.AUTH_TOKEN.trim()) {
    return true;
  }

  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token") || "";

  const authHeader = request.headers.get("Authorization") || "";
  const customHeader = request.headers.get("X-Auth-Token") || "";

  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : authHeader.trim() || customHeader.trim() || queryToken.trim();

  return token === env.AUTH_TOKEN.trim();
}

/**
 * Cloudflare Durable Object برای برودکست بلادرنگ و بدون تاخیر بین تمام کلاینت‌های یک والت
 */
export class VaultRoom {
  private sessions: Set<ServerWebSocket>;
  private env: Env;
  private currentData: SyncPayload | null = null;

  constructor(_state: unknown, env: Env) {
    this.sessions = new Set();
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ۱. ارتقا به وب‌سوکت
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      server.accept();
      this.sessions.add(server);

      // ارسال وضعیت فعلی به کلاینت متصل شده
      if (this.currentData) {
        server.send(
          JSON.stringify({
            type: "init",
            payload: this.currentData.payload,
            updatedAt: this.currentData.updatedAt,
            version: this.currentData.version ?? 1,
          }),
        );
      }

      server.addEventListener("message", async (event) => {
        try {
          const msg = JSON.parse((event as MessageEvent).data as string) as {
            type?: string;
            vaultId?: string;
            payload?: string;
            updatedAt?: number;
            version?: number;
          };

          if (msg.type === "ping") {
            server.send(JSON.stringify({ type: "pong" }));
            return;
          }

          if (msg.type === "init") {
            if (this.currentData) {
              server.send(
                JSON.stringify({
                  type: "init",
                  payload: this.currentData.payload,
                  updatedAt: this.currentData.updatedAt,
                  version: this.currentData.version ?? 1,
                }),
              );
            }
            return;
          }

          if (msg.type === "push" && msg.payload && typeof msg.payload === "string") {
            const now = msg.updatedAt ?? Date.now();
            this.currentData = {
              payload: msg.payload,
              updatedAt: now,
              version: msg.version ?? 1,
            };

            // ذخیره همزمان در KV
            if (this.env.VAULTS && msg.vaultId) {
              await this.env.VAULTS.put(msg.vaultId, JSON.stringify(this.currentData));
            }

            // برودکست آنی به سایر کلاینت‌های متصل به همین والت
            const broadcastPayload = JSON.stringify({
              type: "remote_update",
              payload: msg.payload,
              updatedAt: now,
              version: msg.version ?? 1,
            });

            for (const ws of this.sessions) {
              if (ws !== server && ws.readyState === WebSocket.OPEN) {
                ws.send(broadcastPayload);
              }
            }
          }
        } catch {
          // خطا در پردازش پیام
        }
      });

      const cleanup = () => {
        this.sessions.delete(server);
      };

      server.addEventListener("close", cleanup);
      server.addEventListener("error", cleanup);

      return new Response(null, {
        status: 101,
        webSocket: client,
      } as ResponseInit & { webSocket?: WebSocket });
    }

    // ۲. اطلاع‌رسانی بروزرسانی از طریق HTTP POST
    if (request.method === "POST" && url.pathname.endsWith("/notify")) {
      try {
        const body = (await request.json()) as SyncPayload;
        this.currentData = body;
        const broadcastPayload = JSON.stringify({
          type: "remote_update",
          payload: body.payload,
          updatedAt: body.updatedAt,
          version: body.version ?? 1,
        });
        for (const ws of this.sessions) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(broadcastPayload);
          }
        }
      } catch {}
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "Not found" }, 404);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // ۱. پاسخ به پیش‌پرواز CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    // ۲. بررسی سلامت سرویس
    if (pathname === "/health" || pathname === "/api/health") {
      return jsonResponse({
        status: "healthy",
        platform: "cloudflare-workers",
        features: ["websocket", "durable-objects", "e2ee-kv", "sync-v2"],
        protected: Boolean(env.AUTH_TOKEN?.trim()),
        time: new Date().toISOString(),
      });
    }

    // ۳. اعتبارسنجی توکن دسترسی سرور
    if (!isAuthorized(request, env)) {
      return jsonResponse({ error: "Unauthorized: Invalid or missing server access token" }, 401);
    }

    // ۳.۵. پروتکل سینک نسخه ۲: /v2/ws/:vaultId و /v2/api/:vaultId
    const v2Match = pathname.match(/^\/v2\/(ws|api)\/([^/]{1,128})$/);
    if (v2Match) {
      if (!env.VAULT_V2)
        return jsonResponse({ error: "Sync v2 is not enabled on this server" }, 404);
      const stub = env.VAULT_V2.get(env.VAULT_V2.idFromName(v2Match[2]));
      if (v2Match[1] === "ws") {
        if (request.headers.get("Upgrade") !== "websocket") {
          return jsonResponse({ error: "Expected WebSocket upgrade" }, 426);
        }
        return stub.fetch(request);
      }
      if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
      const res = await stub.fetch(request);
      return new Response(res.body, {
        status: res.status,
        headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
      });
    }

    // ۴. وب‌سوکت روت: /ws/:vaultId
    const wsMatch = pathname.match(/^\/ws\/([^/]+)$/);
    if (wsMatch) {
      const vaultId = wsMatch[1];
      if (env.VAULT_ROOMS) {
        const id = env.VAULT_ROOMS.idFromName(vaultId);
        const obj = env.VAULT_ROOMS.get(id);
        return obj.fetch(request);
      }

      // فال‌بک وب‌سوکت بدون Durable Objects
      if (request.headers.get("Upgrade") === "websocket") {
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        server.accept();

        server.addEventListener("message", async (event) => {
          try {
            const msg = JSON.parse((event as MessageEvent).data as string) as {
              type?: string;
              payload?: string;
              updatedAt?: number;
              version?: number;
            };
            if (msg.type === "ping") {
              server.send(JSON.stringify({ type: "pong" }));
              return;
            }
            if (msg.type === "init") {
              const data = await env.VAULTS.get<SyncPayload>(vaultId, "json");
              if (data) {
                server.send(
                  JSON.stringify({
                    type: "init",
                    payload: data.payload,
                    updatedAt: data.updatedAt,
                    version: data.version ?? 1,
                  }),
                );
              }
              return;
            }
            if (msg.type === "push" && msg.payload) {
              const now = msg.updatedAt ?? Date.now();
              const payloadToStore: SyncPayload = {
                payload: msg.payload,
                version: msg.version ?? 1,
                updatedAt: now,
              };
              await env.VAULTS.put(vaultId, JSON.stringify(payloadToStore));
            }
          } catch {}
        });

        return new Response(null, {
          status: 101,
          webSocket: client,
        } as ResponseInit & { webSocket?: WebSocket });
      }
    }

    // ۵. بررسی سبک نسخه والت: /api/sync/:vaultId/version
    const versionMatch = pathname.match(/^\/api\/sync\/([^/]+)\/version$/);
    if (versionMatch && request.method === "GET") {
      const vaultId = versionMatch[1];
      try {
        const data = await env.VAULTS.get<SyncPayload>(vaultId, "json");
        if (!data) return jsonResponse({ error: "Vault not found" }, 404);
        return jsonResponse({
          vaultId,
          version: data.version ?? 1,
          updatedAt: data.updatedAt ?? 0,
        });
      } catch (err) {
        return jsonResponse(
          { error: "KV read error", message: err instanceof Error ? err.message : String(err) },
          500,
        );
      }
    }

    // ۶. روت‌های والت سینک: /api/sync/:vaultId
    const syncMatch = pathname.match(/^\/api\/sync\/([^/]+)$/);
    if (!syncMatch) {
      // سرو فایل‌های استاتیک فرانت‌اند SPA در صورت فعال بودن ASSETS
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return jsonResponse({ error: "Not found" }, 404);
    }

    const vaultId = syncMatch[1];

    // ۶.۱. خواندن والت (GET) با پشتیبانی کامل از ETag و ۳۰۴ Not Modified
    if (request.method === "GET") {
      try {
        const data = await env.VAULTS.get<SyncPayload>(vaultId, "json");
        if (!data) {
          return jsonResponse({ error: "Vault not found" }, 404);
        }

        const updatedAt = data.updatedAt ?? 0;
        const etag = `W/"${updatedAt}"`;

        const clientEtag = request.headers.get("If-None-Match");
        if (clientEtag && clientEtag === etag) {
          return new Response(null, {
            status: 304,
            headers: {
              ...CORS_HEADERS,
              ETag: etag,
            },
          });
        }

        return jsonResponse(
          {
            vaultId,
            version: data.version ?? 1,
            updatedAt: data.updatedAt ?? Date.now(),
            payload: data.payload,
          },
          200,
          { ETag: etag },
        );
      } catch (err) {
        return jsonResponse(
          { error: "KV read error", message: err instanceof Error ? err.message : String(err) },
          500,
        );
      }
    }

    // ۶.۲. ذخیره و به‌روزرسانی والت (POST)
    if (request.method === "POST") {
      try {
        const body = (await request.json()) as SyncPayload;
        if (!body.payload || typeof body.payload !== "string") {
          return jsonResponse({ error: "Field 'payload' is required and must be a string" }, 400);
        }

        const now = body.updatedAt ?? Date.now();
        const payloadToStore: SyncPayload = {
          payload: body.payload,
          version: body.version ?? 1,
          updatedAt: now,
        };

        // ذخیره در Cloudflare KV
        await env.VAULTS.put(vaultId, JSON.stringify(payloadToStore));

        // اطلاع به Durable Object برای برودکست فوری به کلاینت‌های وب‌سوکت
        if (env.VAULT_ROOMS) {
          try {
            const id = env.VAULT_ROOMS.idFromName(vaultId);
            const obj = env.VAULT_ROOMS.get(id);
            void obj.fetch("https://internal/notify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payloadToStore),
            });
          } catch {}
        }

        return jsonResponse({
          ok: true,
          vaultId,
          updatedAt: now,
        });
      } catch (err) {
        return jsonResponse(
          { error: "Invalid JSON body", message: err instanceof Error ? err.message : String(err) },
          400,
        );
      }
    }

    // ۶.۳. حذف والت (DELETE)
    if (request.method === "DELETE") {
      try {
        await env.VAULTS.delete(vaultId);
        return jsonResponse({ ok: true, deleted: vaultId });
      } catch (err) {
        return jsonResponse(
          { error: "KV delete error", message: err instanceof Error ? err.message : String(err) },
          500,
        );
      }
    }

    return jsonResponse({ error: "Method not allowed" }, 405);
  },
};
