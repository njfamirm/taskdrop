import type { DB, Note, Report, Task } from "@/lib/types.ts";

const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // Retain deletion tombstones for 30 days

function getTaskTime(t: Task): number {
  const dateStr = t.updatedAt || t.doneAt || t.createdAt;
  const time = new Date(dateStr).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function getNoteTime(n: Note): number {
  const dateStr = n.updatedAt || n.createdAt;
  const time = new Date(dateStr).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Conflict-Free Last-Write-Wins (LWW) database merge engine with tombstones
 */
export function mergeDBs(local: DB, incoming: DB): DB {
  const now = Date.now();
  const taskMap = new Map<string, Task>();

  // 1. Index local tasks
  for (const t of local.tasks) {
    taskMap.set(t.id, t);
  }

  // Merge incoming tasks
  for (const inTask of incoming.tasks) {
    const locTask = taskMap.get(inTask.id);
    if (!locTask) {
      taskMap.set(inTask.id, inTask);
    } else {
      const locTime = getTaskTime(locTask);
      const inTime = getTaskTime(inTask);

      if (inTime > locTime) {
        taskMap.set(inTask.id, inTask);
      } else if (locTime > inTime) {
        taskMap.set(locTask.id, locTask);
      } else {
        const deletedAt = inTask.deletedAt || locTask.deletedAt || null;
        taskMap.set(inTask.id, {
          ...inTask,
          description: inTask.description ?? locTask.description,
          tags: Array.from(new Set([...(locTask.tags || []), ...(inTask.tags || [])])),
          deletedAt,
        });
      }
    }
  }

  // Carry over "already rang" state so an alarm fired on one device doesn't ring again on another
  for (const inTask of incoming.tasks) {
    const locTask = local.tasks.find((t) => t.id === inTask.id);
    const winner = taskMap.get(inTask.id);
    if (!locTask || !winner || locTask.due !== inTask.due) continue;
    const best = [locTask.notifiedAt, inTask.notifiedAt]
      .filter((x): x is string => !!x)
      .sort()
      .pop();
    if (best && best !== winner.notifiedAt) taskMap.set(winner.id, { ...winner, notifiedAt: best });
  }

  // Clean up expired tombstones (> 30 days)
  const mergedTasks: Task[] = [];
  for (const t of taskMap.values()) {
    if (t.deletedAt) {
      const delTime = new Date(t.deletedAt).getTime();
      if (now - delTime < TOMBSTONE_RETENTION_MS) {
        mergedTasks.push(t);
      }
    } else {
      mergedTasks.push(t);
    }
  }

  // 2. Merge pinned focus notes
  const noteMap = new Map<string, Note>();
  for (const n of local.notes) {
    noteMap.set(n.id, n);
  }
  for (const inNote of incoming.notes) {
    const locNote = noteMap.get(inNote.id);
    if (!locNote) {
      noteMap.set(inNote.id, inNote);
    } else {
      const locTime = getNoteTime(locNote);
      const inTime = getNoteTime(inNote);
      if (inTime >= locTime) {
        noteMap.set(inNote.id, inNote);
      } else {
        noteMap.set(locNote.id, locNote);
      }
    }
  }

  const mergedNotes: Note[] = [];
  for (const n of noteMap.values()) {
    if (n.deletedAt) {
      const delTime = new Date(n.deletedAt).getTime();
      if (now - delTime < TOMBSTONE_RETENTION_MS) {
        mergedNotes.push(n);
      }
    } else {
      mergedNotes.push(n);
    }
  }

  // 3. Merge daily reports (one per day, last write wins)
  const reportMap = new Map<string, Report>();
  for (const r of local.reports ?? []) reportMap.set(r.date, r);
  for (const inReport of incoming.reports ?? []) {
    const locReport = reportMap.get(inReport.date);
    if (
      !locReport ||
      new Date(inReport.updatedAt).getTime() >= new Date(locReport.updatedAt).getTime()
    ) {
      reportMap.set(inReport.date, inReport);
    }
  }
  const mergedReports = Array.from(reportMap.values()).filter(
    (r) => !r.deletedAt || now - new Date(r.deletedAt).getTime() < TOMBSTONE_RETENTION_MS,
  );

  // 4. AI Memory merge
  let mergedMemory = (local.aiMemory || "").trim();
  const incomingMemory = (incoming.aiMemory || "").trim();
  if (!mergedMemory && incomingMemory) {
    mergedMemory = incomingMemory;
  } else if (incomingMemory && mergedMemory !== incomingMemory) {
    mergedMemory = incomingMemory;
  }

  return {
    version: 1,
    settings: {
      ...local.settings,
      ...incoming.settings,
    },
    aiMemory: mergedMemory,
    notes: mergedNotes,
    reports: mergedReports,
    tasks: mergedTasks,
    lastModified: new Date().toISOString(),
  };
}
