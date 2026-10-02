import { AlarmModal } from "@/components/AlarmModal.tsx";
import { CategoryFilter } from "@/components/CategoryFilter.tsx";
import { Header } from "@/components/Header.tsx";
import { Notes } from "@/components/Notes.tsx";
import { QuickAdd } from "@/components/QuickAdd.tsx";
import { SearchBar } from "@/components/SearchBar.tsx";
import { TaskItem } from "@/components/TaskItem.tsx";
import { UpdateDialog } from "@/components/UpdateDialog.tsx";
import { fireConfettiAt } from "@/lib/confetti.ts";
import { fuzzySearchTasks } from "@/lib/fuzzy.ts";
import { hapticLight, hapticMedium, hapticSuccess, hapticWarning } from "@/lib/haptics.ts";
import { getTranslation, updateDocumentDirection } from "@/lib/i18n.ts";
import { initNotificationChannel, syncAllTaskNotifications } from "@/lib/notifications.ts";
import { notify, requestNotificationPermission, setBadge } from "@/lib/notify.ts";
import { parseInput } from "@/lib/parse.ts";
import type { DB, Language, SnoozePreset, Task } from "@/lib/types.ts";
import { useAutoCloudSync } from "@/lib/useCloudSync.ts";
import { useDB } from "@/lib/useDB.ts";
import { cn, uid } from "@/lib/utils.ts";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  CheckSquare,
  Clock,
  Flame,
  SearchX,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export type SortMode = "priority" | "due" | "created";

function nextDue(iso: string, repeat: Task["repeat"], from = new Date()): string {
  const d = new Date(iso);
  let guard = 0;
  while (d.getTime() <= from.getTime() && guard++ < 500) {
    if (repeat === "daily") d.setDate(d.getDate() + 1);
    else if (repeat === "weekly") d.setDate(d.getDate() + 7);
    else d.setMonth(d.getMonth() + 1);
  }
  return d.toISOString();
}

function computeSnoozeTime(preset: SnoozePreset): string {
  const d = new Date();
  if (preset === "15m") {
    d.setMinutes(d.getMinutes() + 15);
  } else if (preset === "1h") {
    d.setHours(d.getHours() + 1);
  } else if (preset === "tomorrow") {
    d.setDate(d.getDate() + 1);
    d.setHours(8, 30, 0, 0);
  } else if (preset === "weekend") {
    const day = d.getDay(); // 0: Sun, 6: Sat
    let daysUntilSat = (6 - day + 7) % 7;
    if (daysUntilSat === 0) daysUntilSat = 7;
    d.setDate(d.getDate() + daysUntilSat);
    d.setHours(9, 0, 0, 0);
  }
  return d.toISOString();
}

export function App() {
  const { db, setDb, update } = useDB();
  const lang: Language = db.settings.language || "fa";
  const t = getTranslation(lang);

  // Sync document direction and language attribute with active setting
  useEffect(() => {
    updateDocumentDirection(lang);
  }, [lang]);

  // Automatic real-time background cloud synchronization
  const initialSyncDone = useAutoCloudSync({
    db,
    onApplyRemote: setDb,
  });

  const [now, setNow] = useState(() => Date.now());
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [ringingTasks, setRingingTasks] = useState<Task[]>([]);
  const [showInput, setShowInput] = useState(() => {
    try {
      const saved = localStorage.getItem("daily.showInput");
      return saved !== null ? saved === "true" : true;
    } catch {
      return true;
    }
  });
  const [showSearch, setShowSearch] = useState(() => {
    try {
      const saved = localStorage.getItem("daily.showSearch");
      return saved !== null ? saved === "true" : false;
    } catch {
      return false;
    }
  });
  const firedRef = useRef(false);

  const toggleInput = () => {
    setShowInput((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("daily.showInput", String(next));
      } catch {}
      return next;
    });
  };

  const toggleSearch = () => {
    setShowSearch((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("daily.showSearch", String(next));
      } catch {}
      if (!next) {
        setSearchQuery("");
      }
      return next;
    });
  };

  // Global shortcut to reveal search bar if hidden
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowSearch(true);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const showToast = (text: string, undo?: () => void) => {
    setToast({ text, undo });
    setTimeout(() => setToast(null), undo ? 8000 : 3000);
  };

  // Initialize native notification channel with high priority and action buttons
  useEffect(() => {
    void initNotificationChannel();
  }, []);

  // Sync native device scheduled alarms with active tasks
  useEffect(() => {
    void syncAllTaskNotifications(db.tasks);
  }, [db.tasks]);

  // Handle Capacitor native notification events & actions
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let isMounted = true;
    let actionSub: { remove: () => void } | null = null;
    let receiveSub: { remove: () => void } | null = null;

    void LocalNotifications.addListener("localNotificationActionPerformed", (action) => {
      if (!isMounted) return;
      const taskId = action.notification.extra?.taskId;
      if (!taskId) return;

      if (action.actionId === "snooze_15m") {
        snooze(taskId, "15m");
      } else if (action.actionId === "done") {
        toggle(taskId);
      } else {
        // Dismiss action or clicked notification: display ringing alarm modal if still open
        const task = db.tasks.find((t) => t.id === taskId);
        if (task && !task.done && !task.deletedAt) {
          setRingingTasks((prev) => (prev.some((p) => p.id === taskId) ? prev : [...prev, task]));
        }
      }
    }).then((sub) => {
      actionSub = sub;
    });

    void LocalNotifications.addListener("localNotificationReceived", (notification) => {
      if (!isMounted) return;
      const taskId = notification.extra?.taskId;
      if (!taskId) return;
      const task = db.tasks.find((t) => t.id === taskId);
      if (task && !task.done && !task.deletedAt) {
        setRingingTasks((prev) => (prev.some((p) => p.id === taskId) ? prev : [...prev, task]));
      }
    }).then((sub) => {
      receiveSub = sub;
    });

    return () => {
      isMounted = false;
      actionSub?.remove();
      receiveSub?.remove();
    };
  }, [db.tasks]);

  // Periodic reminder checking engine (checks due alarms every interval)
  useEffect(() => {
    // Hold alarms until the first sync settles so stale local state can't ring already-done tasks
    if (!initialSyncDone) return;
    const tick = () => {
      setNow(Date.now());
      const currentTime = Date.now();
      const lead = db.settings.leadMinutes * 60_000;

      const ring: Task[] = db.tasks.filter(
        (x) =>
          !x.done &&
          !x.deletedAt &&
          x.due !== null &&
          new Date(x.due).getTime() - lead <= currentTime &&
          (x.notifiedAt === null || new Date(x.notifiedAt).getTime() < new Date(x.due).getTime()),
      );

      if (ring.length > 0) {
        // Trigger fullscreen alarm modal
        setRingingTasks((prev) => {
          const prevIds = new Set(prev.map((p) => p.id));
          const additions = ring.filter((r) => !prevIds.has(r.id));
          return additions.length > 0 ? [...prev, ...additions] : prev;
        });

        // Browser notification
        if (db.settings.notifications) {
          for (const x of ring) {
            notify(t.appName, x.title);
          }
        }

        const ids = new Set(ring.map((x) => x.id));
        const nowIso = new Date().toISOString();
        update((prev) => ({
          ...prev,
          tasks: prev.tasks.map((x) =>
            // Do not bump updatedAt: ringing is not a user edit and must never win LWW over a remote "done"
            ids.has(x.id) ? { ...x, notifiedAt: nowIso } : x,
          ),
        }));
      }
    };

    tick();
    const id = setInterval(tick, db.settings.checkIntervalSec * 1000);
    return () => clearInterval(id);
  }, [db, update, t.appName, initialSyncDone]);

  const due = useMemo(
    () =>
      db.tasks.filter(
        (t) => !t.done && !t.deletedAt && t.due !== null && new Date(t.due).getTime() <= now,
      ).length,
    [db.tasks, now],
  );

  useEffect(() => {
    setBadge(due);
  }, [due]);

  // Request notification permission on first user gesture
  useEffect(() => {
    const ask = () => {
      if (firedRef.current) return;
      firedRef.current = true;
      if (db.settings.notifications) void requestNotificationPermission();
    };
    window.addEventListener("pointerdown", ask, { once: true });
    window.addEventListener("keydown", ask, { once: true });
    return () => {
      window.removeEventListener("pointerdown", ask);
      window.removeEventListener("keydown", ask);
    };
  }, [db.settings.notifications]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeTag = (document.activeElement?.tagName || "").toLowerCase();
      const isInputActive =
        activeTag === "input" ||
        activeTag === "textarea" ||
        (document.activeElement as HTMLElement)?.isContentEditable;

      // Undo: Ctrl+Z or Cmd+Z
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !isInputActive) {
        if (toast?.undo) {
          e.preventDefault();
          toast.undo();
          setToast(null);
        }
        return;
      }

      if (isInputActive) return;

      // Quick add focus: '/' or 'n' or 'N'
      if (e.key === "/" || e.key === "n" || e.key === "N") {
        e.preventDefault();
        setShowInput(true);
        setTimeout(() => {
          const input = document.querySelector<HTMLInputElement>("#quick-add-input");
          input?.focus();
        }, 50);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toast]);

  const addTask = (raw: string) => {
    const p = parseInput(raw);
    if (!p.title) return;
    void hapticLight();
    const nowIso = new Date().toISOString();
    const task: Task = {
      id: uid(),
      title: p.title,
      description: p.description || null,
      due: p.due ? p.due.toISOString() : null,
      repeat: p.repeat,
      priority: p.priority,
      done: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      doneAt: null,
      deletedAt: null,
      notifiedAt: null,
      tags: p.tags,
    };
    update((prev) => ({ ...prev, tasks: [task, ...prev.tasks] }));
  };

  const toggle = (id: string, event?: React.MouseEvent) => {
    // Remove from ringing tasks if active
    setRingingTasks((prev) => prev.filter((t) => t.id !== id));

    update((prev) => {
      const target = prev.tasks.find((t) => t.id === id);
      if (target && !target.done) {
        fireConfettiAt(event);
        void hapticSuccess();
      } else {
        void hapticLight();
      }
      const nowIso = new Date().toISOString();
      return {
        ...prev,
        tasks: prev.tasks.map((t) => {
          if (t.id !== id) return t;
          // Recurring task advances to the next period instead of closing
          if (!t.done && t.repeat !== "none" && t.due) {
            return {
              ...t,
              due: nextDue(t.due, t.repeat),
              notifiedAt: null,
              updatedAt: nowIso,
            };
          }
          return {
            ...t,
            done: !t.done,
            doneAt: t.done ? null : nowIso,
            updatedAt: nowIso,
          };
        }),
      };
    });
  };

  const remove = (id: string) => {
    // Remove from ringing tasks if active
    setRingingTasks((prev) => prev.filter((t) => t.id !== id));
    void hapticWarning();
    const before = db;
    const nowIso = new Date().toISOString();
    update((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) =>
        t.id === id ? { ...t, deletedAt: nowIso, updatedAt: nowIso } : t,
      ),
    }));
    showToast(t.deleted, () => setDb(before));
  };

  const snooze = (id: string, preset: SnoozePreset) => {
    // Dismiss from active alarm modal
    setRingingTasks((prev) => prev.filter((t) => t.id !== id));
    void hapticMedium();
    const before = db;
    const targetIso = computeSnoozeTime(preset);
    const nowIso = new Date().toISOString();
    update((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) =>
        t.id === id
          ? { ...t, due: targetIso, notifiedAt: null, done: false, updatedAt: nowIso }
          : t,
      ),
    }));
    const label =
      preset === "15m"
        ? t.snooze15m
        : preset === "1h"
          ? t.snooze1h
          : preset === "tomorrow"
            ? t.snoozeTomorrow
            : t.snoozeWeekend;
    showToast(t.snoozedToast(label), () => setDb(before));
  };

  const dismissAlarm = (taskIds: string[]) => {
    const idSet = new Set(taskIds);
    setRingingTasks((prev) => prev.filter((t) => !idSet.has(t.id)));
  };

  const rename = (id: string, title: string, description?: string | null) => {
    const nowIso = new Date().toISOString();
    update((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) =>
        t.id === id
          ? {
              ...t,
              title: title.trim() || t.title,
              description: description !== undefined ? description : t.description,
              updatedAt: nowIso,
            }
          : t,
      ),
    }));
  };

  const updateTask = (id: string, updates: Partial<Omit<Task, "id" | "createdAt">>) => {
    const before = db;
    const nowIso = new Date().toISOString();
    update((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) =>
        t.id === id
          ? {
              ...t,
              ...updates,
              updatedAt: nowIso,
            }
          : t,
      ),
    }));

    if (updates.priority !== undefined && Object.keys(updates).length === 1) {
      const p = updates.priority;
      const label =
        p === "high"
          ? t.priorityHigh
          : p === "medium"
            ? t.priorityMedium
            : p === "low"
              ? t.priorityLow
              : t.priorityNone;
      showToast(t.priorityChangedToast(label), () => setDb(before));
    } else {
      showToast(t.taskUpdatedToast, () => setDb(before));
    }
  };

  const clearDone = () => {
    void hapticWarning();
    const before = db;
    const nowIso = new Date().toISOString();
    update((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) =>
        t.done && !t.deletedAt ? { ...t, deletedAt: nowIso, updatedAt: nowIso } : t,
      ),
    }));
    showToast(t.clearDoneSuccess, () => setDb(before));
  };

  const [sortBy, setSortBy] = useState<SortMode>(() => {
    try {
      const saved = localStorage.getItem("daily.sortBy") as SortMode | null;
      if (saved === "priority" || saved === "due" || saved === "created") return saved;
    } catch {}
    return "priority";
  });

  const handleSetSortBy = (mode: SortMode) => {
    void hapticLight();
    setSortBy(mode);
    try {
      localStorage.setItem("daily.sortBy", mode);
    } catch {}
  };

  const sortOptions = useMemo(
    () => [
      { id: "priority" as const, label: t.sortPriority, icon: Flame, iconColor: "text-red-400" },
      { id: "due" as const, label: t.sortDue, icon: Clock, iconColor: "text-emerald-400" },
      { id: "created" as const, label: t.sortCreated, icon: Sparkles, iconColor: "text-sky-400" },
    ],
    [t.sortPriority, t.sortDue, t.sortCreated],
  );

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const t of db.tasks) {
      if (t.deletedAt) continue;
      for (const tag of t.tags || []) {
        if (tag.trim()) set.add(tag.trim());
      }
    }
    return Array.from(set);
  }, [db.tasks]);

  // Filter tasks based on selected Category and Fuzzy Search Query
  const filteredTasks = useMemo(() => {
    let list = db.tasks.filter((t) => !t.deletedAt);

    // 1. Category filter
    if (selectedCategory === "uncategorized") {
      list = list.filter((t) => !t.tags || t.tags.length === 0);
    } else if (selectedCategory) {
      list = list.filter((t) => t.tags && t.tags.includes(selectedCategory));
    }

    // 2. Fuzzy Search filter
    if (searchQuery.trim()) {
      list = fuzzySearchTasks(list, searchQuery);
    }

    return list;
  }, [db.tasks, selectedCategory, searchQuery]);

  const groups = useMemo(() => {
    const open = filteredTasks.filter((t) => !t.done);
    const ts = (t: Task) => (t.due ? new Date(t.due).getTime() : Infinity);

    if (sortBy === "priority") {
      const sortTasks = (a: Task, b: Task) => {
        const pWeight = { high: 0, medium: 1, none: 2, low: 3 };
        const aP = pWeight[a.priority || "none"];
        const bP = pWeight[b.priority || "none"];
        if (aP !== bP) return aP - bP;

        const aOverdue = a.due && ts(a) <= now ? 0 : 1;
        const bOverdue = b.due && ts(b) <= now ? 0 : 1;
        if (aOverdue !== bOverdue) return aOverdue - bOverdue;

        const timeDiff = ts(a) - ts(b);
        if (timeDiff !== 0) return timeDiff;

        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      };

      const highPriority = open.filter((t) => t.priority === "high").sort(sortTasks);
      const regularTasks = open.filter((t) => t.priority !== "high").sort(sortTasks);
      const done = filteredTasks.filter((t) => t.done).slice(0, 25);

      return {
        mode: "priority" as const,
        highPriority,
        regularTasks,
        done,
      };
    }

    if (sortBy === "due") {
      const overdue = open
        .filter((t) => t.due !== null && ts(t) <= now)
        .sort((a, b) => ts(a) - ts(b));

      const upcoming = open
        .filter((t) => t.due !== null && ts(t) > now)
        .sort((a, b) => ts(a) - ts(b));

      const noDue = open
        .filter((t) => t.due === null)
        .sort((a, b) => {
          const pWeight = { high: 0, medium: 1, none: 2, low: 3 };
          return pWeight[a.priority || "none"] - pWeight[b.priority || "none"];
        });

      const done = filteredTasks.filter((t) => t.done).slice(0, 25);

      return {
        mode: "due" as const,
        overdue,
        upcoming,
        noDue,
        done,
      };
    }

    const createdTasks = [...open].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const done = filteredTasks.filter((t) => t.done).slice(0, 25);

    return {
      mode: "created" as const,
      createdTasks,
      done,
    };
  }, [filteredTasks, now, sortBy]);

  const setSetting = <K extends keyof DB["settings"]>(k: K, v: DB["settings"][K]) =>
    update((prev) => ({ ...prev, settings: { ...prev.settings, [k]: v } }));

  const activeTasksCount = db.tasks.filter((t) => !t.deletedAt).length;
  const openCount = filteredTasks.filter((t) => !t.done).length;

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col gap-4 px-4 pt-[calc(1rem+env(safe-area-inset-top,0px))] pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] sm:py-10">
      <Header
        db={db}
        lang={lang}
        dueCount={due}
        showInput={showInput}
        showSearch={showSearch}
        onToggleInput={toggleInput}
        onToggleSearch={toggleSearch}
        onReplace={setDb}
        onUpdateMemory={(aiMemory) => update((prev) => ({ ...prev, aiMemory }))}
        onUpdateSetting={setSetting}
        onClearDone={clearDone}
        onSaveReport={(date, text) => {
          const nowIso = new Date().toISOString();
          update((prev) => {
            const rest = prev.reports.filter((r) => r.date !== date);
            if (!text) {
              const old = prev.reports.find((r) => r.date === date);
              return {
                ...prev,
                reports: old ? [...rest, { ...old, deletedAt: nowIso, updatedAt: nowIso }] : rest,
              };
            }
            return {
              ...prev,
              reports: [...rest, { date, text, updatedAt: nowIso, deletedAt: null }],
            };
          });
        }}
        onMessage={showToast}
      />

      {/* Quick Add Input Bar */}
      {showInput && <QuickAdd onAdd={addTask} existingTags={allTags} lang={lang} />}

      {/* Fuzzy Search Bar */}
      {showSearch && (
        <SearchBar
          query={searchQuery}
          onChange={setSearchQuery}
          onClose={() => {
            setShowSearch(false);
            setSearchQuery("");
            try {
              localStorage.setItem("daily.showSearch", "false");
            } catch {}
          }}
          lang={lang}
          resultsCount={searchQuery.trim() ? filteredTasks.length : undefined}
        />
      )}

      {/* Category / Group Filter Pills */}
      <CategoryFilter
        activeCategory={selectedCategory}
        tasks={db.tasks}
        lang={lang}
        onSelectCategory={setSelectedCategory}
      />

      {/* Pinned Focus Notes */}
      <Notes
        notes={db.notes.filter((n) => !n.deletedAt)}
        lang={lang}
        onAdd={(text) => {
          const nowIso = new Date().toISOString();
          update((prev) => ({
            ...prev,
            notes: [
              ...prev.notes,
              { id: uid(), text, createdAt: nowIso, updatedAt: nowIso, deletedAt: null },
            ],
          }));
        }}
        onRemove={(id) => {
          const nowIso = new Date().toISOString();
          update((prev) => ({
            ...prev,
            notes: prev.notes.map((n) =>
              n.id === id ? { ...n, deletedAt: nowIso, updatedAt: nowIso } : n,
            ),
          }));
        }}
      />

      <main className="flex-1 space-y-6">
        {activeTasksCount > 0 && (
          <div className="flex items-center justify-between px-1">
            <span className="text-xs font-medium text-zinc-400">
              {searchQuery.trim() ? t.searchResultsCount(openCount) : t.openTasksCount(openCount)}
            </span>
            <div className="flex items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-900/90 p-1 text-xs shadow-xs">
              {sortOptions.map((opt) => {
                const active = sortBy === opt.id;
                const Icon = opt.icon;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleSetSortBy(opt.id)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer",
                      active
                        ? "bg-zinc-800 text-zinc-100 shadow-xs border border-zinc-700/60"
                        : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40",
                    )}
                  >
                    <Icon className={cn("size-3.5", active ? opt.iconColor : "text-zinc-500")} />
                    <span>{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Priority Groups */}
        {groups.mode === "priority" && (
          <>
            <Group
              title={t.groupUrgent}
              icon={<Flame className="size-4 text-red-500 fill-red-500/20" />}
              tasks={groups.highPriority}
              alert
              lang={lang}
              existingTags={allTags}
              onSnooze={snooze}
              onSelectTag={setSelectedCategory}
              updateTask={updateTask}
              {...{ toggle, remove, rename }}
            />
            <Group
              title={t.groupRegular}
              icon={<CheckSquare className="size-4 text-zinc-400" />}
              tasks={groups.regularTasks}
              lang={lang}
              existingTags={allTags}
              onSnooze={snooze}
              onSelectTag={setSelectedCategory}
              updateTask={updateTask}
              {...{ toggle, remove, rename }}
            />
          </>
        )}

        {/* Due Date Groups */}
        {groups.mode === "due" && (
          <>
            <Group
              title={t.groupOverdue}
              icon={<AlertCircle className="size-4 text-red-500" />}
              tasks={groups.overdue}
              alert
              lang={lang}
              existingTags={allTags}
              onSnooze={snooze}
              onSelectTag={setSelectedCategory}
              updateTask={updateTask}
              {...{ toggle, remove, rename }}
            />
            <Group
              title={t.groupUpcoming}
              icon={<Calendar className="size-4 text-emerald-400" />}
              tasks={groups.upcoming}
              lang={lang}
              existingTags={allTags}
              onSnooze={snooze}
              onSelectTag={setSelectedCategory}
              updateTask={updateTask}
              {...{ toggle, remove, rename }}
            />
            <Group
              title={t.groupNoDue}
              icon={<Clock className="size-4 text-zinc-400" />}
              tasks={groups.noDue}
              lang={lang}
              existingTags={allTags}
              onSnooze={snooze}
              onSelectTag={setSelectedCategory}
              updateTask={updateTask}
              {...{ toggle, remove, rename }}
            />
          </>
        )}

        {/* Created Date Groups */}
        {groups.mode === "created" && (
          <Group
            title={t.groupCreated}
            icon={<Sparkles className="size-4 text-sky-400" />}
            tasks={groups.createdTasks}
            lang={lang}
            existingTags={allTags}
            onSnooze={snooze}
            onSelectTag={setSelectedCategory}
            updateTask={updateTask}
            {...{ toggle, remove, rename }}
          />
        )}

        {/* Completed Group */}
        <Group
          title={t.groupDone}
          icon={<CheckCircle2 className="size-4 text-emerald-400" />}
          tasks={groups.done}
          lang={lang}
          existingTags={allTags}
          onSelectTag={setSelectedCategory}
          updateTask={updateTask}
          {...{ toggle, remove, rename }}
        />

        {/* Empty States */}
        {activeTasksCount > 0 && filteredTasks.length === 0 && (
          <div className="pt-10 text-center space-y-2">
            <SearchX className="size-8 text-zinc-600 mx-auto" />
            <p className="text-sm font-medium text-zinc-400">{t.searchNoResults}</p>
            {selectedCategory && (
              <button
                type="button"
                onClick={() => setSelectedCategory(null)}
                className="text-xs text-amber-400 underline cursor-pointer"
              >
                نمایش همه دسته‌بندی‌ها
              </button>
            )}
          </div>
        )}

        {activeTasksCount === 0 && (
          <p className="pt-10 text-center text-sm text-zinc-500">{t.emptyTasksMsg}</p>
        )}
      </main>

      {toast && (
        <div className="fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom,0px))] left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-zinc-700 bg-zinc-900/95 px-4 py-2.5 text-sm font-medium text-zinc-100 shadow-2xl backdrop-blur-md">
          <span>{toast.text}</span>
          {toast.undo && (
            <button
              type="button"
              className="font-semibold text-amber-400 underline underline-offset-2 hover:text-amber-300 cursor-pointer"
              onClick={() => {
                toast.undo?.();
                setToast(null);
              }}
            >
              {t.undo}
            </button>
          )}
        </div>
      )}

      {/* In-app native auto updater dialog */}
      <UpdateDialog lang={lang} />

      {/* Fullscreen Alarm Ringing Modal with Continuous Loop & Snooze */}
      <AlarmModal
        tasks={ringingTasks}
        lang={lang}
        soundEnabled={db.settings.sound}
        soundTheme={db.settings.alarmTheme || "marimba"}
        onDismiss={dismissAlarm}
        onDone={(id) => toggle(id)}
        onSnooze={snooze}
      />
    </div>
  );
}

function Group({
  title,
  icon,
  tasks,
  alert,
  lang,
  existingTags,
  toggle,
  remove,
  rename,
  updateTask,
  onSnooze,
  onSelectTag,
}: {
  title: string;
  icon?: React.ReactNode;
  tasks: Task[];
  alert?: boolean;
  lang: Language;
  existingTags?: string[];
  toggle: (id: string, event?: React.MouseEvent) => void;
  remove: (id: string) => void;
  rename: (id: string, title: string, description?: string | null) => void;
  updateTask?: (id: string, updates: Partial<Omit<Task, "id" | "createdAt">>) => void;
  onSnooze?: (id: string, preset: SnoozePreset) => void;
  onSelectTag?: (tag: string) => void;
}) {
  if (tasks.length === 0) return null;
  return (
    <section>
      <h2
        className={cn(
          "mb-2 flex items-center justify-between px-2 text-xs font-semibold text-zinc-400",
          alert && "text-red-400 font-bold",
        )}
      >
        <span className="flex items-center gap-1.5">
          {icon}
          <span>{title}</span>
        </span>
        <span
          className={cn(
            "rounded-full bg-zinc-800/80 px-2 py-0.5 text-[11px] font-mono text-zinc-300",
            alert && "border border-red-800/50 bg-red-950/80 text-red-300",
          )}
        >
          {tasks.length}
        </span>
      </h2>
      <div className="space-y-1.5">
        {tasks.map((t) => (
          <TaskItem
            key={t.id}
            task={t}
            lang={lang}
            existingTags={existingTags}
            onToggle={toggle}
            onDelete={remove}
            onRename={rename}
            onUpdate={updateTask}
            onSnooze={onSnooze}
            onSelectTag={onSelectTag}
          />
        ))}
      </div>
    </section>
  );
}
