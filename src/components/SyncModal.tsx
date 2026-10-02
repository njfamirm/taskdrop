import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import {
  decodeSyncPairingToken,
  encodeSyncPairingToken,
  loadSyncConfig,
  pullFromVault,
  pushToVault,
  saveSyncConfig,
  type SyncConfig,
} from "@/lib/cloudSync.ts";
import { hapticSelection, hapticSuccess } from "@/lib/haptics.ts";
import { getTranslation } from "@/lib/i18n.ts";
import { mergeDBs } from "@/lib/syncEngine.ts";
import type { DB, Language } from "@/lib/types.ts";
import { cn } from "@/lib/utils.ts";
import {
  Check,
  ClipboardCopy,
  Cloud,
  KeyRound,
  Lock,
  QrCode,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";

interface Props {
  open: boolean;
  db: DB;
  lang?: Language;
  onSyncApply: (newDb: DB) => void;
  onClose: () => void;
  onMessage: (msg: string) => void;
}

export function SyncModal({ open, db, lang = "fa", onSyncApply, onClose, onMessage }: Props) {
  const t = getTranslation(lang);
  const isFa = lang === "fa";

  const [activeTab, setActiveTab] = useState("quick");
  const [syncConfig, setSyncConfig] = useState<SyncConfig>(loadSyncConfig());
  const [isSyncing, setIsSyncing] = useState(false);
  const [serverStatus, setServerStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState("");

  // Fast device pairing & QR state
  const [pairingQrUrl, setPairingQrUrl] = useState<string>("");
  const [pastePairToken, setPastePairToken] = useState("");
  const [isPairCopied, setIsPairCopied] = useState(false);

  // Generate pairing QR code based on active config
  useEffect(() => {
    if (!open) return;
    if (
      !syncConfig.serverUrl.trim() ||
      !syncConfig.vaultId.trim() ||
      !syncConfig.secretKey.trim()
    ) {
      setPairingQrUrl("");
      return;
    }

    try {
      const token = encodeSyncPairingToken(syncConfig);
      void QRCode.toDataURL(token, {
        margin: 1,
        width: 240,
        errorCorrectionLevel: "M",
        color: {
          dark: "#000000",
          light: "#ffffff",
        },
      }).then(setPairingQrUrl);
    } catch {
      setPairingQrUrl("");
    }
  }, [open, syncConfig]);

  // Test custom relay server health
  const handleTestServer = async () => {
    if (!syncConfig.serverUrl.trim()) {
      setServerStatus("error");
      setStatusMessage(t.syncServerEnterUrl);
      return;
    }
    setServerStatus("testing");
    setStatusMessage(t.syncServerTesting);

    try {
      const cleanUrl = syncConfig.serverUrl.replace(/\/+$/, "");
      const headers: Record<string, string> = {};
      if (syncConfig.authToken?.trim()) {
        headers["Authorization"] = `Bearer ${syncConfig.authToken.trim()}`;
      }
      const res = await fetch(`${cleanUrl}/health`, { headers });
      if (res.ok) {
        setServerStatus("ok");
        setStatusMessage(t.syncServerOk);
      } else if (res.status === 401) {
        setServerStatus("error");
        setStatusMessage(t.syncServerUnauthorized);
      } else {
        setServerStatus("error");
        setStatusMessage(t.syncServerFail(res.status));
      }
    } catch (err) {
      setServerStatus("error");
      setStatusMessage(
        t.syncServerUnreachable(err instanceof Error ? err.message : "Network error"),
      );
    }
  };

  // Two-way cloud sync (Pull -> Merge -> Push)
  const handleCloudSync = async (overrideCfg?: SyncConfig) => {
    const cfg = overrideCfg || syncConfig;
    if (!cfg.serverUrl.trim() || !cfg.vaultId.trim() || !cfg.secretKey.trim()) {
      onMessage(t.syncMissingFields);
      return;
    }

    setIsSyncing(true);
    try {
      saveSyncConfig(cfg);

      // 1. Pull remote encrypted vault
      const remote = await pullFromVault(cfg.serverUrl, cfg.vaultId, cfg.secretKey, cfg.authToken);

      let finalDb = db;
      if (remote) {
        // 2. Conflict-free merge
        finalDb = mergeDBs(db, remote.db);
        onSyncApply(finalDb);
      }

      // 3. Push merged state
      await pushToVault(cfg.serverUrl, cfg.vaultId, cfg.secretKey, finalDb, cfg.authToken);

      const now = Date.now();
      const updatedConfig = { ...cfg, lastSyncedAt: now, enabled: true };
      setSyncConfig(updatedConfig);
      saveSyncConfig(updatedConfig);

      void hapticSuccess();
      onMessage(t.syncSuccess);
    } catch (err) {
      onMessage(t.syncError(err instanceof Error ? err.message : "Unknown error"));
    } finally {
      setIsSyncing(false);
    }
  };

  // Apply pairing token received from another device
  const handleApplyPairToken = () => {
    if (!pastePairToken.trim()) return;
    try {
      const parsed = decodeSyncPairingToken(pastePairToken);
      const next: SyncConfig = {
        ...syncConfig,
        ...parsed,
        enabled: true,
      };
      setSyncConfig(next);
      saveSyncConfig(next);
      setPastePairToken("");
      onMessage(t.syncPairSuccess);
      void handleCloudSync(next);
    } catch {
      onMessage(t.syncPairInvalid);
    }
  };

  // Generate random vault ID
  const handleGenerateVaultId = () => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "TASK-";
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const next = { ...syncConfig, vaultId: code };
    setSyncConfig(next);
    saveSyncConfig(next);
    void hapticSelection();
    onMessage(t.syncVaultGenerated(code));
  };

  const isConfigReady =
    Boolean(syncConfig.serverUrl.trim()) &&
    Boolean(syncConfig.vaultId.trim()) &&
    Boolean(syncConfig.secretKey.trim());

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent onClose={onClose} className="max-w-lg p-0 gap-0">
        {/* Header */}
        <DialogHeader className="p-5 pb-3 border-b border-zinc-800/80">
          <div className="flex items-center gap-2.5">
            <div className="grid size-8 place-items-center rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300">
              <Cloud className="size-4" />
            </div>
            <div>
              <DialogTitle>{t.syncTitle}</DialogTitle>
              <DialogDescription>{t.syncSubtitle}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Tabbed Navigation */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="gap-0">
          <div className="border-b border-zinc-800/80 bg-zinc-900/30 px-5 pt-2">
            <TabsList className="bg-transparent border-0 p-0 h-auto gap-2">
              <TabsTrigger
                value="quick"
                className="gap-1.5 pb-2.5 rounded-none border-b-2 border-transparent data-[state=active]:border-amber-400"
              >
                <Sparkles className="size-3.5" />
                <span>{t.syncQuickPair}</span>
              </TabsTrigger>
              <TabsTrigger
                value="manual"
                className="gap-1.5 pb-2.5 rounded-none border-b-2 border-transparent data-[state=active]:border-amber-400"
              >
                <Server className="size-3.5" />
                <span>{isFa ? "تنظیمات دستی سرور" : "Manual Settings"}</span>
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="max-h-[60vh] overflow-y-auto p-5 space-y-4">
            {/* TAB: QUICK PAIR */}
            <TabsContent value="quick" className="space-y-4 m-0">
              {/* QR Code Section */}
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-xs flex items-center gap-1.5">
                      <QrCode className="size-3.5 text-zinc-400" />
                      <span>{isFa ? "بارکد اتصال سریع" : "Pairing QR Code"}</span>
                    </CardTitle>
                    {isConfigReady ? (
                      <Badge
                        variant="secondary"
                        className="text-[10px] text-emerald-400 border-emerald-900/50 bg-emerald-950/30"
                      >
                        {isFa ? "آماده اسکن" : "Ready to scan"}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] text-zinc-500">
                        {isFa ? "نیاز به تنظیم سرور" : "Needs server config"}
                      </Badge>
                    )}
                  </div>
                  <CardDescription>
                    {isConfigReady
                      ? t.syncQrDesc
                      : isFa
                        ? "ابتدا از تب تنظیمات دستی، آدرس سرور و کلید رمزنگاری را مشخص کنید."
                        : "Configure server URL and secret key in manual settings first."}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col items-center">
                  {isConfigReady && pairingQrUrl ? (
                    <div className="my-2 flex flex-col items-center gap-2">
                      <div className="overflow-hidden rounded-xl border-4 border-white bg-white shadow-xl">
                        <img src={pairingQrUrl} alt="Pairing QR" className="size-40 sm:size-44" />
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                          const token = encodeSyncPairingToken(syncConfig);
                          await navigator.clipboard.writeText(token);
                          setIsPairCopied(true);
                          void hapticSuccess();
                          onMessage(t.syncTokenCopied);
                          setTimeout(() => setIsPairCopied(false), 2000);
                        }}
                        className="gap-1.5 text-xs text-zinc-300 hover:text-white"
                      >
                        <ClipboardCopy className="size-3.5" />
                        <span>{isPairCopied ? t.copied : t.syncCopyToken}</span>
                      </Button>
                    </div>
                  ) : (
                    <div className="py-6 text-center text-xs text-zinc-500">
                      {isFa
                        ? "برای تولید خودکار بارکد، فیلدهای سرور و کلید را پر کنید."
                        : "Fill server fields to generate pairing QR code."}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Paste Token Section */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs">
                    {isFa ? "ورود رشته اتصال دستگاه دیگر" : "Import Pairing Token"}
                  </CardTitle>
                  <CardDescription>
                    {isFa
                      ? "رشته اتصال کپی‌شده از دستگاه اول را اینجا پیست کنید تا سینک خودکار فعال شود."
                      : "Paste the pairing token string from your other device to connect instantly."}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-2">
                    <Input
                      value={pastePairToken}
                      onChange={(e) => setPastePairToken(e.target.value)}
                      placeholder={t.syncTokenPlaceholder}
                      className="h-9 text-xs"
                    />
                    <Button
                      onClick={handleApplyPairToken}
                      disabled={!pastePairToken.trim()}
                      className="h-9 shrink-0 bg-amber-500 text-zinc-950 hover:bg-amber-400 font-semibold px-4 cursor-pointer text-xs"
                    >
                      {t.syncPairNow}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* TAB: MANUAL SERVER SETTINGS */}
            <TabsContent value="manual" className="space-y-3 m-0">
              {/* Server URL */}
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-zinc-300">{t.syncServerUrl}</label>
                <div className="flex items-center gap-2">
                  <Input
                    type="url"
                    placeholder="https://taskdrop-sync-relay.YOUR_NAME.workers.dev"
                    value={syncConfig.serverUrl}
                    onChange={(e) => {
                      const next = { ...syncConfig, serverUrl: e.target.value };
                      setSyncConfig(next);
                      saveSyncConfig(next);
                      setServerStatus("idle");
                    }}
                    className="h-9 text-xs"
                  />
                  <Button
                    variant="outline"
                    onClick={handleTestServer}
                    disabled={serverStatus === "testing"}
                    className="h-9 shrink-0 text-xs px-3"
                  >
                    {serverStatus === "testing" ? (
                      <RefreshCw className="size-3.5 animate-spin" />
                    ) : serverStatus === "ok" ? (
                      <Check className="size-3.5 text-emerald-400" />
                    ) : (
                      t.syncServerTest
                    )}
                  </Button>
                </div>
                {statusMessage && (
                  <p
                    className={cn(
                      "text-[10px]",
                      serverStatus === "ok" ? "text-emerald-400" : "text-amber-400",
                    )}
                  >
                    {statusMessage}
                  </p>
                )}
              </div>

              {/* Auth Token */}
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-zinc-300">{t.syncAuthToken}</label>
                <div className="relative">
                  <Input
                    type="password"
                    placeholder={t.syncAuthTokenPlaceholder}
                    value={syncConfig.authToken || ""}
                    onChange={(e) => {
                      const next = { ...syncConfig, authToken: e.target.value };
                      setSyncConfig(next);
                      saveSyncConfig(next);
                    }}
                    className="h-9 text-xs pe-8"
                  />
                  <ShieldCheck className="absolute end-2.5 top-2.5 size-4 text-zinc-500 pointer-events-none" />
                </div>
              </div>

              {/* Vault ID */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-medium text-zinc-300">
                  <span>{t.syncVaultId}</span>
                  <button
                    type="button"
                    onClick={handleGenerateVaultId}
                    className="text-[11px] text-amber-400 hover:underline cursor-pointer"
                  >
                    {t.syncGenerateVault}
                  </button>
                </div>
                <div className="relative">
                  <Input
                    type="text"
                    placeholder="TASK-XXXXXX"
                    value={syncConfig.vaultId}
                    onChange={(e) => {
                      const next = { ...syncConfig, vaultId: e.target.value.toUpperCase() };
                      setSyncConfig(next);
                      saveSyncConfig(next);
                    }}
                    className="h-9 text-xs pe-8 uppercase"
                  />
                  <KeyRound className="absolute end-2.5 top-2.5 size-4 text-zinc-500 pointer-events-none" />
                </div>
              </div>

              {/* Encryption Secret Key */}
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-zinc-300">{t.syncSecretKey}</label>
                <div className="relative">
                  <Input
                    type="password"
                    placeholder={t.syncSecretKeyPlaceholder}
                    value={syncConfig.secretKey}
                    onChange={(e) => {
                      const next = { ...syncConfig, secretKey: e.target.value };
                      setSyncConfig(next);
                      saveSyncConfig(next);
                    }}
                    className="h-9 text-xs pe-8"
                  />
                  <Lock className="absolute end-2.5 top-2.5 size-4 text-zinc-500 pointer-events-none" />
                </div>
                <p className="text-[10px] text-zinc-500">{t.syncSecretKeyHint}</p>
              </div>
            </TabsContent>
          </div>
        </Tabs>

        {/* Sync Trigger Action & Status */}
        <div className="border-t border-zinc-800/80 bg-zinc-900/40 p-4 space-y-3">
          <Button
            onClick={() => void handleCloudSync()}
            disabled={isSyncing}
            className="w-full gap-2 bg-amber-500 text-zinc-950 hover:bg-amber-400 font-semibold text-xs cursor-pointer"
          >
            <RefreshCw className={cn("size-3.5", isSyncing && "animate-spin")} />
            <span>{isSyncing ? t.syncing : t.syncNow}</span>
          </Button>

          {syncConfig.lastSyncedAt && (
            <div className="flex items-center justify-between text-[11px] text-zinc-400 px-1">
              <span>{t.syncLastSuccess}</span>
              <span className="text-zinc-300">
                {new Date(syncConfig.lastSyncedAt).toLocaleTimeString(isFa ? "fa-IR" : "en-US")}
              </span>
            </div>
          )}
        </div>

        {/* Footer */}
        <DialogFooter className="border-t border-zinc-800/80 bg-zinc-950 px-5 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t.close}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
