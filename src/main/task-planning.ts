import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

let extensionReady = false

/**
 * Materialize Pion's per-user-message todo policy as a CLI extension.
 *
 * CLI extensions load independently of project trust, so the same task-cycle
 * semantics apply to every retained backend without modifying the user's
 * global rpiv-todo configuration.
 */
export async function ensureTaskPlanningExtension(): Promise<string> {
  const path = join(app.getPath('userData'), 'runtime', 'pion-task-planning-extension.ts')
  if (extensionReady) return path

  const source = taskPlanningExtensionSource()
  await mkdir(dirname(path), { recursive: true })
  try {
    if (await readFile(path, 'utf8') === source) {
      extensionReady = true
      return path
    }
  } catch {
    // Missing/stale runtime extension is written below.
  }
  await writeFile(path, source, 'utf8')
  extensionReady = true
  return path
}

function taskPlanningExtensionSource(): string {
  return String.raw`const POLICY = [
  "## Pion turn-scoped task policy",
  "- Scope todo tasks to the current user message only; never maintain a session-wide backlog.",
  "- For a complex turn that needs todo, call todo clear exactly once before creating the current turn's tasks. Do not call todo for trivial or conversational turns.",
  "- Create a fresh plan from the current user message. Do not reuse task ids or carry pending/completed tasks from an earlier user message into this turn.",
  "- Mark each current-turn task in_progress before work and completed immediately when done. Finish all unblocked current-turn tasks before the final response.",
  "- If blocked, keep the affected task in_progress and explain the blocker in the same response; never silently roll it into a later user turn.",
  "- Pion archives task snapshots from the transcript, so completed tasks do not need to remain an active backlog."
].join("\n");

export default function (pi) {
  pi.on("before_agent_start", async (event) => {
    const tools = event.systemPromptOptions && event.systemPromptOptions.selectedTools;
    if (Array.isArray(tools) && !tools.includes("todo")) return undefined;
    return { systemPrompt: event.systemPrompt + "\n\n" + POLICY };
  });
}
`
}
