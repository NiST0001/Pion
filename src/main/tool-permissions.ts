import { app } from 'electron'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  ProjectToolPermissionPolicy,
  ToolPermissionCategory,
  ToolPermissionDecision,
  ToolPermissionRules
} from '../shared/types'

export const TOOL_PERMISSION_MARKER = '__PION_TOOL_PERMISSION__:'
/** Marker for the silent checkpoint gate: the extension asks the main process
    to create the run checkpoint before the first write-capable tool runs. */
export const RUN_CHECKPOINT_MARKER = '__PION_RUN_CHECKPOINT__'
export const TOOL_PERMISSION_TIMEOUT_MS = 120_000

export const DEFAULT_TOOL_PERMISSION_RULES: ToolPermissionRules = {
  read: 'allow',
  write: 'allow',
  shell: 'allow',
  network: 'ask',
  external: 'ask'
}

interface ToolPermissionFile {
  version: 1
  projects: Record<string, ToolPermissionRules>
}

const CATEGORIES: ToolPermissionCategory[] = ['read', 'write', 'shell', 'network', 'external']

function canonicalCwd(cwd: string): string {
  const absolute = resolve(cwd)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

/** Worktree sessions inherit the base project's policy (mirrors the gate). */
function projectRootOf(cwd: string): string {
  const canonicalPath = canonicalCwd(cwd)
  const marker = `${sep}.pion-worktrees${sep}`
  const index = canonicalPath.indexOf(marker)
  if (index < 0) return canonicalPath
  const projectName = canonicalPath.slice(index + marker.length).split(sep)[0]
  if (!projectName) return canonicalPath
  return join(canonicalPath.slice(0, index), projectName)
}

function isDecision(value: unknown): value is ToolPermissionDecision {
  return value === 'allow' || value === 'ask' || value === 'deny'
}

function parseRules(value: unknown): ToolPermissionRules | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const rules = { ...DEFAULT_TOOL_PERMISSION_RULES }
  for (const category of CATEGORIES) {
    const decision = record[category]
    if (!isDecision(decision)) return null
    rules[category] = decision
  }
  return rules
}

/** Persistent project-scoped policy consumed by Pion and its global Pi gate extension. */
export class ToolPermissionStore {
  private data: ToolPermissionFile = { version: 1, projects: {} }
  private loaded = false
  private extensionReady = false
  private writeQueue: Promise<void> = Promise.resolve()

  get filePath(): string {
    return join(app.getPath('userData'), 'pion-tool-permissions.json')
  }

  private get extensionPath(): string {
    return join(app.getPath('userData'), 'runtime', 'pion-tool-permission-extension.ts')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return
      const projects = (parsed as { projects?: unknown }).projects
      if (typeof projects !== 'object' || projects === null) return
      const normalized: Record<string, ToolPermissionRules> = {}
      for (const [cwd, value] of Object.entries(projects)) {
        const rules = parseRules(value)
        if (rules) normalized[canonicalCwd(cwd)] = rules
      }
      this.data = { version: 1, projects: normalized }
    } catch {
      // Missing or malformed settings use the safe defaults.
    }
  }

  async ensureExtension(): Promise<string> {
    const path = this.extensionPath
    if (this.extensionReady) return path
    const source = toolPermissionExtensionSource()
    await mkdir(dirname(path), { recursive: true })
    try {
      if (await readFile(path, 'utf8') === source) {
        this.extensionReady = true
        return path
      }
    } catch {
      // Write the generated extension below.
    }
    await writeFile(path, source, 'utf8')
    this.extensionReady = true
    return path
  }

  async getPolicy(cwd: string): Promise<ProjectToolPermissionPolicy> {
    await this.load()
    const normalizedCwd = canonicalCwd(cwd)
    const policyRoot = projectRootOf(cwd)
    const saved = this.data.projects[policyRoot]
      ?? Object.entries(this.data.projects)
        .filter(([key]) => policyRoot === key || policyRoot.startsWith(`${key}${sep}`))
        .sort((left, right) => right[0].length - left[0].length)[0]?.[1]
    return {
      cwd: normalizedCwd,
      source: saved ? 'saved' : 'default',
      rules: { ...(saved ?? DEFAULT_TOOL_PERMISSION_RULES) }
    }
  }

  async setPolicy(
    cwd: string,
    updates: Partial<ToolPermissionRules> | null
  ): Promise<ProjectToolPermissionPolicy> {
    await this.load()
    const normalizedCwd = canonicalCwd(cwd)
    if (updates === null) {
      const { [normalizedCwd]: _removed, ...projects } = this.data.projects
      this.data = { version: 1, projects }
    } else {
      for (const [category, decision] of Object.entries(updates)) {
        if (!CATEGORIES.includes(category as ToolPermissionCategory) || !isDecision(decision)) {
          throw new Error('无效的工具权限设置')
        }
      }
      const current = this.data.projects[normalizedCwd] ?? DEFAULT_TOOL_PERMISSION_RULES
      this.data = {
        version: 1,
        projects: {
          ...this.data.projects,
          [normalizedCwd]: { ...current, ...updates }
        }
      }
    }
    await this.persist()
    return this.getPolicy(normalizedCwd)
  }

  async allowProjectCategories(
    cwd: string,
    categories: ToolPermissionCategory[]
  ): Promise<ProjectToolPermissionPolicy> {
    const updates: Partial<ToolPermissionRules> = {}
    for (const category of categories) updates[category] = 'allow'
    return this.setPolicy(cwd, updates)
  }

  private persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.data, null, 2)}\n`
    const target = this.filePath
    const temp = `${target}.${randomUUID()}.tmp`
    const write = this.writeQueue.then(async () => {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(temp, snapshot, 'utf8')
      await rename(temp, target)
    })
    this.writeQueue = write.catch(() => undefined)
    return write
  }
}

/**
 * Generated as a CLI extension so it loads before project-local resources and
 * gates built-in plus extension tools in every retained RPC backend.
 */
function toolPermissionExtensionSource(): string {
  return String.raw`import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

const MARKER = "__PION_TOOL_PERMISSION__:";
const CHECKPOINT_MARKER = "__PION_RUN_CHECKPOINT__";
const CHECKPOINT_TIMEOUT = 30000;
const CHECKPOINT_READ_ONLY = new Set(["read", "grep", "find", "ls", "pion_task", "pion_ask_user"]);
const TIMEOUT = 120000;
const DEFAULTS = { read: "allow", write: "allow", shell: "allow", network: "ask", external: "ask" };
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const PION_INTERNAL_TOOLS = new Set(["pion_task", "pion_ask_user"]);
const NETWORK_TOOL = /(web|http|fetch|browser|search|crawl|url|download|upload|request|api)/i;
const NETWORK_COMMAND = /(^|[;&|\s])(curl|wget|ssh|scp|sftp|rsync|telnet|nc|ncat|ftp|gh\s+api|git\s+(clone|fetch|pull|push)|npm\s+(install|publish|view)|pnpm\s+(add|install)|yarn\s+(add|install)|pip\s+install|cargo\s+install|docker\s+pull|kubectl\s+)/i;
const DESTRUCTIVE_COMMAND = /(\brm\s+[^\n]*(?:-r|-f|--recursive|--force)|\bsudo\b|\b(?:chmod|chown)\b|\bmkfs\b|\bdd\s+[^\n]*\bof=|\b(?:shutdown|reboot|poweroff)\b|\bgit\s+(?:reset\s+--hard|clean\s+-[^\n]*f|checkout\s+--)|:\s*>\s*\/dev\/sd)/i;
const sessionAllows = new Set();

function canonical(path) {
  const absolute = resolve(path);
  let cursor = absolute;
  const suffix = [];
  while (true) {
    try { return resolve(realpathSync.native(cursor), ...suffix.reverse()); } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return absolute;
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * Worktree sessions live under <projectParent>/.pion-worktrees/<name>/<branch>,
 * outside the project folder. Map them back to the base project so its
 * permission policy and workspace boundary apply instead of the bare defaults.
 */
function projectRootOf(cwd) {
  const canonicalCwd = canonical(cwd);
  const marker = sep + ".pion-worktrees" + sep;
  const index = canonicalCwd.indexOf(marker);
  if (index < 0) return canonicalCwd;
  const projectName = canonicalCwd.slice(index + marker.length).split(sep)[0];
  if (!projectName) return canonicalCwd;
  return resolve(canonicalCwd.slice(0, index), projectName);
}

function readPolicy(cwd) {
  const file = process.env.PION_TOOL_PERMISSION_CONFIG;
  if (!file) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const projects = parsed && parsed.projects ? parsed.projects : {};
    const root = projectRootOf(cwd);
    let saved = projects[root];
    if (!saved) {
      // Longest configured prefix wins (e.g. a home-level allow rule).
      let best = "";
      for (const key of Object.keys(projects)) {
        if ((root === key || root.startsWith(key + sep)) && key.length > best.length) best = key;
      }
      if (best) saved = projects[best];
    }
    if (!saved) return { ...DEFAULTS };
    const rules = { ...DEFAULTS };
    for (const category of Object.keys(DEFAULTS)) {
      if (saved[category] === "allow" || saved[category] === "ask" || saved[category] === "deny") {
        rules[category] = saved[category];
      }
    }
    return rules;
  } catch {
    return { ...DEFAULTS };
  }
}

function clip(value, max = 2400) {
  const text = String(value ?? "");
  return text.length <= max ? text : text.slice(0, max) + "\n…";
}

function safeJson(value) {
  try { return clip(JSON.stringify(value, null, 2)); } catch { return clip(value); }
}

function toolPath(input, cwd) {
  const raw = input && typeof input.path === "string" ? input.path.replace(/^@/, "") : "";
  return raw ? resolve(cwd, raw) : undefined;
}

function isWithin(root, target) {
  return target === root || target.startsWith(root + sep);
}

function isSensitivePath(path) {
  if (!path) return false;
  const canonicalPath = canonical(path);
  const controlFile = process.env.PION_TOOL_PERMISSION_CONFIG;
  if (controlFile && isWithin(canonical(resolve(controlFile, "..")), canonicalPath)) return true;
  const normalized = canonicalPath.split(sep).join("/").toLowerCase();
  const name = basename(normalized);
  return name === ".env" || name.startsWith(".env.") || name === ".npmrc" || name === ".netrc" || name === ".git-credentials" || normalized.includes("/.git/") || normalized.endsWith("/.git") || normalized.includes("/.ssh/") || normalized.includes("/.aws/") || normalized.includes("/.gnupg/") || normalized.includes("/.config/gcloud/") || normalized.endsWith("/.kube/config") || normalized.endsWith("/.docker/config.json") || normalized.endsWith("/auth.json");
}

function classify(event, ctx) {
  const toolName = event.toolName;
  const input = event.input && typeof event.input === "object" ? event.input : {};
  const command = SHELL_TOOLS.has(toolName) && typeof input.command === "string" ? input.command : "";
  const categories = [];
  if (READ_TOOLS.has(toolName)) categories.push("read");
  else if (WRITE_TOOLS.has(toolName)) categories.push("write");
  else if (SHELL_TOOLS.has(toolName)) categories.push("shell");
  else if (NETWORK_TOOL.test(toolName)) categories.push("network");
  else categories.push("external");
  if (command && NETWORK_COMMAND.test(command) && !categories.includes("network")) categories.push("network");

  const root = canonical(ctx.cwd);
  const projectRoot = projectRootOf(ctx.cwd);
  const path = toolPath(input, root);
  const risks = [];
  if (path) {
    const canonicalPath = canonical(path);
    if (!isWithin(root, canonicalPath) && !isWithin(projectRoot, canonicalPath)) risks.push("outside-workspace");
  }
  if (path && isSensitivePath(canonical(path))) risks.push("sensitive-path");
  if (command && DESTRUCTIVE_COMMAND.test(command)) risks.push("destructive-command");

  const category = categories.includes("network") ? "network" : categories[0];
  let summary;
  let detail;
  if (command) {
    summary = clip(command.replace(/\s+/g, " ").trim(), 180);
    detail = clip(command);
  } else if (path) {
    summary = (category === "write" ? "修改 " : "访问 ") + path;
    detail = path;
  } else {
    summary = "运行工具 " + toolName;
    detail = safeJson(input);
  }
  return { toolName, category, policyCategories: categories, summary, detail, risks };
}

async function checkpointGate(event, ctx) {
  if (CHECKPOINT_READ_ONLY.has(event.toolName)) return;
  if (!ctx.hasUI) return;
  try {
    await ctx.ui.select(CHECKPOINT_MARKER, ["ready"], { timeout: CHECKPOINT_TIMEOUT });
  } catch {
    // A checkpoint failure must never block the tool call itself.
  }
}

async function gate(event, ctx) {
  await checkpointGate(event, ctx);
  if (PION_INTERNAL_TOOLS.has(event.toolName)) return undefined;
  const request = classify(event, ctx);
  const policy = readPolicy(ctx.cwd);
  const decisions = request.policyCategories.map((category) => policy[category] ?? "ask");
  if (decisions.includes("deny")) {
    return { block: true, reason: "Pion 项目权限策略已拒绝此工具调用" };
  }

  const forced = request.risks.length > 0;
  const sessionKey = request.policyCategories.slice().sort().join("+") + ":" + request.risks.slice().sort().join("+");
  if (sessionAllows.has(sessionKey)) return undefined;
  if (!forced && decisions.every((decision) => decision === "allow")) return undefined;
  if (!ctx.hasUI) return { block: true, reason: "工具调用需要授权，但当前没有可用界面" };

  const canRemember = !forced;
  const metadata = {
    ...request,
    cwd: canonical(ctx.cwd),
    sessionPath: ctx.sessionManager.getSessionFile() || undefined,
    canRemember
  };
  const options = ["allow-once"];
  if (!forced) options.push("allow-session");
  if (canRemember) options.push("allow-project");
  options.push("deny");
  const choice = await ctx.ui.select(MARKER + JSON.stringify(metadata), options, { timeout: TIMEOUT });
  if (choice === "allow-session") {
    sessionAllows.add(sessionKey);
    return undefined;
  }
  if (choice === "allow-once" || choice === "allow-project") return undefined;
  return { block: true, reason: "工具调用未获用户授权" };
}

export default function (pi) {
  pi.on("tool_call", gate);
  if (process.env.PION_TOOL_PERMISSION_TEST === "1") {
    pi.registerCommand("pion-permission-test", {
      description: "Pion UI permission protocol test",
      handler: async (_args, ctx) => {
        await gate({ toolName: "write", input: { path: "pion-permission-test.txt" } }, ctx);
      }
    });
    pi.registerCommand("pion-permission-risk-test", {
      description: "Pion high-risk permission protocol test",
      handler: async (_args, ctx) => {
        await gate({ toolName: "bash", input: { command: "rm -rf ./pion-permission-risk-test" } }, ctx);
      }
    });
  }
}
`;
}
