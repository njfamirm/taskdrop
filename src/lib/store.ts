import {
  DEFAULT_DB,
  type DB,
  type Note,
  type Priority,
  type Report,
  type Repeat,
  type Task,
} from "@/lib/types.ts";
import { uid } from "@/lib/utils.ts";

const KEY = "daily.db.v1";

const REPEATS: Repeat[] = ["none", "daily", "weekly", "monthly"];
const PRIORITIES: Priority[] = ["none", "low", "medium", "high"];

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeTask(raw: unknown): Task | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Record<string, unknown>;
  const title = str(t.title).trim();
  if (!title) return null;
  const description =
    typeof t.description === "string" && t.description.trim() ? t.description.trim() : null;
  const repeat = REPEATS.includes(t.repeat as Repeat) ? (t.repeat as Repeat) : "none";
  const priority = PRIORITIES.includes(t.priority as Priority) ? (t.priority as Priority) : "none";
  const createdAt = isoOrNull(t.createdAt) ?? new Date().toISOString();
  return {
    id: str(t.id) || uid(),
    title,
    description,
    due: isoOrNull(t.due),
    repeat,
    priority,
    done: bool(t.done, false),
    createdAt,
    updatedAt: isoOrNull(t.updatedAt) ?? createdAt,
    doneAt: isoOrNull(t.doneAt),
    deletedAt: isoOrNull(t.deletedAt),
    notifiedAt: isoOrNull(t.notifiedAt),
    tags: Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === "string") : [],
  };
}

function normalizeNote(raw: unknown): Note | null {
  if (typeof raw !== "object" || raw === null) return null;
  const n = raw as Record<string, unknown>;
  const text = str(n.text).trim();
  if (!text) return null;
  const createdAt = isoOrNull(n.createdAt) ?? new Date().toISOString();
  return {
    id: str(n.id) || uid(),
    text,
    createdAt,
    updatedAt: isoOrNull(n.updatedAt) ?? createdAt,
    deletedAt: isoOrNull(n.deletedAt),
  };
}

function normalizeReport(raw: unknown): Report | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const date = str(r.date);
  const text = str(r.text).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !text) return null;
  return {
    date,
    text,
    updatedAt: isoOrNull(r.updatedAt) ?? new Date().toISOString(),
    deletedAt: isoOrNull(r.deletedAt),
  };
}

/** Normalizes any input payload (e.g. AI-modified json) into a valid TaskDrop DB object */
export function normalizeDB(raw: unknown): DB {
  if (typeof raw !== "object" || raw === null) return structuredClone(DEFAULT_DB);
  const d = raw as Record<string, unknown>;
  const s = (typeof d.settings === "object" && d.settings !== null ? d.settings : {}) as Record<
    string,
    unknown
  >;
  const interval = typeof s.checkIntervalSec === "number" ? s.checkIntervalSec : 15;
  const lead = typeof s.leadMinutes === "number" ? s.leadMinutes : 0;
  return {
    version: 1,
    settings: {
      sound: bool(s.sound, true),
      notifications: bool(s.notifications, true),
      checkIntervalSec: Math.min(3600, Math.max(5, Math.round(interval))),
      leadMinutes: Math.min(1440, Math.max(0, Math.round(lead))),
      theme: s.theme === "light" ? "light" : s.theme === "auto" ? "auto" : "dark",
      language: s.language === "en" ? "en" : "fa",
      alarmTheme:
        s.alarmTheme === "radar" || s.alarmTheme === "crystal" || s.alarmTheme === "classic"
          ? s.alarmTheme
          : "marimba",
    },
    aiMemory: str(d.aiMemory, "").trim(),
    notes: (Array.isArray(d.notes) ? d.notes : [])
      .map(normalizeNote)
      .filter((n): n is Note => n !== null),
    reports: (Array.isArray(d.reports) ? d.reports : [])
      .map(normalizeReport)
      .filter((r): r is Report => r !== null),
    tasks: (Array.isArray(d.tasks) ? d.tasks : [])
      .map(normalizeTask)
      .filter((t): t is Task => t !== null),
  };
}

export function loadDB(): DB {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_DB);
    return normalizeDB(JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_DB);
  }
}

export function saveDB(db: DB) {
  localStorage.setItem(KEY, JSON.stringify(db));
}

/** Extracts valid JSON from unstructured text responses (even if enclosed in ```json fences) */
export function parseIncoming(text: string): DB {
  const trimmed = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const body = fence ? fence[1] : trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No valid JSON structure found in input");
  return normalizeDB(JSON.parse(body.slice(start, end + 1)));
}
