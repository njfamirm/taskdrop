export type Language = "fa" | "en";
export type Repeat = "none" | "daily" | "weekly" | "monthly";
export type Priority = "none" | "low" | "medium" | "high";
export type ThemeMode = "dark" | "light" | "auto";
export type SnoozePreset = "15m" | "1h" | "tomorrow" | "weekend";

export interface Task {
  /** Unique task identifier */
  id: string;
  /** Primary short commitment title */
  title: string;
  /** Optional secondary details, link, or completion summary */
  description?: string | null;
  /** Due ISO 8601 string in local timezone; null if no deadline */
  due: string | null;
  /** Recurring recurrence interval */
  repeat: Repeat;
  /** Priority level */
  priority: Priority;
  done: boolean;
  createdAt: string;
  /** Last updated timestamp */
  updatedAt?: string;
  doneAt: string | null;
  /** Deletion tombstone for conflict-free sync */
  deletedAt?: string | null;
  /** Timestamp when notification was last dispatched */
  notifiedAt: string | null;
  tags: string[];
}

/** Pinned focus note that stays in sight at the top of the workspace */
export interface Note {
  id: string;
  text: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

/** One written daily report; \`date\` is the local day (YYYY-MM-DD) and doubles as the id */
export interface Report {
  date: string;
  text: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface Settings {
  /** Play audible chime on due alarm */
  sound: boolean;
  /** Web / native system notifications */
  notifications: boolean;
  /** Frequency in seconds to check for due reminders */
  checkIntervalSec: number;
  /** Lead warning time in minutes before deadline */
  leadMinutes: number;
  /** Dark, light, or auto theme */
  theme: ThemeMode;
  /** UI Language */
  language?: Language;
  /** Chosen alarm sound synthesis theme */
  alarmTheme?: "marimba" | "radar" | "crystal" | "classic";
}

export interface DB {
  version: 1;
  settings: Settings;
  /** Persistent custom memory and directives for AI */
  aiMemory?: string;
  notes: Note[];
  reports: Report[];
  tasks: Task[];
  lastModified?: string;
}

export const DEFAULT_DB: DB = {
  version: 1,
  settings: {
    sound: true,
    notifications: true,
    checkIntervalSec: 15,
    leadMinutes: 0,
    theme: "dark",
    language: "fa",
  },
  aiMemory: "",
  notes: [],
  reports: [],
  tasks: [],
};
