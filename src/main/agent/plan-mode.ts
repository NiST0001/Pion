import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

let extensionReady = false

/** Materialize Pion's first-party read-only plan-mode extension. */
export async function ensureNativePlanModeExtension(): Promise<string> {
  const path = join(app.getPath('userData'), 'runtime', 'pion-plan-mode-extension.ts')
  if (extensionReady) return path

  const source = nativePlanModeExtensionSource()
  await mkdir(dirname(path), { recursive: true })
  try {
    if (await readFile(path, 'utf8') === source) {
      extensionReady = true
      return path
    }
  } catch {
    // Missing or stale runtime extension is written below.
  }
  await writeFile(path, source, 'utf8')
  extensionReady = true
  return path
}

/** Exported for source-level regression tests without loading Electron. */
export function nativePlanModeExtensionSource(): string {
  return String.raw`const STATE_ENTRY_TYPE = "plan-mode-state";
const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"];
const DEFAULT_NORMAL_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell", "pion_task", "pion_ask_user"];
const PLAN_COMMANDS = [
  { value: "start", label: "start", description: "进入只读计划模式" },
  { value: "exit", label: "exit", description: "退出计划模式并恢复构建工具" },
  { value: "off", label: "off", description: "退出计划模式并恢复构建工具" },
];
const PLAN_PROMPT = [
  "[PION PLAN MODE]",
  "你现在处于 Pion 计划模式，这是只读的资料收集与任务规划阶段。",
  "规则：",
  "- 严禁修改、创建、删除、移动或覆盖任何文件。",
  "- 严禁执行 bash、PowerShell、终端、安装、提交、迁移或其他可能产生副作用的操作。",
  "- 不要调用 pion_task，也不要把计划转换为 Pion 任务；计划只写在你的回复中。",
  "- 只能使用当前可见的只读资料工具收集信息；关键歧义可用 pion_ask_user 向用户提问。",
  "- 输出现状、发现、风险和分步骤执行方案，然后停止等待用户确认。",
  "- 只有用户明确切换回构建模式并发送执行请求后，才可以开始实际修改。",
].join("\n");

export default function (pi) {
  let enabled = false;
  let toolsBeforePlanMode;
  let persistedState = JSON.stringify(stateSnapshot());

  function stateSnapshot() {
    return { version: 1, enabled, toolsBeforePlanMode };
  }

  function availableToolNames() {
    return new Set(pi.getAllTools().map((tool) => tool.name));
  }

  function isReadOnlyBuiltInTool(name) {
    const tool = pi.getAllTools().find((candidate) => candidate.name === name);
    if (name === "pion_ask_user") return tool?.sourceInfo?.source === "sdk";
    return READ_ONLY_TOOL_NAMES.includes(name) && tool?.sourceInfo?.source === "builtin";
  }

  function readOnlyTools() {
    return [...READ_ONLY_TOOL_NAMES, "pion_ask_user"].filter((name) => isReadOnlyBuiltInTool(name));
  }

  function normalTools() {
    const available = availableToolNames();
    return DEFAULT_NORMAL_TOOL_NAMES.filter((name) => available.has(name));
  }

  function enableTools() {
    if (toolsBeforePlanMode === undefined) toolsBeforePlanMode = pi.getActiveTools();
    pi.setActiveTools(readOnlyTools());
  }

  function restoreTools() {
    const previous = toolsBeforePlanMode;
    toolsBeforePlanMode = undefined;
    const restored = previous && previous.length > 0 ? previous : normalTools();
    const nativeAsk = isReadOnlyBuiltInTool("pion_ask_user") ? ["pion_ask_user"] : [];
    pi.setActiveTools([...new Set([...restored, ...nativeAsk])]);
  }

  function persist() {
    const state = stateSnapshot();
    const serialized = JSON.stringify(state);
    if (serialized === persistedState) return;
    pi.appendEntry(STATE_ENTRY_TYPE, state);
    // Only a successful append becomes the baseline; shutdown can retry a
    // changed state whose earlier append failed.
    persistedState = serialized;
  }

  function restore(ctx) {
    const wasEnabled = enabled;
    let restored;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
      restored = entry.data;
    }
    enabled = restored?.enabled === true;
    toolsBeforePlanMode = Array.isArray(restored?.toolsBeforePlanMode)
      ? restored.toolsBeforePlanMode.filter((name) => typeof name === "string")
      : undefined;
    // The selected branch is the saved baseline, not the previous session.
    // Capture it before enable/restoreTools can capture or clear saved tools.
    persistedState = JSON.stringify(stateSnapshot());
    if (enabled) enableTools();
    else if (wasEnabled || toolsBeforePlanMode !== undefined) restoreTools();
  }

  function setMode(nextEnabled, ctx) {
    if (enabled === nextEnabled) {
      ctx.ui.notify(nextEnabled ? "计划模式已经开启。" : "当前已经是构建模式。", "info");
      return;
    }
    enabled = nextEnabled;
    if (enabled) {
      enableTools();
      ctx.ui.notify("计划模式已开启：仅允许只读资料收集，不会调用任务工具或修改文件。", "info");
    } else {
      restoreTools();
      ctx.ui.notify("计划模式已关闭：构建工具已恢复。请确认方案后发送执行请求。", "info");
    }
    persist();
  }

  pi.registerCommand("plan", {
    description: "切换 Pion 只读计划模式，不直接执行实现",
    getArgumentCompletions(prefix) {
      const normalized = prefix.trimStart().toLowerCase();
      const matches = normalized === ""
        ? PLAN_COMMANDS
        : PLAN_COMMANDS.filter((item) => item.value.startsWith(normalized));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const command = (args ?? "").trim().toLowerCase();
      if (command === "start") {
        setMode(true, ctx);
        return;
      }
      if (command === "exit" || command === "off") {
        setMode(false, ctx);
        return;
      }
      if (command !== "") {
        ctx.ui.notify("用法：/plan start 或 /plan exit。计划完成后请退出计划模式，再发送执行请求。", "warning");
        return;
      }
      setMode(!enabled, ctx);
    },
  });

  // Keep the allowlist as an execution-time guard. Active-tool filtering keeps
  // the model from seeing mutating tools, while this gate also blocks tools
  // reactivated by another extension after Plan mode starts.
  pi.on("tool_call", async (event) => {
    if (!enabled || isReadOnlyBuiltInTool(event.toolName)) return;
    return {
      block: true,
      reason: "Pion 计划模式只允许只读资料工具（read/grep/find/ls）和内置提问，已阻止 " + event.toolName + "。请切换到构建模式后再执行。",
    };
  });

  pi.on("before_agent_start", (event) => {
    if (!enabled) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + PLAN_PROMPT };
  });

  pi.on("session_start", async (_event, ctx) => {
    restore(ctx);
    if (enabled) pi.setActiveTools(readOnlyTools());
  });

  pi.on("session_tree", async (_event, ctx) => {
    restore(ctx);
    if (enabled) pi.setActiveTools(readOnlyTools());
  });

  pi.on("session_shutdown", async () => {
    // An unchanged state must not advance the leaf merely because this
    // runtime is stopping (in particular before conversation-only undo).
    persist();
  });
}
`}
