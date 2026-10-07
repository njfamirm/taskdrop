import { DailyReportModal } from "@/components/DailyReportModal.tsx";
import { HelpSheet } from "@/components/HelpSheet.tsx";
import { SettingsModal } from "@/components/SettingsModal.tsx";
import { SyncModal } from "@/components/SyncModal.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { getTranslation } from "@/lib/i18n.ts";
import { buildPayload } from "@/lib/payload.ts";
import { parseIncoming } from "@/lib/store.ts";
import { applyTheme } from "@/lib/theme.ts";
import { hapticSuccess } from "@/lib/haptics.ts";
import type { DB, Language, ThemeMode } from "@/lib/types.ts";
import { cn } from "@/lib/utils.ts";
import {
  Check,
  ClipboardCopy,
  ClipboardPaste,
  Cloud,
  Download,
  NotebookPen,
  HelpCircle,
  MoreVertical,
  Plus,
  Search,
  Settings,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";

interface Props {
  db: DB;
  lang: Language;
  dueCount: number;
  showInput: boolean;
  showSearch: boolean;
  onToggleInput: () => void;
  onToggleSearch: () => void;
  onReplace: (db: DB) => void;
  onUpdateMemory: (memory: string) => void;
  onUpdateSetting: <K extends keyof DB["settings"]>(k: K, v: DB["settings"][K]) => void;
  onClearDone: () => void;
  onSaveReport: (date: string, text: string) => void;
  onMessage: (text: string, undo?: () => void) => void;
}

export function Header({
  db,
  lang,
  dueCount,
  showInput,
  showSearch,
  onToggleInput,
  onToggleSearch,
  onReplace,
  onUpdateMemory,
  onUpdateSetting,
  onClearDone,
  onSaveReport,
  onMessage,
}: Props) {
  const t = getTranslation(lang);
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);

  const currentTheme: ThemeMode = db.settings.theme || "dark";

  // Apply theme to DOM and status bar
  useEffect(() => {
    void applyTheme(currentTheme);
  }, [currentTheme]);

  // Close menu on Escape & handle Settings shortcut (⌘,)
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && menuOpen) {
        setMenuOpen(false);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [menuOpen]);

  const copy = async () => {
    const text = buildPayload(db);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      void hapticSuccess();
      onMessage(t.copySuccess);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setFallback(text);
    }
  };

  const downloadContext = () => {
    const blob = new Blob([buildPayload(db)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `taskdrop-context-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    void hapticSuccess();
  };

  const apply = (text: string) => {
    const before = db;
    try {
      onReplace(parseIncoming(text));
      setFallback(null);
      void hapticSuccess();
      onMessage(t.pasteSuccess, () => onReplace(before));
    } catch (err) {
      onMessage(t.pasteFailed(err instanceof Error ? err.message : "Invalid input"));
    }
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        onMessage(t.clipboardEmpty);
        return;
      }
      apply(text);
    } catch {
      setFallback("");
    }
  };

  const hasDone = db.tasks.some((task) => task.done);

  return (
    <header className="relative flex items-center justify-between gap-3 border-b border-zinc-800/80 pb-3.5">
      {/* Brand logo and due badge */}
      <div className="flex items-center gap-2.5">
        <div
          className="grid size-9 shrink-0 place-items-center rounded-xl border border-zinc-700/80 bg-zinc-900 shadow-inner overflow-hidden"
          title="TaskDrop"
        >
          <svg viewBox="0 0 100 100" className="size-9">
            <defs>
              <pattern
                id="header-dots"
                x="0"
                y="0"
                width="16"
                height="16"
                patternUnits="userSpaceOnUse"
              >
                <circle cx="8" cy="8" r="0.8" fill="#71717a" fillOpacity="0.4" />
              </pattern>
            </defs>
            <rect width="100" height="100" rx="22" fill="#141417" />
            <rect width="100" height="100" rx="22" fill="url(#header-dots)" />
            <path
              d="M 34 52 L 46 64 L 68 38"
              fill="none"
              stroke="#ffffff"
              strokeWidth="8.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="46" cy="64" r="2.2" fill="#eab308" />
          </svg>
        </div>

        {dueCount > 0 && (
          <span className="rounded-full border border-red-500/40 bg-red-500/20 px-2.5 py-0.5 text-xs font-semibold text-red-300">
            {t.dueBadge(dueCount)}
          </span>
        )}
      </div>

      {/* Primary header actions */}
      <div className="flex items-center gap-2">
        {/* Copy for AI Button */}
        <Button
          variant="outline"
          size="sm"
          onClick={copy}
          title={t.copyTitle}
          className="gap-1.5 border-zinc-700/90 bg-zinc-900/90 text-zinc-100 hover:border-zinc-500 hover:bg-zinc-800 font-medium text-xs px-3"
        >
          {copied ? (
            <Check className="size-3.5 text-emerald-400" />
          ) : (
            <ClipboardCopy className="size-3.5 text-zinc-300" />
          )}
          <span>{copied ? t.copied : t.copy}</span>
        </Button>

        {/* Paste from AI Button */}
        <Button
          variant="outline"
          size="sm"
          onClick={paste}
          title={t.pasteTitle}
          className="gap-1.5 border-zinc-700/90 bg-zinc-900/90 text-zinc-100 hover:border-zinc-500 hover:bg-zinc-800 font-medium text-xs px-3"
        >
          <ClipboardPaste className="size-3.5 text-zinc-300" />
          <span>{t.paste}</span>
        </Button>

        {/* Toggle search input */}
        <Button
          variant="ghost"
          size="icon"
          aria-label={
            showSearch
              ? lang === "fa"
                ? "بستن جستجو"
                : "Hide search"
              : lang === "fa"
                ? "جستجوی تسک‌ها (Cmd+K)"
                : "Search tasks (Cmd+K)"
          }
          title={
            showSearch
              ? lang === "fa"
                ? "بستن جستجو"
                : "Hide search"
              : lang === "fa"
                ? "جستجوی تسک‌ها (Cmd+K)"
                : "Search tasks (Cmd+K)"
          }
          onClick={onToggleSearch}
          className={cn(
            "transition-colors",
            showSearch ? "text-amber-400 bg-zinc-800/80" : "text-zinc-400 hover:text-zinc-200",
          )}
        >
          <Search className="size-4" />
        </Button>

        {/* Toggle quick add input */}
        <Button
          variant="ghost"
          size="icon"
          aria-label={showInput ? t.toggleInputHide : t.toggleInputShow}
          title={showInput ? t.toggleInputHide : t.toggleInputShow}
          onClick={onToggleInput}
          className={cn(
            "transition-colors",
            showInput ? "text-zinc-200 bg-zinc-800/80" : "text-zinc-400 hover:text-zinc-200",
          )}
        >
          <Plus className={cn("size-4 transition-transform", showInput && "rotate-45")} />
        </Button>

        {/* Options & Menu Dropdown */}
        <div className="relative">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t.moreOptions}
            title={t.moreOptions}
            onClick={() => setMenuOpen((prev) => !prev)}
            className={cn(
              "text-zinc-400 hover:text-zinc-100",
              menuOpen && "bg-zinc-800 text-zinc-100",
            )}
          >
            <MoreVertical className="size-4" />
          </Button>

          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <div className="absolute end-0 top-full z-50 mt-1.5 w-52 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/98 p-1.5 text-xs shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-150">
                {/* Cloud Sync */}
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setSyncOpen(true);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-zinc-300 hover:bg-zinc-900 hover:text-white transition-colors cursor-pointer"
                >
                  <Cloud className="size-4 text-zinc-400" />
                  <span className="flex-1 text-start">{t.cloudSync}</span>
                </button>

                {/* Daily Report */}
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setReportOpen(true);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-zinc-300 hover:bg-zinc-900 hover:text-white transition-colors cursor-pointer"
                >
                  <NotebookPen className="size-4 text-zinc-400" />
                  <span className="flex-1 text-start">{t.dailyReport}</span>
                </button>

                {/* Download full AI context */}
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    downloadContext();
                  }}
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-zinc-300 hover:bg-zinc-900 hover:text-white transition-colors cursor-pointer"
                >
                  <Download className="size-4 text-zinc-400" />
                  <span className="flex-1 text-start">{t.downloadContext}</span>
                </button>

                {/* Help & Shortcuts */}
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setHelpOpen(true);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-zinc-300 hover:bg-zinc-900 hover:text-white transition-colors cursor-pointer"
                >
                  <HelpCircle className="size-4 text-zinc-400" />
                  <span className="flex-1 text-start">{t.helpAndShortcuts}</span>
                  <Kbd size="xs">?</Kbd>
                </button>

                <div className="my-1 border-t border-zinc-800/80" />

                {/* Settings Modal Trigger */}
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setSettingsOpen(true);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-zinc-300 hover:bg-zinc-900 hover:text-white transition-colors cursor-pointer"
                >
                  <Settings className="size-4 text-zinc-400" />
                  <span className="flex-1 text-start">
                    {lang === "fa" ? "تنظیمات" : "Settings"}
                  </span>
                  <Kbd size="xs">⌘,</Kbd>
                </button>

                {/* Clear Completed Tasks */}
                {hasDone && (
                  <>
                    <div className="my-1 border-t border-zinc-800/80" />
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        onClearDone();
                      }}
                      className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-zinc-400 hover:bg-red-950/40 hover:text-red-400 transition-colors cursor-pointer"
                    >
                      <Trash2 className="size-4 text-zinc-400" />
                      <span className="flex-1 text-start">{t.clearDone}</span>
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Settings Modal */}
      <SettingsModal
        open={settingsOpen}
        db={db}
        lang={lang}
        onClose={() => setSettingsOpen(false)}
        onUpdateSetting={onUpdateSetting}
        onUpdateMemory={onUpdateMemory}
        onMessage={onMessage}
        onOpenSyncModal={() => setSyncOpen(true)}
      />

      <SyncModal
        open={syncOpen}
        lang={lang}
        onClose={() => setSyncOpen(false)}
        onMessage={onMessage}
      />

      <DailyReportModal
        open={reportOpen}
        db={db}
        lang={lang}
        onSave={onSaveReport}
        onClose={() => setReportOpen(false)}
        onMessage={onMessage}
      />

      <HelpSheet open={helpOpen} lang={lang} onClose={() => setHelpOpen(false)} />

      {/* Fallback Paste Modal */}
      {fallback !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 pt-[calc(1rem+env(safe-area-inset-top,0px))] pb-[calc(1rem+env(safe-area-inset-bottom,0px))] backdrop-blur-xs">
          <div
            className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 text-sm font-semibold text-zinc-100">{t.pasteFallbackTitle}</h3>
            <Textarea
              autoFocus
              rows={8}
              defaultValue={fallback}
              placeholder={t.pasteFallbackPlaceholder}
              className="text-xs mb-3"
              id="sync-fallback-modal"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setFallback(null)}>
                {t.cancel}
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  apply(
                    document.querySelector<HTMLTextAreaElement>("#sync-fallback-modal")?.value ??
                      "",
                  )
                }
              >
                {t.apply}
              </Button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
