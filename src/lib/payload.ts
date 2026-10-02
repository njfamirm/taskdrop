import type { DB } from "@/lib/types.ts";

const SPEC = `# TaskDrop — Complete State Payload

You are an AI executive assistant and structured data editor. Below is the full state of "TaskDrop".
TaskDrop is a fast, frictionless task and commitment management canvas designed for quick brain dumping and reliable execution, not heavyweight corporate project management.
Tasks have optional due dates and priorities; the app alerts the user when a deadline is due.

## Critical Instructions & Rules
1. **Task Title (\`title\`):** Keep task titles concise, punchy, and action-oriented (3 to 7 words).
2. **Task Description (\`description\`):**
   - For open tasks: Only add a \`description\` if essential technical details, sub-notes, or links are needed; otherwise keep it \`null\`.
   - **For completed tasks (\`done: true\`):** You may include a 1-2 sentence completion summary in \`description\` documenting the result.
3. **Priorities:**
   - Use \`"priority": "high"\` for urgent, high-impact tasks.
   - Use \`"priority": "medium"\`, \`"low"\`, or \`"none"\` for standard tasks.
4. **Return ONLY a single valid JSON block** containing the updated DB object, with no markdown conversation or greetings outside the json fence.
5. Preserve existing \`id\`s. For new tasks or notes, generate a random unique 8-character string.
6. \`due\` is an ISO 8601 string with local timezone offset (e.g. "2026-09-28T10:00:00+03:30"), or \`null\` if no deadline.
7. \`repeat\`: One of "none" | "daily" | "weekly" | "monthly".
8. \`priority\`: One of "none" | "low" | "medium" | "high".
9. \`notes\` are pinned focus notes displayed at the top of the canvas. \`reports\` are the user's own daily written reports (one per date); preserve them as-is.
10. \`aiMemory\` contains the user's persistent preferences and directives for you; always respect it unless explicitly asked to modify it.
11. \`done: true\` marks a task as completed.
12. **Scoped Tags & Organization (\`tags\`):** You may use structured scoped tags with \`key:value\` syntax (e.g. \`"حوزه:کار"\`, \`"حوزه:شخصی"\`, \`"نوع:روتین"\`, \`"پروژه:..."\`) based on the user's context and existing taxonomy. Maintain existing categories and scopes consistently.

## Task Schema
{ "id": string, "title": string, "description": string|null, "due": string|null, "repeat": "none"|"daily"|"weekly"|"monthly",
  "priority": "none"|"low"|"medium"|"high", "done": boolean, "createdAt": string,
  "doneAt": string|null, "notifiedAt": string|null, "tags": string[] }

## Note Schema
{ "id": string, "text": string, "createdAt": string }

## Report Schema
{ "date": "YYYY-MM-DD", "text": string, "updatedAt": string }

## Database Schema
{ "version": 1, "settings": { "sound": boolean, "notifications": boolean, "checkIntervalSec": number, "leadMinutes": number, "theme": "dark"|"light"|"auto", "language": "fa"|"en" }, "aiMemory": string, "notes": Note[], "reports": Report[], "tasks": Task[] }
`;

function localISO(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`
  );
}

/** Builds the full AI-ready payload string: specifications + memory + current time + database snapshot */
export function buildPayload(db: DB): string {
  const now = new Date();
  const isFa = db.settings.language === "fa";
  const weekday = now.toLocaleDateString(isFa ? "fa-IR" : "en-US", { weekday: "long" });
  const memorySection = db.aiMemory?.trim()
    ? `\n## User's Persistent Directives & Memory:\n${db.aiMemory.trim()}\n`
    : "";

  const cleanDb: DB = {
    version: 1,
    settings: db.settings,
    aiMemory: db.aiMemory,
    notes: db.notes.filter((n) => !n.deletedAt),
    reports: db.reports.filter((r) => !r.deletedAt),
    tasks: db.tasks.filter((t) => !t.deletedAt),
  };

  return `${SPEC}${memorySection}\n## Current Time\n${localISO(now)} (${weekday}) — Timezone: ${
    Intl.DateTimeFormat().resolvedOptions().timeZone
  }\n\n## Database State\n\`\`\`json\n${JSON.stringify(cleanDb, null, 2)}\n\`\`\`\n`;
}
