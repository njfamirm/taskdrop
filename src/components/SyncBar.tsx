import { AIMemorySheet } from "@/components/AIMemorySheet.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import { getTranslation } from "@/lib/i18n.ts";
import { buildPayload } from "@/lib/payload.ts";
import { parseIncoming } from "@/lib/store.ts";
import type { DB, Language } from "@/lib/types.ts";
import { Brain, Check, ClipboardCopy, ClipboardPaste } from "lucide-react";
import { useState } from "react";

interface Props {
  db: DB;
  lang?: Language;
  onReplace: (db: DB) => void;
  onUpdateMemory?: (memory: string) => void;
  onMessage: (text: string, undo?: () => void) => void;
}

/** Legacy / alternative sync toolbar component */
export function SyncBar({ db, lang = "fa", onReplace, onUpdateMemory, onMessage }: Props) {
  const t = getTranslation(lang);
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);

  const copy = async () => {
    const text = buildPayload(db);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setFallback(text);
    }
  };

  const apply = (text: string) => {
    const before = db;
    try {
      onReplace(parseIncoming(text));
      setFallback(null);
      onMessage(t.pasteSuccess, () => onReplace(before));
    } catch (err) {
      onMessage(t.pasteFailed(err instanceof Error ? err.message : "Invalid input"));
    }
  };

  const paste = async () => {
    try {
      apply(await navigator.clipboard.readText());
    } catch {
      setFallback("");
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={copy} title={t.copyTitle}>
          {copied ? <Check /> : <ClipboardCopy />}
          {copied ? t.copied : t.copy}
        </Button>
        <Button variant="outline" size="sm" onClick={paste} title={t.pasteTitle}>
          <ClipboardPaste />
          {t.paste}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setMemoryOpen(true)}
          title={t.aiMemoryTitle}
          className="gap-1.5 border-zinc-700 bg-zinc-800/80 text-zinc-200 hover:bg-zinc-700 cursor-pointer"
        >
          <Brain className="size-3.5 text-zinc-400" />
          {t.aiMemory}
          {db.aiMemory?.trim() && (
            <span className="size-1.5 rounded-full bg-amber-400 animate-pulse" />
          )}
        </Button>
      </div>

      <AIMemorySheet
        open={memoryOpen}
        memory={db.aiMemory || ""}
        lang={lang}
        onSave={(mem) => {
          onUpdateMemory?.(mem);
          onMessage(t.aiMemoryUpdated);
        }}
        onClose={() => setMemoryOpen(false)}
      />

      {fallback !== null && (
        <div className="mt-2 space-y-2">
          <Textarea
            autoFocus
            rows={6}
            defaultValue={fallback}
            placeholder={t.pasteFallbackPlaceholder}
            className="text-xs"
            onKeyDown={(e) => {
              if (e.key === "Escape") setFallback(null);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) apply(e.currentTarget.value);
            }}
            id="sync-fallback"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() =>
                apply(document.querySelector<HTMLTextAreaElement>("#sync-fallback")?.value ?? "")
              }
            >
              {t.apply}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setFallback(null)}>
              {t.cancel}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
