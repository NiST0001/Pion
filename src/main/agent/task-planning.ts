import { app } from 'electron'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

let extensionReady = false

/**
 * Materialize Pion's native, session-persistent task tool as an explicit CLI
 * extension. It is bundled by Pion and does not depend on rpiv-todo or any
 * package in the user's Pi settings.
 */
export async function ensureNativeTaskExtension(): Promise<string> {
  const runtimeDir = join(app.getPath('userData'), 'runtime')
  const path = join(runtimeDir, 'pion-native-task-extension.ts')
  const legacyPolicyPath = join(runtimeDir, 'pion-task-planning-extension.ts')
  if (extensionReady) return path

  const source = nativeTaskExtensionSource()
  await mkdir(dirname(path), { recursive: true })
  try {
    if (await readFile(path, 'utf8') === source) {
      await unlink(legacyPolicyPath).catch(() => undefined)
      extensionReady = true
      return path
    }
  } catch {
    // Missing/stale runtime extension is written below.
  }
  await writeFile(path, source, 'utf8')
  await unlink(legacyPolicyPath).catch(() => undefined)
  extensionReady = true
  return path
}

/** Exported for source-level regression tests without loading Electron. */
export function nativeTaskExtensionSource(): string {
  return String.raw`import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const TOOL_NAME = "pion_task";
const ACTIONS = ["clear", "create", "update", "delete", "list", "get"];
const STATUSES = ["pending", "in_progress", "completed", "deleted"];
const POLICY = [
  "## Pion native task continuity policy",
  "- Use pion_task as the only task-management tool. Never call todo or rely on an external todo plugin.",
  "- Decide whether to continue, revise, or replace the existing plan from the user's goal and the current session branch's tasks. A new user message is not a plan reset.",
  "- For follow-ups, corrections, or requests to continue the same goal, reuse task ids, completed progress, and dependencies; update or append tasks as needed. Use list/get when the existing task state is unclear.",
  "- Use clear only when you decide a genuinely different goal needs a replacement plan or the user asks to discard/reset it. Before replacing unfinished work, explain what is being set aside; ask if the user's intent is consequentially ambiguous. Do not silently lose unfinished work.",
  "- Trivial questions and conversational turns do not require a new plan and must not clear an existing one. Do not resume unrelated work merely because it remains on the list.",
  "- Choose task count and granularity from the actual work: independently executable, verifiable steps with dependencies where useful.",
  "- Mark a task in_progress before working on it and completed only after its completion criteria are met. Keep exactly one task in_progress while working; pause it to pending before switching tasks.",
  "- A plan may span multiple user messages. Preserve unfinished tasks and report progress, blockers, and next steps honestly; do not mark work completed or clear it merely to end a response. Task state is not authorization to bypass tool permissions or user approval.",
  "- Pion archives snapshots from the transcript; archived history does not replace the active plan needed to continue the same goal."
].join("\n");

const Params = Type.Object({
  action: StringEnum(ACTIONS),
  id: Type.Optional(Type.Number({ description: "Task id for update, delete, or get" })),
  subject: Type.Optional(Type.String({ description: "Short imperative task title" })),
  description: Type.Optional(Type.String({ description: "Optional task details" })),
  activeForm: Type.Optional(Type.String({ description: "Present-continuous label while in progress" })),
  status: Type.Optional(StringEnum(STATUSES)),
  blockedBy: Type.Optional(Type.Array(Type.Number())),
  addBlockedBy: Type.Optional(Type.Array(Type.Number())),
  removeBlockedBy: Type.Optional(Type.Array(Type.Number())),
  includeDeleted: Type.Optional(Type.Boolean()),
});

let tasks = [];
let nextId = 1;

function snapshot() {
  return tasks.map((task) => ({ ...task, blockedBy: [...(task.blockedBy || [])] }));
}

function restoredSnapshot(details) {
  if (!details || !Array.isArray(details.tasks)) return undefined;
  for (const task of details.tasks) {
    if (!task || (typeof task.id !== "number" && typeof task.id !== "string")
      || (typeof task.id === "number" && !Number.isFinite(task.id))
      || typeof task.subject !== "string"
      || (task.status !== undefined && !STATUSES.includes(task.status))
      || (task.description !== undefined && typeof task.description !== "string")
      || (task.activeForm !== undefined && typeof task.activeForm !== "string")
      || (task.blockedBy !== undefined && (!Array.isArray(task.blockedBy) || !task.blockedBy.every(Number.isFinite)))) return undefined;
  }
  const restored = details.tasks.map((task) => ({
    id: task.id, subject: task.subject, description: task.description,
    activeForm: task.activeForm, status: task.status || "pending",
    blockedBy: [...(task.blockedBy || [])],
  }));
  const minimumId = restored.reduce((max, task) => Math.max(max, Number(task.id) || 0), 0) + 1;
  if (details.nextId !== undefined && (!Number.isSafeInteger(details.nextId) || details.nextId < minimumId)) return undefined;
  return { tasks: restored, nextId: details.nextId === undefined ? minimumId : details.nextId };
}

function restore(ctx) {
  tasks = [];
  nextId = 1;
  for (const entry of ctx.sessionManager.getBranch()) {
    let details;
    if (entry.type === "custom" && entry.customType === "pion-task-state" && entry.data?.native === "pion") {
      details = entry.data;
    } else if (entry.type === "message") {
      const message = entry.message;
      if (message.role !== "toolResult" || ![TOOL_NAME, "todo"].includes(message.toolName) || message.isError) continue;
      details = message.details;
    }
    const restored = restoredSnapshot(details);
    if (!restored) continue;
    tasks = restored.tasks;
    nextId = restored.nextId;
  }
}

function requireId(params) {
  if (!Number.isFinite(params.id)) throw new Error("pion_task requires a numeric id for " + params.action);
  const task = tasks.find((candidate) => candidate.id === params.id);
  if (!task) throw new Error("pion_task #" + params.id + " was not found");
  return task;
}

function assertSingleActive(id) {
  const active = tasks.find((task) => task.status === "in_progress" && task.id !== id);
  if (active) throw new Error("pion_task #" + active.id + " is already in_progress; complete or pause it first");
}

function response(action, text) {
  return {
    content: [{ type: "text", text }],
    details: { action, tasks: snapshot(), nextId, native: "pion" },
  };
}

function formatTasks(list) {
  if (list.length === 0) return "No Pion tasks";
  return list.map((task) => {
    const mark = task.status === "completed" ? "✓" : task.status === "in_progress" ? "◐" : task.status === "deleted" ? "×" : "○";
    return mark + " #" + task.id + " [" + task.status + "] " + task.subject;
  }).join("\n");
}

export default function (pi) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Pion Tasks",
    description: "Native Pion task planning. Actions: clear, create, update, delete, list, get. Status: pending, in_progress, completed, deleted.",
    promptSnippet: "Manage multi-step plans across messages; decide whether to continue, revise, or replace existing tasks",
    promptGuidelines: [
      "Use pion_task when the work benefits from a tracked plan; choose independently verifiable tasks based on the actual work.",
      "Inspect existing tasks when needed. Continue or revise the same goal across user messages; clear only for a deliberate plan replacement or requested reset, not on every message.",
      "Keep exactly one task in_progress while working. Complete only finished work; preserve unfinished tasks and explain blockers or pauses without bypassing user approval."
    ],
    parameters: Params,
    async execute(_toolCallId, params) {
      // appendEntry uses this runtime's current session branch. Mutations commit
      // before returning, even when invoked inside a script with no toolResult.
      const before = { tasks: snapshot(), nextId };
      const finish = (action, text) => {
        const result = response(action, text);
        if (["clear", "create", "update", "delete"].includes(action)) {
          try {
            pi.appendEntry("pion-task-state", result.details);
          } catch (error) {
            tasks = before.tasks;
            nextId = before.nextId;
            throw error;
          }
        }
        return result;
      };
      if (params.action === "clear") {
        const count = tasks.length;
        tasks = [];
        nextId = 1;
        return finish("clear", "Cleared " + count + " Pion task(s)");
      }

      if (params.action === "create") {
        const subject = String(params.subject || "").trim();
        if (!subject) throw new Error("pion_task create requires subject");
        const status = params.status || "pending";
        if (status === "in_progress") assertSingleActive(-1);
        const task = {
          id: nextId++,
          subject,
          description: typeof params.description === "string" ? params.description : undefined,
          activeForm: typeof params.activeForm === "string" ? params.activeForm : undefined,
          status,
          blockedBy: Array.isArray(params.blockedBy) ? [...new Set(params.blockedBy)] : [],
        };
        tasks.push(task);
        return finish("create", "Created Pion task #" + task.id + ": " + task.subject);
      }

      if (params.action === "update") {
        const task = requireId(params);
        if (params.status === "in_progress") assertSingleActive(task.id);
        const updated = { ...task, blockedBy: [...(task.blockedBy || [])] };
        if (typeof params.subject === "string" && params.subject.trim()) updated.subject = params.subject.trim();
        if (typeof params.description === "string") updated.description = params.description;
        if (typeof params.activeForm === "string") updated.activeForm = params.activeForm;
        if (params.status) updated.status = params.status;
        let blockedBy = Array.isArray(params.blockedBy) ? [...new Set(params.blockedBy)] : updated.blockedBy;
        if (Array.isArray(params.addBlockedBy)) blockedBy = [...new Set([...blockedBy, ...params.addBlockedBy])];
        if (Array.isArray(params.removeBlockedBy)) {
          const removed = new Set(params.removeBlockedBy);
          blockedBy = blockedBy.filter((id) => !removed.has(id));
        }
        if (blockedBy.includes(task.id)) throw new Error("A Pion task cannot block itself");
        updated.blockedBy = blockedBy;
        Object.assign(task, updated);
        return finish("update", "Updated Pion task #" + task.id + " to " + task.status);
      }

      if (params.action === "delete") {
        const task = requireId(params);
        task.status = "deleted";
        return finish("delete", "Deleted Pion task #" + task.id);
      }

      if (params.action === "get") {
        const task = requireId(params);
        return response("get", formatTasks([task]));
      }

      const visible = tasks.filter((task) => {
        if (!params.includeDeleted && task.status === "deleted") return false;
        return !params.status || task.status === params.status;
      });
      return response("list", formatTasks(visible));
    },
  });

  const ensureToolActive = () => {
    const active = pi.getActiveTools();
    const desired = [...new Set([...active.filter((name) => name !== "todo"), TOOL_NAME])];
    if (desired.length !== active.length || desired.some((name, index) => name !== active[index])) {
      pi.setActiveTools(desired);
    }
  };

  function planModeEnabled(ctx) {
    let enabled = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "plan-mode-state") continue;
      enabled = entry.data?.enabled === true;
    }
    return enabled;
  }

  pi.on("session_start", async (_event, ctx) => {
    // Pion's plan extension is loaded before this extension. Do not re-add
    // pion_task after plan mode has reduced the active tools to read-only ones.
    if (!planModeEnabled(ctx)) ensureToolActive();
    restore(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  pi.on("session_compact", async (_event, ctx) => restore(ctx));
  pi.on("before_agent_start", async (event) => {
    const tools = event.systemPromptOptions && event.systemPromptOptions.selectedTools;
    if (Array.isArray(tools) && !tools.includes(TOOL_NAME)) return undefined;
    return { systemPrompt: event.systemPrompt + "\n\n" + POLICY };
  });
}
`;
}
