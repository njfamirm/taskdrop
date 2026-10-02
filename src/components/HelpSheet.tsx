import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { getTranslation } from "@/lib/i18n.ts";
import type { Language } from "@/lib/types.ts";
import { Calendar, Clock, Flame, Keyboard, Repeat, Tag } from "lucide-react";
import type { ReactNode } from "react";

interface Row {
  pattern: string;
  meaning: string;
}

interface ShortcutRow {
  shortcuts: string[][];
  meaning: string;
}

const SHORTCUT_ROWS_FA: ShortcutRow[] = [
  { shortcuts: [["/"], ["N"]], meaning: "فوکوس روی فیلد ثبت تسک جدید" },
  { shortcuts: [["؟"], ["Shift", "/"]], meaning: "باز کردن راهنما و کلیدهای میانبر" },
  {
    shortcuts: [
      ["⌘", ","],
      ["Ctrl", ","],
    ],
    meaning: "باز کردن پنجره تنظیمات برنامه",
  },
  { shortcuts: [["M"]], meaning: "افزودن نکته جدید در بخش جلوی چشم" },
  { shortcuts: [["S"]], meaning: "قطع و وصل صدای زنگ" },
  { shortcuts: [["B"]], meaning: "فعال و غیرفعال‌سازی نوتیفیکیشن" },
  {
    shortcuts: [
      ["Ctrl", "Z"],
      ["⌘", "Z"],
    ],
    meaning: "بازگرداندن آخرین تسک حذف‌شده",
  },
  { shortcuts: [["Esc"]], meaning: "بستن پنجره‌ها یا لغو عملیات" },
];

const SHORTCUT_ROWS_EN: ShortcutRow[] = [
  { shortcuts: [["/"], ["N"]], meaning: "Focus Quick Add input field" },
  { shortcuts: [["?"], ["Shift", "/"]], meaning: "Open help and keyboard shortcuts" },
  {
    shortcuts: [
      ["⌘", ","],
      ["Ctrl", ","],
    ],
    meaning: "Open application settings",
  },
  { shortcuts: [["M"]], meaning: "Add a pinned focus note" },
  { shortcuts: [["S"]], meaning: "Toggle alarm sound" },
  { shortcuts: [["B"]], meaning: "Toggle notifications" },
  {
    shortcuts: [
      ["Ctrl", "Z"],
      ["⌘", "Z"],
    ],
    meaning: "Undo last deleted task",
  },
  { shortcuts: [["Esc"]], meaning: "Close modals or clear input" },
];

const PRIORITY_ROWS_FA: Row[] = [
  { pattern: "!فوری / !مهم / فوری / ضروری", meaning: "اولویت بالا با نشانگر قرمز" },
  { pattern: "!متوسط / اولویت متوسط", meaning: "اولویت متوسط با نشانگر نارنجی" },
  { pattern: "!کم / سر فرصت / هر وقت شد", meaning: "اولویت پایین با نشانگر آبی" },
];

const PRIORITY_ROWS_EN: Row[] = [
  { pattern: "!urgent / !high / !p1", meaning: "High priority with red accent" },
  { pattern: "!medium / !med / !p2", meaning: "Medium priority with amber badge" },
  { pattern: "!low / !p3", meaning: "Low priority with subtle blue indicator" },
];

const DATE_ROWS_FA: Row[] = [
  { pattern: "امروز / فردا / پس‌فردا", meaning: "همان روز، ساعت پیش‌فرض ۹:۰۰" },
  { pattern: "آخر هفته / پایان هفته", meaning: "پنج‌شنبه ساعت ۹:۰۰" },
  { pattern: "دوشنبه / شنبه هفته بعد", meaning: "روز مشخص هفته" },
  { pattern: "۱۴۰۴/۰۷/۱۲ یا 2026-09-28", meaning: "تاریخ تقویمی" },
];

const DATE_ROWS_EN: Row[] = [
  { pattern: "today / tomorrow / day after tomorrow", meaning: "Target day, default 9:00 AM" },
  { pattern: "weekend / next week", meaning: "Saturday 9:00 AM / next week" },
  { pattern: "monday / next friday", meaning: "Specific weekday target" },
  { pattern: "2026-09-28", meaning: "Explicit calendar date" },
];

const TIME_ROWS_FA: Row[] = [
  { pattern: "اول صبح / صبح / ظهر / عصر / غروب / شب / آخر شب", meaning: "بازه زمانی مشخص در روز" },
  { pattern: "ساعت ۱۰ / ساعت 22:30 / ۸ صبح / ۹pm", meaning: "ساعت دقیق عددی" },
  { pattern: "نیم ساعت دیگه / یک ربع دیگه / +۲ ساعت دیگه", meaning: "نسبت به همین لحظه" },
];

const TIME_ROWS_EN: Row[] = [
  { pattern: "morning / noon / afternoon / evening / night", meaning: "Named time interval" },
  { pattern: "10am / 10:30pm / at 9:15 / 17:00", meaning: "Exact clock time" },
  { pattern: "+2h / in 30 min / in 15m / 3 days from now", meaning: "Relative time from now" },
];

const REPEAT_ROWS_FA: Row[] = [
  { pattern: "هر روز / روزانه", meaning: "تکرار روزانه" },
  { pattern: "هر هفته / هفتگی", meaning: "تکرار هفتگی" },
  { pattern: "هر ماه / ماهانه", meaning: "تکرار ماهانه" },
];

const REPEAT_ROWS_EN: Row[] = [
  { pattern: "daily / every day", meaning: "Daily recurrence" },
  { pattern: "weekly / every week", meaning: "Weekly recurrence" },
  { pattern: "monthly / every month", meaning: "Monthly recurrence" },
];

const OTHER_ROWS_FA: Row[] = [
  { pattern: "#کار / #پروژه / #شخصی", meaning: "برچسب‌ها و حوزه‌ها (#key:value)" },
  { pattern: "// توضیحات بیشتر", meaning: "توضیحات و جزئیات تکمیلی تسک" },
  { pattern: "بدون هیچ‌کدام از بالا", meaning: "ثبت تسک ساده بدون موعد" },
];

const OTHER_ROWS_EN: Row[] = [
  { pattern: "#work / #project / #personal", meaning: "Tags and scopes (#key:value)" },
  { pattern: "// meeting notes / link", meaning: "Secondary details and links" },
  { pattern: "No keywords", meaning: "Simple floating task without deadline" },
];

function ShortcutsTable({
  title,
  icon,
  rows,
  orText,
}: {
  title: string;
  icon?: ReactNode;
  rows: ShortcutRow[];
  orText: string;
}) {
  return (
    <div>
      <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-zinc-300">
        {icon}
        <span>{title}</span>
      </h3>
      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60">
        {rows.map((r, i) => (
          <div
            key={i}
            className={
              "flex items-center justify-between gap-4 px-3 py-2 text-sm" +
              (i > 0 ? " border-t border-zinc-800/80" : "")
            }
          >
            <div className="flex flex-wrap items-center gap-1.5 shrink-0">
              {r.shortcuts.map((combo, comboIdx) => (
                <div key={comboIdx} className="flex items-center gap-1">
                  {comboIdx > 0 && (
                    <span className="text-[11px] text-zinc-500 px-0.5">{orText}</span>
                  )}
                  {combo.map((k, kIdx) => (
                    <span key={kIdx} className="flex items-center gap-1">
                      {kIdx > 0 && <span className="text-[10px] text-zinc-500">+</span>}
                      <Kbd size="xs">{k}</Kbd>
                    </span>
                  ))}
                </div>
              ))}
            </div>
            <span className="text-end text-zinc-400 text-xs">{r.meaning}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Table({ title, icon, rows }: { title: string; icon?: ReactNode; rows: Row[] }) {
  return (
    <div>
      <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-zinc-300">
        {icon}
        <span>{title}</span>
      </h3>
      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60">
        {rows.map((r, i) => (
          <div
            key={r.pattern}
            className={
              "flex items-start justify-between gap-4 px-3 py-2 text-sm" +
              (i > 0 ? " border-t border-zinc-800/80" : "")
            }
          >
            <code className="shrink-0 text-zinc-200 bg-zinc-800/80 px-2 py-0.5 rounded-md text-xs border border-zinc-700/60 shadow-xs">
              {r.pattern}
            </code>
            <span className="text-end text-zinc-400 text-xs leading-5">{r.meaning}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface Props {
  open: boolean;
  lang?: Language;
  onClose: () => void;
}

/** Help sheet displaying natural language parsing patterns and keyboard shortcuts */
export function HelpSheet({ open, lang = "fa", onClose }: Props) {
  const t = getTranslation(lang);
  const isFa = lang === "fa";

  const shortcutRows = isFa ? SHORTCUT_ROWS_FA : SHORTCUT_ROWS_EN;
  const priorityRows = isFa ? PRIORITY_ROWS_FA : PRIORITY_ROWS_EN;
  const dateRows = isFa ? DATE_ROWS_FA : DATE_ROWS_EN;
  const timeRows = isFa ? TIME_ROWS_FA : TIME_ROWS_EN;
  const repeatRows = isFa ? REPEAT_ROWS_FA : REPEAT_ROWS_EN;
  const otherRows = isFa ? OTHER_ROWS_FA : OTHER_ROWS_EN;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent onClose={onClose} className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.helpTitle}</DialogTitle>
          <DialogDescription>{t.helpIntro}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto space-y-4 pe-1">
          <ShortcutsTable
            title={t.helpShortcutsTitle}
            icon={<Keyboard className="size-4 text-zinc-400" />}
            rows={shortcutRows}
            orText={t.helpOr}
          />
          <Table
            title={t.helpPriorityTitle}
            icon={<Flame className="size-4 text-zinc-400" />}
            rows={priorityRows}
          />
          <Table
            title={t.helpDateTitle}
            icon={<Calendar className="size-4 text-zinc-400" />}
            rows={dateRows}
          />
          <Table
            title={t.helpTimeTitle}
            icon={<Clock className="size-4 text-zinc-400" />}
            rows={timeRows}
          />
          <Table
            title={t.helpRepeatTitle}
            icon={<Repeat className="size-4 text-zinc-400" />}
            rows={repeatRows}
          />
          <Table
            title={t.helpTagsTitle}
            icon={<Tag className="size-4 text-zinc-400" />}
            rows={otherRows}
          />

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-3 text-sm">
            <div className="mb-1 text-xs font-semibold text-zinc-400">{t.helpExampleTitle}</div>
            <code className="text-zinc-100 text-xs">{t.helpExampleText}</code>
            <div className="mt-1 text-xs text-zinc-400">{t.helpExampleExplanation}</div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t.close}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
