import { decryptData, encryptData } from "@/lib/crypto.ts";
import type { DB } from "@/lib/types.ts";

export interface SyncConfig {
  enabled: boolean;
  serverUrl: string;
  vaultId: string;
  secretKey: string;
  authToken?: string;
  lastSyncedAt?: number;
}

const STORAGE_KEY = "taskdrop_cloud_sync_config";

/** Resolves active relay server URL with sensible default fallback */
export function resolveEffectiveServerUrl(serverUrl?: string): string {
  if (serverUrl && serverUrl.trim()) return serverUrl.trim();
  if (typeof window !== "undefined" && window.location.origin) {
    const origin = window.location.origin;
    if (
      origin.includes("localhost") ||
      origin.startsWith("capacitor://") ||
      origin.startsWith("ionic://") ||
      origin.includes("github.io")
    ) {
      return "https://task.njfamirm.ir";
    }
    return origin;
  }
  return "https://task.njfamirm.ir";
}

export function loadSyncConfig(): SyncConfig {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) || localStorage.getItem("daily_cloud_sync_config");
    if (raw) {
      const parsed = JSON.parse(raw) as SyncConfig;
      if (!parsed.serverUrl) {
        parsed.serverUrl = resolveEffectiveServerUrl("");
      }
      return parsed;
    }
  } catch {}
  return {
    enabled: false,
    serverUrl: resolveEffectiveServerUrl(""),
    vaultId: "",
    secretKey: "",
    authToken: "",
  };
}

export function saveSyncConfig(cfg: SyncConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {}
}

/** Converts HTTP relay URL to secure WebSocket URL (ws:// or wss://) */
export function getWebSocketUrl(serverUrl: string, vaultId: string, authToken?: string): string {
  const targetUrl = resolveEffectiveServerUrl(serverUrl);
  if (!targetUrl || !vaultId) return "";
  const cleanUrl = targetUrl.replace(/\/+$/, "");
  const wsProto = cleanUrl.startsWith("https://") ? "wss://" : "ws://";
  const hostAndPath = cleanUrl.replace(/^https?:\/\//, "");
  const query =
    authToken && authToken.trim() ? `?token=${encodeURIComponent(authToken.trim())}` : "";
  return `${wsProto}${hostAndPath}/ws/${encodeURIComponent(vaultId)}${query}`;
}

/** WebSocket URL of the v2 sync protocol */
export function getWebSocketUrlV2(serverUrl: string, vaultId: string, authToken?: string): string {
  const targetUrl = resolveEffectiveServerUrl(serverUrl);
  if (!targetUrl || !vaultId) return "";
  const cleanUrl = targetUrl.replace(/\/+$/, "");
  const wsProto = cleanUrl.startsWith("https://") ? "wss://" : "ws://";
  const hostAndPath = cleanUrl.replace(/^https?:\/\//, "");
  const query =
    authToken && authToken.trim() ? `?token=${encodeURIComponent(authToken.trim())}` : "";
  return `${wsProto}${hostAndPath}/v2/ws/${encodeURIComponent(vaultId)}${query}`;
}

/** Generates compact base64 pairing token for QR codes and fast device syncing */
export function encodeSyncPairingToken(cfg: SyncConfig): string {
  const payload = {
    s: cfg.serverUrl || "",
    v: cfg.vaultId || "",
    k: cfg.secretKey || "",
    t: cfg.authToken || "",
  };
  return btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
}

/** Decodes configuration parameters from a pairing token */
export function decodeSyncPairingToken(token: string): Partial<SyncConfig> {
  const json = decodeURIComponent(escape(atob(token.trim())));
  const data = JSON.parse(json);
  return {
    serverUrl: data.s || "",
    vaultId: data.v || "",
    secretKey: data.k || "",
    authToken: data.t || "",
    enabled: true,
  };
}

export function getAuthHeaders(authToken?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken && authToken.trim()) {
    headers["Authorization"] = `Bearer ${authToken.trim()}`;
  }
  return headers;
}

/** Push encrypted snapshot to remote vault */
export async function pushToVault(
  serverUrl: string,
  vaultId: string,
  secretKey: string,
  db: DB,
  authToken?: string,
): Promise<{ ok: boolean; updatedAt: number }> {
  const targetUrl = resolveEffectiveServerUrl(serverUrl);
  if (!targetUrl || !vaultId || !secretKey) {
    throw new Error("Server URL, Vault ID, or Secret Key is missing");
  }

  const cleanUrl = targetUrl.replace(/\/+$/, "");
  const plainText = JSON.stringify(db);
  const cipher = await encryptData(plainText, secretKey);
  const now = Date.now();

  const res = await fetch(`${cleanUrl}/api/sync/${encodeURIComponent(vaultId)}`, {
    method: "POST",
    headers: getAuthHeaders(authToken),
    body: JSON.stringify({
      payload: cipher,
      updatedAt: now,
      version: 1,
    }),
  });

  if (res.status === 401) {
    throw new Error("Invalid Server Auth Token (401 Unauthorized)");
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Server Error (${res.status}): ${text}`);
  }

  const data = await res.json();
  return { ok: true, updatedAt: data.updatedAt ?? now };
}

/** Check remote vault updated timestamp without downloading entire body */
export async function checkVaultVersion(
  serverUrl: string,
  vaultId: string,
  authToken?: string,
): Promise<{ updatedAt: number } | null> {
  const targetUrl = resolveEffectiveServerUrl(serverUrl);
  if (!targetUrl || !vaultId) return null;
  const cleanUrl = targetUrl.replace(/\/+$/, "");
  try {
    const res = await fetch(`${cleanUrl}/api/sync/${encodeURIComponent(vaultId)}/version`, {
      headers: getAuthHeaders(authToken),
    });
    if (res.ok) {
      const data = await res.json();
      return { updatedAt: data.updatedAt ?? 0 };
    }
  } catch {}
  return null;
}

/** Pull and decrypt latest snapshot from remote vault */
export async function pullFromVault(
  serverUrl: string,
  vaultId: string,
  secretKey: string,
  authToken?: string,
): Promise<{ db: DB; updatedAt: number } | null> {
  const targetUrl = resolveEffectiveServerUrl(serverUrl);
  if (!targetUrl || !vaultId || !secretKey) {
    return null;
  }

  const cleanUrl = targetUrl.replace(/\/+$/, "");
  const res = await fetch(`${cleanUrl}/api/sync/${encodeURIComponent(vaultId)}`, {
    headers: getAuthHeaders(authToken),
  });

  if (res.status === 401) {
    throw new Error("Invalid Server Auth Token (401 Unauthorized)");
  }

  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    throw new Error(`Server communication error (${res.status})`);
  }

  const data = await res.json();
  const plainText = await decryptData(data.payload, secretKey);
  const incomingDb = JSON.parse(plainText) as DB;

  return {
    db: incomingDb,
    updatedAt: data.updatedAt,
  };
}
