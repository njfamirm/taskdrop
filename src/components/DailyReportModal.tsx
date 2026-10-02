import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent } from "@/components/ui/dialog.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import { buildReportPayload } from "@/lib/payload.ts";
import { hapticSuccess } from "@/lib/haptics.ts";
import { getTranslation } from "@/lib/i18n.ts";
import type { DB, Language } from "@/lib/types.ts";
import { cn } from "@/lib/utils.ts";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  NotebookPen,
  Sparkles,
} from "lucide-react";
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

function parseKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function shiftDay(key: string, delta: number): string {
  const d = parseKey(key);
  d.setDate(d.getDate() + delta);
  return dayKey(d);
}

const PRIORITY_DOT: Record<string, string> = {
  high: "bg-red-400",
  medium: "bg-amber-400",
  low: "bg-sky-400",
};

export function DailyReportModal({ open, db, lang, onSave, onClose, onMessage }: Props) {
  const t = getTranslation(lang);
  const isFa = lang === "fa";
  const locale = isFa ? "fa-IR" : "en-US";
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

  const doneByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const x of db.tasks) {
      if (x.done && !x.deletedAt && x.doneAt) {
        const k = dayKey(new Date(x.doneAt));
        map.set(k, (map.get(k) ?? 0) + 1);
      }
    }
    return map;
  }, [db.tasks]);

  const reportDays = useMemo(
    () => new Set(db.reports.filter((r) => !r.deletedAt && r.text.trim()).map((r) => r.date)),
    [db.reports],
  );

  const doneTasks = useMemo(
    () =>
      db.tasks
        .filter((x) => x.done && !x.deletedAt && x.doneAt && dayKey(new Date(x.doneAt)) === date)
        .sort((a, b) => new Date(a.doneAt!).getTime() - new Date(b.doneAt!).getTime()),
    [db.tasks, date],
  );

  // 7-day window that always contains the selected day and never goes past today
  const week = useMemo(() => {
    const end = shiftDay(date, 3) > today ? today : shiftDay(date, 3);
    return Array.from({ length: 7 }, (_, i) => shiftDay(end, i - 6));
  }, [date, today]);

  const longDate = (key: string) =>
    parseKey(key).toLocaleDateString(locale, { month: "long", day: "numeric", year: "numeric" });
  const weekday = (key: string, style: "long" | "short") =>
    parseKey(key).toLocaleDateString(locale, { weekday: style });
  const dayNum = (key: string) => parseKey(key).toLocaleDateString(locale, { day: "numeric" });
  const timeOf = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

  const relative =
    date === today
      ? t.dailyReportToday
      : date === shiftDay(today, -1)
        ? t.dailyReportYesterday
        : null;

  const trimmed = value.trim();
  const dirty = trimmed !== saved.trim();
  const status = dirty
    ? { label: t.dailyReportStatusDraft, dot: "bg-amber-400" }
    : saved.trim()
      ? { label: t.dailyReportStatusSaved, dot: "bg-emerald-400" }
      : { label: t.dailyReportStatusEmpty, dot: "bg-zinc-600" };

  const handleSave = () => {
    if (!dirty) return;
    onSave(date, trimmed);
    void hapticSuccess();
    onMessage(t.dailyReportSaved);
  };

  const handleCopy = async () => {
    const lines = [`# ${t.dailyReport} — ${longDate(date)}`];
    if (doneTasks.length > 0) {
      lines.push("", `## ${t.dailyReportSummary}`, ...doneTasks.map((x) => `- ${x.title}`));
    }
    if (trimmed) lines.push("", trimmed);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      void hapticSuccess();
      onMessage(t.dailyReportCopied);
    } catch {}
  };

  const handleAskAI = async () => {
    try {
      await navigator.clipboard.writeText(buildReportPayload(db, date));
      void hapticSuccess();
      onMessage(t.dailyReportAICopied);
    } catch {}
  };

  const NavPrev = isFa ? ChevronRight : ChevronLeft;
  const NavNext = isFa ? ChevronLeft : ChevronRight;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent
        onClose={onClose}
        className="max-w-4xl gap-0 p-0 sm:h-[min(44rem,85vh)]"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSave();
        }}
      >
        {/* Hero header */}
        <div className="border-b border-zinc-800/80 bg-gradient-to-b from-zinc-900/80 to-zinc-950 px-5 pb-4 pt-5 sm:px-7 sm:pt-6">
          <div className="flex items-center gap-3 pe-10">
            <div className="grid size-11 shrink-0 place-items-center rounded-2xl border border-amber-500/20 bg-amber-500/10 text-amber-400">
              <NotebookPen className="size-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-xl font-bold leading-tight text-zinc-50 sm:text-2xl">
                  {weekday(date, "long")}
                </h2>
                {relative && (
                  <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-amber-400">
                    {relative}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-zinc-400">{longDate(date)}</p>
            </div>
          </div>

          {/* Week strip */}
          <div className="mt-4 flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t.dailyReportPrev}
              title={t.dailyReportPrev}
              onClick={() => setDate((d) => shiftDay(d, -1))}
              className="shrink-0 text-zinc-400"
            >
              <NavPrev className="size-4" />
            </Button>
            <div className="grid flex-1 grid-cols-7 gap-1 sm:gap-1.5">
              {week.map((k) => {
                const active = k === date;
                const count = doneByDay.get(k) ?? 0;
                return (
                  <button
                    type="button"
                    key={k}
                    onClick={() => setDate(k)}
                    className={cn(
                      "group relative flex flex-col items-center gap-0.5 rounded-xl border px-1 py-2 transition cursor-pointer",
                      active
                        ? "border-amber-500/50 bg-amber-500/10 text-amber-300 shadow-[0_0_0_1px_rgba(245,158,11,0.15)]"
                        : "border-zinc-800 bg-zinc-900/50 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200",
                    )}
                  >
                    <span className="text-[10px] font-medium opacity-80">
                      {weekday(k, "short")}
                    </span>
                    <span className="text-base font-bold leading-none sm:text-lg">{dayNum(k)}</span>
                    <span className="mt-1 flex h-1.5 items-center gap-0.5">
                      {count > 0 && (
                        <span
                          className={cn(
                            "size-1.5 rounded-full",
                            active ? "bg-amber-400" : "bg-zinc-500",
                          )}
                        />
                      )}
                      {reportDays.has(k) && (
                        <span className="size-1.5 rounded-full bg-emerald-400" />
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t.dailyReportNext}
              title={t.dailyReportNext}
              disabled={date >= today}
              onClick={() => setDate((d) => shiftDay(d, 1))}
              className="shrink-0 text-zinc-400"
            >
              <NavNext className="size-4" />
            </Button>
          </div>
        </div>

        {/* Body: completed tasks + editor */}
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[18rem_1fr] md:overflow-hidden">
          <section className="flex min-h-0 flex-col border-b border-zinc-800/80 bg-zinc-900/30 p-5 md:border-b-0 md:border-e md:p-6">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-zinc-200">{t.dailyReportSummary}</h3>
              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-400">
                {doneTasks.length.toLocaleString(locale)}
              </span>
            </div>
            {doneTasks.length === 0 ? (
              <div className="grid flex-1 place-items-center rounded-xl border border-dashed border-zinc-800 p-5 text-center text-xs leading-5 text-zinc-500">
                {t.dailyReportNoDone}
              </div>
            ) : (
              <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pe-1 max-md:max-h-56">
                {doneTasks.map((x) => (
                  <li
                    key={x.id}
                    className="flex items-start gap-2 rounded-xl border border-zinc-800/80 bg-zinc-900/60 px-3 py-2"
                  >
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] leading-5 text-zinc-200">{x.title}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-zinc-500">
                        {x.priority && PRIORITY_DOT[x.priority] && (
                          <span className={cn("size-1.5 rounded-full", PRIORITY_DOT[x.priority])} />
                        )}
                        <span>{timeOf(x.doneAt!)}</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex min-h-0 flex-col p-5 md:p-6">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-zinc-200">{t.dailyReportWriteTitle}</h3>
              <span className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                <span className={cn("size-1.5 rounded-full", status.dot)} />
                {status.label}
              </span>
            </div>
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={t.dailyReportPlaceholder}
              className="min-h-56 flex-1 resize-none rounded-xl bg-zinc-900/60 p-4 text-sm font-normal leading-7 md:min-h-0"
            />
            <div className="mt-2 text-end text-[11px] text-zinc-500">
              {t.dailyReportChars(trimmed.length.toLocaleString(locale))}
            </div>
          </section>
        </div>

        {/* Footer actions */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800/80 bg-zinc-950 px-5 py-3.5 sm:px-7">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleAskAI}
              className="gap-1.5 border-amber-500/30 bg-amber-500/5 text-amber-300 hover:bg-amber-500/10"
            >
              <Sparkles className="size-3.5" />
              {t.dailyReportAI}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleCopy} className="gap-1.5">
              <ClipboardCopy className="size-3.5" />
              {t.dailyReportCopy}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t.cancel}
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!dirty}
              className="bg-amber-500 px-5 font-semibold text-zinc-950 hover:bg-amber-400"
            >
              {t.dailyReportSave}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
