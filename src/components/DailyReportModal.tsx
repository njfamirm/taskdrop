import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import { hapticSuccess } from "@/lib/haptics.ts";
import { getTranslation } from "@/lib/i18n.ts";
import type { DB, Language } from "@/lib/types.ts";
import { cn } from "@/lib/utils.ts";
import { CheckCircle2, ChevronLeft, ChevronRight, ClipboardCopy, NotebookPen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

interface Props {
  open: boolean;
  db: DB;
  lang: Language;
  onSave: (date: string, text: string) => void;
  onClose: () => void;
  onMessage: (text: string) => void;
}

function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shiftDay(key: string, delta: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d + delta));
}

export function DailyReportModal({ open, db, lang, onSave, onClose, onMessage }: Props) {
  const t = getTranslation(lang);
  const isFa = lang === "fa";
  const today = dayKey(new Date());
  const [date, setDate] = useState(today);
  const [value, setValue] = useState("");

  const saved = useMemo(
    () => db.reports.find((r) => r.date === date && !r.deletedAt)?.text ?? "",
    [db.reports, date],
  );

  useEffect(() => {
    if (open) setDate(dayKey(new Date()));
  }, [open]);

  useEffect(() => {
    setValue(saved);
  }, [saved, open]);

  const doneTasks = useMemo(
    () =>
      db.tasks
        .filter((x) => x.done && !x.deletedAt && x.doneAt && dayKey(new Date(x.doneAt)) === date)
        .sort((a, b) => new Date(a.doneAt!).getTime() - new Date(b.doneAt!).getTime()),
    [db.tasks, date],
  );

  const pastDates = useMemo(
    () =>
      db.reports
        .filter((r) => !r.deletedAt && r.date !== date)
        .map((r) => r.date)
        .sort()
        .reverse()
        .slice(0, 7),
    [db.reports, date],
  );

  const locale = isFa ? "fa-IR" : "en-US";
  const fmt = (key: string) => {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(locale, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  };

  const dirty = value.trim() !== saved.trim();

  const handleSave = () => {
    onSave(date, value.trim());
    void hapticSuccess();
    onMessage(t.dailyReportSaved);
  };

  const handleCopy = async () => {
    const lines = [`# ${t.dailyReport} — ${fmt(date)}`];
    if (doneTasks.length > 0) {
      lines.push("", `## ${t.dailyReportSummary}`, ...doneTasks.map((x) => `- ${x.title}`));
    }
    if (value.trim()) lines.push("", value.trim());
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      void hapticSuccess();
      onMessage(t.dailyReportCopied);
    } catch {}
  };

  const NavPrev = isFa ? ChevronRight : ChevronLeft;
  const NavNext = isFa ? ChevronLeft : ChevronRight;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent onClose={onClose} className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="grid size-8 place-items-center rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300">
              <NotebookPen className="size-4" />
            </div>
            <DialogTitle>{t.dailyReport}</DialogTitle>
          </div>
          <DialogDescription>{t.dailyReportDesc}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          {/* Day navigator */}
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t.dailyReportPrev}
              title={t.dailyReportPrev}
              onClick={() => setDate((d) => shiftDay(d, -1))}
            >
              <NavPrev className="size-4" />
            </Button>
            <button
              type="button"
              onClick={() => setDate(today)}
              disabled={date === today}
              title={t.dailyReportToday}
              className="text-sm font-semibold text-zinc-100 enabled:cursor-pointer enabled:hover:text-amber-400"
            >
              {fmt(date)}
            </button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t.dailyReportNext}
              title={t.dailyReportNext}
              disabled={date >= today}
              onClick={() => setDate((d) => shiftDay(d, 1))}
            >
              <NavNext className="size-4" />
            </Button>
          </div>

          {/* Completed tasks for the day */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
            <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-zinc-400">
              <span>{t.dailyReportSummary}</span>
              <span className="font-mono text-zinc-300">{t.dailyReportDone(doneTasks.length)}</span>
            </div>
            {doneTasks.length === 0 ? (
              <p className="text-xs text-zinc-500">{t.dailyReportNoDone}</p>
            ) : (
              <ul className="max-h-32 space-y-1 overflow-y-auto">
                {doneTasks.map((x) => (
                  <li key={x.id} className="flex items-start gap-1.5 text-xs text-zinc-300">
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />
                    <span>{x.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Textarea
            rows={6}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t.dailyReportPlaceholder}
            className="font-normal text-xs leading-5"
          />

          {pastDates.length > 0 && (
            <div>
              <div className="mb-1.5 text-[11px] font-medium text-zinc-400">
                {t.dailyReportHistory}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {pastDates.map((d) => (
                  <button
                    type="button"
                    key={d}
                    onClick={() => setDate(d)}
                    className={cn(
                      "rounded-md border border-zinc-800 bg-zinc-900/80 px-2 py-1 text-[11px] text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200 cursor-pointer",
                    )}
                  >
                    {fmt(d)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between border-t border-zinc-800/80 pt-3">
          <Button variant="ghost" size="sm" onClick={handleCopy} className="gap-1.5">
            <ClipboardCopy className="size-3.5" />
            {t.dailyReportCopy}
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t.cancel}
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!dirty}
              className="bg-amber-500 text-zinc-950 hover:bg-amber-400 font-semibold"
            >
              {t.dailyReportSave}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
