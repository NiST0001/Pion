import { app } from 'electron'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  CODEX_IMAGE_MODEL_OPTIONS, CODEX_IMAGE_QUALITIES, CODEX_IMAGE_REQUEST_ALIAS, IMAGE_GENERATION_TOOL_NAME,
  MAX_IMAGE_REFERENCES, MAX_IMAGE_REFERENCE_PATH_LENGTH, MAX_IMAGE_REFERENCE_PATHS_LENGTH,
  MAX_IMAGE_REQUEST_DIMENSION, MAX_IMAGE_REQUEST_PIXELS
} from '../shared/image-generation'
import { COMPUTER_USE_ACT_TOOL, COMPUTER_USE_OBSERVE_TOOL } from '../shared/computer-use-agent'
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
export function computerUsePolicyCategories(operation: 'observe' | 'act' | 'egress'): ToolPermissionCategory[] {
  return operation === 'act' ? ['external', 'read', 'write', 'shell', 'network'] : ['external', 'network', 'read']
}

/** Shared with the standalone gate, including normalization of saved keys. */
function canonicalPolicyCwd(cwd: string, io: Pick<typeof import('node:fs'), 'realpathSync'> & Pick<typeof import('node:path'), 'resolve'>): string {
  const absolute = io.resolve(cwd)
  try {
    return io.realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

function canonicalCwd(cwd: string): string {
  return canonicalPolicyCwd(cwd, { resolve, realpathSync })
}

/** Serialized into the standalone gate: all filesystem/path dependencies are explicit. */
function worktreePolicyRoot(
  canonicalPath: string,
  io: Pick<typeof import('node:fs'), 'closeSync' | 'constants' | 'existsSync' | 'fstatSync' | 'lstatSync' | 'openSync' | 'readSync' | 'realpathSync'>
    & Pick<typeof import('node:path'), 'basename' | 'dirname' | 'resolve' | 'sep'>
): string {
  const marker = io.sep + '.pion-worktrees' + io.sep
  const index = canonicalPath.indexOf(marker)
  if (index < 0) return canonicalPath
  const prefix = canonicalPath.slice(0, index) || io.sep
  // Keep the in-project layout tied to the repository, not a branch-named child.
  if (io.existsSync(io.resolve(prefix, '.git'))) return prefix
  const parts = canonicalPath.slice(index + marker.length).split(io.sep)
  if (!parts[0]) return canonicalPath
  const worktree = io.resolve(prefix, '.pion-worktrees', parts[0])
  const gitfile = io.resolve(worktree, '.git')
  let hasGitfile = false
  try {
    io.lstatSync(gitfile)
    hasGitfile = true
    const directory = (path: string): string => {
      if (!io.lstatSync(path).isDirectory()) throw new Error('Invalid worktree directory')
      return io.realpathSync.native(path)
    }
    const readMetadata = (path: string): string => {
      const before = io.lstatSync(path)
      if (!before.isFile() || before.size < 1 || before.size > 4096) throw new Error('Invalid worktree metadata')
      const fd = io.openSync(path, io.constants.O_RDONLY | (io.constants.O_NOFOLLOW ?? 0) | (io.constants.O_NONBLOCK ?? 0))
      try {
        const same = (stat: typeof before): boolean => stat.isFile() && stat.dev === before.dev && stat.ino === before.ino
          && stat.size === before.size && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs
        if (!same(io.fstatSync(fd))) throw new Error('Changed worktree metadata')
        const buffer = Buffer.alloc(4097)
        const length = io.readSync(fd, buffer, 0, buffer.length, 0)
        if (length !== before.size || !same(io.fstatSync(fd)) || !same(io.lstatSync(path))) throw new Error('Changed worktree metadata')
        const text = buffer.toString('utf8', 0, length)
        const line = text.replace(/\r?\n$/, '')
        if (!line || /[\0\r\n]/.test(line) || !buffer.subarray(0, length).equals(Buffer.from(text))) throw new Error('Invalid worktree metadata')
        return line
      } finally {
        io.closeSync(fd)
      }
    }
    if (directory(worktree) !== worktree) return canonicalPath
    const pointer = readMetadata(gitfile)
    if (!pointer.startsWith('gitdir: ') || pointer.length <= 8) return canonicalPath
    const entry = directory(io.resolve(worktree, pointer.slice(8)))
    const expectedCommon = io.dirname(io.dirname(entry))
    // Only standard <project>/.git/worktrees/<entry> metadata proves a main root.
    if (io.basename(io.dirname(entry)) !== 'worktrees' || io.basename(expectedCommon) !== '.git') return canonicalPath
    const common = directory(io.resolve(entry, readMetadata(io.resolve(entry, 'commondir'))))
    if (common !== expectedCommon) return canonicalPath
    const project = directory(io.dirname(common))
    if (directory(io.resolve(project, '.git')) !== common
      || io.realpathSync.native(io.resolve(entry, readMetadata(io.resolve(entry, 'gitdir')))) !== gitfile) return canonicalPath
    return project
  } catch (error) {
    // Preserve the old <name>/<branch> fallback only when the first child has
    // no Git marker. A malformed/external flat gitdir must not invent an owner.
    if (!hasGitfile && (error as { code?: string } | undefined)?.code === 'ENOENT' && parts.length > 1) {
      return io.resolve(prefix, parts[0])
    }
    return canonicalPath
  }
}

/** Worktree sessions inherit the base project's policy (mirrors the gate). */
function projectRootOf(cwd: string): string {
  return worktreePolicyRoot(canonicalCwd(cwd), {
    closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync, basename, dirname, resolve, sep
  })
}

function isDecision(value: unknown): value is ToolPermissionDecision {
  return value === 'allow' || value === 'ask' || value === 'deny'
}

/** Also serialized into the gate; keep validation independent of module bindings. */
function parsePermissionFile(value: unknown): ToolPermissionFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('工具权限配置格式无效')
  const record = value as Record<string, unknown>
  if (record.version !== 1 || typeof record.projects !== 'object' || record.projects === null || Array.isArray(record.projects)) {
    throw new Error('工具权限配置格式无效')
  }
  const projects: Record<string, ToolPermissionRules> = Object.create(null)
  const categories: ToolPermissionCategory[] = ['read', 'write', 'shell', 'network', 'external']
  for (const [cwd, value] of Object.entries(record.projects)) {
    if (!cwd || typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('工具权限配置格式无效')
    const rules = {} as ToolPermissionRules
    for (const category of categories) {
      const decision = (value as Record<string, unknown>)[category]
      if (decision !== 'allow' && decision !== 'ask' && decision !== 'deny') throw new Error('工具权限配置格式无效')
      rules[category] = decision
    }
    projects[cwd] = rules
  }
  return { version: 1, projects }
}

/** Longest configured prefix wins; shared by the store and standalone gate. */
function policyRulesFor(projects: Record<string, ToolPermissionRules>, root: string, separator: string): ToolPermissionRules | undefined {
  let best = ''
  for (const key of Object.keys(projects)) {
    if ((root === key || root.startsWith(key.endsWith(separator) ? key : key + separator)) && key.length > best.length) best = key
  }
  return best ? projects[best] : undefined
}

const DENIED_TOOL_PERMISSION_RULES: ToolPermissionRules = {
  read: 'deny', write: 'deny', shell: 'deny', network: 'deny', external: 'deny'
}

/** Persistent project-scoped policy consumed by Pion and its global Pi gate extension. */
export class ToolPermissionStore {
  private data: ToolPermissionFile = { version: 1, projects: {} }
  private loaded = false
  private loadPromise?: Promise<void>
  private loadError?: Error
  private extensionReady = false
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly changed = new Set<() => void>()

  onChanged(listener: () => void): () => void { this.changed.add(listener); return () => this.changed.delete(listener) }
  /** Current loaded policy only; no loading, backend, auth or model work. */
  getPolicySnapshot(cwd: string): ProjectToolPermissionPolicy { return this.currentPolicy(cwd) }
  private notifyChanged(): void { for (const listener of this.changed) { try { listener() } catch { /* Policy remains authoritative. */ } } }

  get filePath(): string {
    return join(app.getPath('userData'), 'pion-tool-permissions.json')
  }

  private get extensionPath(): string {
    return join(app.getPath('userData'), 'runtime', 'pion-tool-permission-extension.ts')
  }

  load(): Promise<void> {
    return this.loadPromise ??= this.loadFile()
  }

  private async loadFile(): Promise<void> {
    try {
      const parsed = parsePermissionFile(JSON.parse(await readFile(this.filePath, 'utf8')))
      const normalized: Record<string, ToolPermissionRules> = {}
      for (const [cwd, rules] of Object.entries(parsed.projects)) normalized[canonicalCwd(cwd)] = rules
      this.data = { version: 1, projects: normalized }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') this.recordLoadError()
    } finally {
      this.loaded = true
    }
  }

  private recordLoadError(): void {
    this.loadError = new Error('工具权限配置读取失败或格式无效；原文件已保留，请修复配置后重启')
    this.notifyChanged()
  }

  private async checkWritableSource(): Promise<void> {
    if (this.loadError) throw this.loadError
    try {
      parsePermissionFile(JSON.parse(await readFile(this.filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return
      this.recordLoadError()
      throw this.loadError
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
    if (this.loadError) throw this.loadError
    return this.currentPolicy(cwd)
  }

  private currentPolicy(cwd: string): ProjectToolPermissionPolicy {
    const normalizedCwd = canonicalCwd(cwd)
    const policyRoot = projectRootOf(cwd)
    const saved = policyRulesFor(this.data.projects, policyRoot, sep)
    return {
      cwd: normalizedCwd,
      source: saved ? 'saved' : 'default',
      // Snapshots can be consulted before load or after a failed settings read.
      rules: { ...(!this.loaded || this.loadError ? DENIED_TOOL_PERMISSION_RULES : saved ?? DEFAULT_TOOL_PERMISSION_RULES) }
    }
  }

  async setPolicy(
    cwd: string,
    updates: Partial<ToolPermissionRules> | null
  ): Promise<ProjectToolPermissionPolicy> {
    await this.load()
    await this.checkWritableSource()
    const policyOwner = projectRootOf(cwd)
    if (updates === null) {
      const { [policyOwner]: _removed, ...projects } = this.data.projects
      this.data = { version: 1, projects }
    } else {
      for (const [category, decision] of Object.entries(updates)) {
        if (!CATEGORIES.includes(category as ToolPermissionCategory) || !isDecision(decision)) {
          throw new Error('无效的工具权限设置')
        }
      }
      const current = this.currentPolicy(cwd).rules
      this.data = {
        version: 1,
        projects: {
          ...this.data.projects,
          [policyOwner]: { ...current, ...updates }
        }
      }
    }
    this.notifyChanged()
    await this.persist()
    return this.getPolicy(cwd)
  }

  async allowProjectCategories(
    cwd: string,
    categories: ToolPermissionCategory[]
  ): Promise<ProjectToolPermissionPolicy> {
    await this.load()
    for (const category of categories) {
      if (!CATEGORIES.includes(category)) throw new Error('无效的工具权限设置')
    }
    await this.checkWritableSource()
    const policyOwner = projectRootOf(cwd)
    const policy = this.currentPolicy(cwd)
    // A stale dialog is not an explicit settings change: do not replace a
    // newly denied category (including inherited project/worktree policy).
    if (categories.some((category) => policy.rules[category] === 'deny')) return policy
    const rules = { ...policy.rules }
    for (const category of categories) rules[category] = 'allow'
    // Check and apply synchronously, before the first persistence await.
    this.data = { version: 1, projects: { ...this.data.projects, [policyOwner]: rules } }
    this.notifyChanged()
    await this.persist()
    return this.getPolicy(policy.cwd)
  }

  private persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.data, null, 2)}\n`
    const target = this.filePath
    const temp = `${target}.${randomUUID()}.tmp`
    const write = this.writeQueue.then(async () => {
      // A later external failure/corruption also preserves the source file.
      await this.checkWritableSource()
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
 * Exported for mocked emitted-source regression tests without starting a backend.
 */
export function toolPermissionExtensionSource(): string {
  return String.raw`import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const IMAGE_GENERATION_TOOL_NAME = ${JSON.stringify(IMAGE_GENERATION_TOOL_NAME)};
const COMPUTER_USE_OBSERVE_TOOL = ${JSON.stringify(COMPUTER_USE_OBSERVE_TOOL)};
const COMPUTER_USE_ACT_TOOL = ${JSON.stringify(COMPUTER_USE_ACT_TOOL)};
const IMAGE_REQUEST_ALIAS = ${JSON.stringify(CODEX_IMAGE_REQUEST_ALIAS)};
const IMAGE_MODEL_OPTIONS = ${JSON.stringify(CODEX_IMAGE_MODEL_OPTIONS)};
const IMAGE_QUALITIES = ${JSON.stringify(CODEX_IMAGE_QUALITIES)};
const MAX_IMAGE_REFERENCES = ${MAX_IMAGE_REFERENCES};
const MAX_IMAGE_REFERENCE_PATH_LENGTH = ${MAX_IMAGE_REFERENCE_PATH_LENGTH};
const MAX_IMAGE_REFERENCE_PATHS_LENGTH = ${MAX_IMAGE_REFERENCE_PATHS_LENGTH};
const MAX_IMAGE_REQUEST_DIMENSION = ${MAX_IMAGE_REQUEST_DIMENSION};
const MAX_IMAGE_REQUEST_PIXELS = ${MAX_IMAGE_REQUEST_PIXELS};
const MARKER = "__PION_TOOL_PERMISSION__:";
const CHECKPOINT_MARKER = "__PION_RUN_CHECKPOINT__";
const CHECKPOINT_TIMEOUT = 30000;
const CHECKPOINT_READ_ONLY = new Set(["read", "grep", "find", "ls", "pion_task", "pion_ask_user"]);
const TIMEOUT = 120000;
const DEFAULTS = ${JSON.stringify(DEFAULT_TOOL_PERMISSION_RULES)};
const DENIED = ${JSON.stringify(DENIED_TOOL_PERMISSION_RULES)};
const parsePermissionFile = ${parsePermissionFile.toString()};
const policyRulesFor = ${policyRulesFor.toString()};
const canonicalPolicyCwd = ${canonicalPolicyCwd.toString()};
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const PION_INTERNAL_TOOLS = new Set(["pion_task", "pion_ask_user", "pion_subagents"]);
const NETWORK_TOOL = /(web|http|fetch|browser|search|crawl|url|download|upload|request|api)/i;
const NETWORK_COMMAND = /(^|[;&|\s])(curl|wget|ssh|scp|sftp|rsync|telnet|nc|ncat|ftp|gh\s+api|git\s+(clone|fetch|pull|push)|npm\s+(install|publish|view)|pnpm\s+(add|install)|yarn\s+(add|install)|pip\s+install|cargo\s+install|docker\s+pull|kubectl\s+)/i;
const DESTRUCTIVE_COMMAND = /(\brm\s+[^\n]*(?:-r|-f|--recursive|--force)|\bsudo\b|\b(?:chmod|chown)\b|\bmkfs\b|\bdd\s+[^\n]*\bof=|\b(?:shutdown|reboot|poweroff)\b|\bgit\s+(?:reset\s+--hard|clean\s+-[^\n]*f|checkout\s+--)|:\s*>\s*\/dev\/sd)/i;
const sessionAllows = new Set();
const OPAQUE_CATEGORIES = ["read", "write", "shell", "network", "external"];
const MCP_RESOURCE_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
let getToolInfo = () => undefined;

function isNativeTool(name) {
  return getToolInfo(name)?.sourceInfo?.source === "builtin";
}

function isOpaqueTool(name) {
  // Legacy adapter entrypoints remain gated even when native MCP replaces them.
  // Server annotations and read/delete names are not trusted authorization.
  return name === "codemode" || name === "mcp" || name === "mcpScript" || name.startsWith("mcp__");
}

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

const worktreePolicyRoot = ${worktreePolicyRoot.toString()};
function projectRootOf(cwd) {
  return worktreePolicyRoot(canonicalPolicyCwd(cwd, { resolve, realpathSync }), {
    closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync, basename, dirname, resolve, sep
  });
}

function readPolicy(cwd) {
  const file = process.env.PION_TOOL_PERMISSION_CONFIG;
  if (!file) return { ...DEFAULTS };
  try {
    const { projects } = parsePermissionFile(JSON.parse(readFileSync(file, "utf8")));
    const normalized = Object.create(null);
    for (const [path, rules] of Object.entries(projects)) normalized[canonicalPolicyCwd(path, { resolve, realpathSync })] = rules;
    return { ...(policyRulesFor(normalized, projectRootOf(cwd), sep) ?? DEFAULTS) };
  } catch (error) {
    return { ...(error?.code === "ENOENT" ? DEFAULTS : DENIED) };
  }
}

function clip(value, max = 2400) {
  const text = String(value ?? "");
  return text.length <= max ? text : text.slice(0, max) + "\n…";
}

function safeJson(value) {
  try { return clip(JSON.stringify(value, null, 2)); } catch { return clip(value); }
}

// Self-contained, bounded equivalent of shared validateImageReferencePaths:
// this materialized CLI extension cannot import application module paths or
// depend on serialized functions' bundler-renamed closure bindings.
function validateImageReferencePaths(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("invalid references");
  const count = value.length;
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_IMAGE_REFERENCES) throw new Error("invalid references");
  let totalLength = 0;
  const paths = [];
  for (let index = 0; index < count && index < MAX_IMAGE_REFERENCES; index++) {
    const path = value[index];
    if (typeof path !== "string" || !path || path.length > MAX_IMAGE_REFERENCE_PATH_LENGTH
      || path !== path.trim() || /[\\\x00-\x1f\x7f:<>"|?*]/.test(path)) throw new Error("invalid reference path");
    totalLength += path.length;
    if (totalLength > MAX_IMAGE_REFERENCE_PATHS_LENGTH) throw new Error("reference path budget");
    const normalized = path.startsWith("./") ? path.slice(2) : path;
    const parts = normalized.split("/");
    if (parts.length > 32 || !/\.(?:png|jpe?g)$/i.test(parts.at(-1) || "") || parts.some((part) => {
      if (!part || part === "." || part === ".." || /[. ]$/.test(part)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) return true;
      let bytes = 0;
      for (const character of part) {
        const code = character.codePointAt(0);
        if (code >= 0xd800 && code <= 0xdfff) return true;
        bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      }
      return bytes > 255;
    })) throw new Error("unsafe reference path");
    paths.push(parts.join("/"));
  }
  return paths;
}

function imageReferenceInfo(input) {
  if (!("referenced_image_paths" in input)) return { valid: true, needsRead: false, paths: [], riskPaths: [] };
  const value = input.referenced_image_paths;
  let paths = [];
  let valid = false;
  try {
    // Optional undefined is equivalent to omission, like execution admission.
    paths = validateImageReferencePaths(value); valid = true;
  } catch { /* Never serialize unknown/malformed image inputs. */ }
  // Invalid paths may still be risky (e.g. a traversal in the second slot).
  // Inspect only up to five bounded strings; never walk oversized arrays,
  // arbitrary objects or their image payloads, and never read image bytes.
  const riskPaths = [];
  if (Array.isArray(value) && value.length <= MAX_IMAGE_REFERENCES) {
    const count = value.length;
    for (let index = 0; index < count && index < MAX_IMAGE_REFERENCES; index++) {
      const path = value[index];
      if (typeof path === "string" && path.length > 0 && path.length <= MAX_IMAGE_REFERENCE_PATH_LENGTH) riskPaths.push(path);
    }
  }
  return { valid, needsRead: !valid || paths.length > 0, paths, riskPaths };
}

function imageSizeLabel(value) {
  if (value === undefined || value === "auto") return "auto";
  if (typeof value !== "string" || !/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(value)) return "参数无效，执行将拒绝";
  const [width, height] = value.split("x").map(Number);
  return width % 16 === 0 && height % 16 === 0
    && width <= MAX_IMAGE_REQUEST_DIMENSION && height <= MAX_IMAGE_REQUEST_DIMENSION
    && width * height <= MAX_IMAGE_REQUEST_PIXELS && Math.max(width, height) <= 3 * Math.min(width, height)
    ? value : "参数无效，执行将拒绝";
}

function imageQualityLabel(value) {
  return value === undefined ? "auto" : IMAGE_QUALITIES.includes(value) ? value : "参数无效，执行将拒绝";
}

// Mirrors the locked SDK 1.4.0 utils/paths.js and tools/path-utils.js.
// Keep local: importing SDK internals would couple this standalone gate to
// packaged module locations. Image filenames deliberately skip this syntax.
function sdkNormalizePath(input, toolInput = false) {
  let path = toolInput ? input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "") : input;
  if (process.platform === "win32" && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\")) {
    const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (match) path = match[1].toUpperCase() + ":\\" + (match[2]?.replaceAll("/", "\\") ?? "");
  }
  if (path === "~") return homedir();
  if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) return join(homedir(), path.slice(2));
  return /^file:\/\//.test(path) ? fileURLToPath(path) : path;
}

function sdkToolPath(path, cwd, read) {
  const normalized = sdkNormalizePath(path, true);
  const resolved = isAbsolute(normalized) ? resolve(normalized) : resolve(sdkNormalizePath(cwd), normalized);
  if (!read) return resolved;
  const nfd = resolved.normalize("NFD");
  const candidates = [resolved, resolved.replace(/ (AM|PM)\./gi, "\u202F$1."), nfd,
    resolved.replace(/'/g, "\u2019"), nfd.replace(/'/g, "\u2019")];
  for (const candidate of new Set(candidates)) {
    try { accessSync(candidate, constants.F_OK); return candidate; } catch { /* Same read fallback order as SDK. */ }
  }
  return resolved;
}

function toolPath(input, cwd, toolName) {
  const supplied = input && typeof input.path === "string" ? input.path : "";
  // Image paths are literal, with a bounded destination for permission metadata.
  if (toolName === IMAGE_GENERATION_TOOL_NAME) return supplied && supplied.length <= 1024 ? resolve(cwd, supplied) : undefined;
  if (!supplied) return undefined;
  if (READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName)) return sdkToolPath(supplied, cwd, toolName === "read");
  return resolve(cwd, supplied.replace(/^@/, ""));
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
  const references = toolName === IMAGE_GENERATION_TOOL_NAME ? imageReferenceInfo(input) : undefined;
  const opaque = isOpaqueTool(toolName);
  const nativeResource = MCP_RESOURCE_TOOLS.has(toolName) && isNativeTool(toolName);
  const nativeSearch = toolName === "tool_search" && isNativeTool(toolName);
  const computerUse = toolName === COMPUTER_USE_OBSERVE_TOOL || toolName === COMPUTER_USE_ACT_TOOL;
  const privateInput = opaque || nativeResource || nativeSearch || computerUse;
  const categories = [];
  if (toolName === COMPUTER_USE_ACT_TOOL) categories.push("external", "read", "write", "shell", "network");
  else if (toolName === COMPUTER_USE_OBSERVE_TOOL) categories.push("external", "network", "read");
  else if (opaque) categories.push(...OPAQUE_CATEGORIES);
  else if (nativeResource) categories.push("network", "read", "external");
  else if (nativeSearch) categories.push("read", "external");
  else if (toolName === IMAGE_GENERATION_TOOL_NAME) {
    categories.push("network", "write");
    if (references.needsRead) categories.push("read");
  } else if (READ_TOOLS.has(toolName)) categories.push("read");
  else if (WRITE_TOOLS.has(toolName)) categories.push("write");
  else if (SHELL_TOOLS.has(toolName)) categories.push("shell");
  else if (NETWORK_TOOL.test(toolName)) categories.push("network");
  else categories.push("external");
  if (command && NETWORK_COMMAND.test(command) && !categories.includes("network")) categories.push("network");

  const root = canonical(ctx.cwd);
  const projectRoot = projectRootOf(ctx.cwd);
  const toolCwd = READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName) ? ctx.cwd : root;
  const path = privateInput ? undefined : toolPath(input, toolCwd, toolName);
  const risks = [];
  const paths = path ? [path] : [];
  if (references) paths.push(...references.riskPaths.map((reference) => resolve(root, reference)));
  for (const candidate of paths) {
    const canonicalPath = canonical(candidate);
    // Retain the policy's worktree boundary; the image reader separately
    // enforces the actual current root and must not inherit this wider rule.
    if (!isWithin(root, canonicalPath) && !isWithin(projectRoot, canonicalPath)
      && !risks.includes("outside-workspace")) risks.push("outside-workspace");
    if (isSensitivePath(canonicalPath) && !risks.includes("sensitive-path")) risks.push("sensitive-path");
  }
  if (command && DESTRUCTIVE_COMMAND.test(command)) risks.push("destructive-command");

  const category = categories.includes("network") ? "network" : categories[0];
  let summary;
  let detail;
  if (toolName === IMAGE_GENERATION_TOOL_NAME) {
    // Only describe the side effects: never serialize prompts, image data or credentials.
    const requestedModel = input.model === undefined ? IMAGE_REQUEST_ALIAS : input.model;
    const option = IMAGE_MODEL_OPTIONS.find((item) => item.id === requestedModel);
    const modelLabel = option ? option.label : "不支持的请求型号";
    const operation = references.needsRead ? "编辑图片" : "生成图片";
    summary = clip(operation + " · " + modelLabel + " → " + (path || "未指定目标路径"), 180);
    // Legal relative references total <=1600; the output is <=1024. Show all
    // paths with roles, not five copies of an arbitrarily long absolute cwd.
    // Short legacy absolute destinations remain compatible. The longest
    // possible detail stays below the main parser's 4000-character clamp,
    // without truncating a legal path or dropping the final reference.
    const output = !path ? "未指定或参数无效，执行将拒绝"
      : path.length <= 1200 ? path : input.path + "（项目相对）";
    const referenceLines = !references.valid ? ["参考输入：参数无效，执行将拒绝"]
      : references.paths.length ? references.paths.map((reference, index) => "参考输入 " + (index + 1) + "（读取·项目相对）：" + reference)
      : ["输入：文字（无参考图片）"];
    detail = "目标路径：" + output + "（输出·写入 PNG 新文件）\n" + referenceLines.join("\n")
      + "\n请求型号：" + modelLabel + (option ? " [" + option.id + "]" : "")
      + (option && option.experimental ? "；Codex 订阅兼容性及账号权益未验证，拒绝时不自动降级。"
        : option ? "；官方请求别名不是实际版本报告。" : "；将由工具参数校验拒绝，不会自动改用默认型号。")
      + "\n请求尺寸：" + imageSizeLabel(input.size) + "；请求质量：" + imageQualityLabel(input.quality)
      + "。尺寸/质量不保证服务接受或精确输出；实际生成版本未报告。"
      + (references.needsRead ? "\n读取并上传完整参考/原图文件（包含文件内 metadata），不是只上传预览；读取仍仅限当前项目实际目录。" : "")
      + "\n通过网络生成并写入 PNG；使用 Codex 图片额度，会产生额外账号用量（失败或取消也可能消耗额度）。"
      + "不自动重试或降级，无 API-key/付费 API 回退。";
  } else if (computerUse) {
    summary = toolName === COMPUTER_USE_ACT_TOOL ? "ComputerUse · 请求真实桌面输入" : "ComputerUse · 请求观察并外发截图";
    detail = toolName === COMPUTER_USE_ACT_TOOL
      ? "真实桌面键鼠有全局焦点风险，不能视为窗口沙箱；仍须独立屏幕/控制许可、可信禁止目标与人工接管检查。此审批不代替执行层安全门。"
      : "捕获用户通过 Portal 明确选择的窗口，并上传给当前精确模型；截图将保存在 SDK 会话中，可能含敏感可见内容。主进程还会独立核对实际 root 工具来源和本次捕获/上传/SDK 留存许可。";
  } else if (privateInput) {
    summary = "运行工具 " + clip(toolName, 120);
    detail = nativeSearch
      ? "仅发现工具 schema 并加载声明，不执行发现的工具；实际调用仍需单独通过权限检查。"
      : nativeResource
        ? "通过 MCP 连接列出或读取外部资源；受 network、read 和 external 策略检查。"
        : "可读取或修改文件、执行命令、访问网络及调用外部服务；所有 read/write/shell/network/external 策略均须允许，内部工具调用仍逐个检查并保留写入检查点。";
    if (toolName === "codemode") detail += "\nmodels.* 可使用已配置的凭据调用付费 classifier/image 模型并上传输入，产生额外费用（失败或取消也可能计费）；模型调用没有内层工具授权。image() 和长输出可保存临时文件；已执行的真实副作用不会因脚本失败撤销。不是 Pion Codex 生图的回退。";
    detail += "\n不显示脚本、参数或凭据；权限策略和模型 VM 不等于外部工具的 OS 沙箱。";
  } else if (command) {
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
  // Delegated tools re-enter this gate individually with the parent's context.
  if (event.toolName === "pion_subagents" || CHECKPOINT_READ_ONLY.has(event.toolName)) return;
  // Observation writes no project files; the private broker owns capture/upload approval.
  if (event.toolName === COMPUTER_USE_OBSERVE_TOOL) return;
  // Native discovery loads schemas, not the discovered tools' side effects.
  if (event.toolName === "tool_search" && isNativeTool(event.toolName)) return;
  if (!ctx.hasUI) return;
  try {
    await ctx.ui.select(CHECKPOINT_MARKER, ["ready"], { timeout: CHECKPOINT_TIMEOUT, signal: event.input?.[Symbol.for("pion.subagent.abort")] ?? ctx.signal });
  } catch {
    // A checkpoint failure must never block the tool call itself.
  }
}

async function gate(event, ctx) {
  const subagentSignal = event.input?.[Symbol.for("pion.subagent.abort")];
  const signal = subagentSignal ?? ctx.signal;
  const abortReason = subagentSignal ? "子代理已中止" : "工具调用已中止";
  if (signal?.aborted) return { block: true, reason: abortReason };
  const computerUse = event.toolName === COMPUTER_USE_OBSERVE_TOOL || event.toolName === COMPUTER_USE_ACT_TOOL;
  if (computerUse && (event.parentToolCallId !== undefined || subagentSignal
    || (typeof event.toolCallId === "string" && event.toolCallId.startsWith("subagent-")))) {
    return { block: true, reason: "ComputerUse 仅允许真实主会话根工具调用" };
  }
  const internal = PION_INTERNAL_TOOLS.has(event.toolName);
  const request = internal ? undefined : classify(event, ctx);
  const admissionPolicy = readPolicy(ctx.cwd);
  if (request && request.policyCategories.some((category) => admissionPolicy[category] === "deny")) {
    return { block: true, reason: "Pion 项目权限策略已拒绝此工具调用" };
  }
  // Nested calls (parentToolCallId included) take exactly the same gate.
  await checkpointGate(event, ctx);
  if (signal?.aborted) return { block: true, reason: abortReason };
  if (internal) return undefined;
  const policy = readPolicy(ctx.cwd);
  const decisions = request.policyCategories.map((category) => policy[category] ?? "ask");
  if (decisions.includes("deny")) {
    return { block: true, reason: "Pion 项目权限策略已拒绝此工具调用" };
  }

  // models.* has no inner tool_call event. Disclose billing on every outer
  // codemode admission, including all-allow policies, without new risk flags.
  const forced = request.risks.length > 0 || request.toolName === "codemode" || computerUse;
  const sessionKey = request.policyCategories.slice().sort().join("+") + ":" + request.risks.slice().sort().join("+");
  if (!forced && sessionAllows.has(sessionKey)) return undefined;
  if (!forced && decisions.every((decision) => decision === "allow")) return undefined;
  if (!ctx.hasUI) return { block: true, reason: "工具调用需要授权，但当前没有可用界面" };

  const canRemember = !forced;
  const metadata = {
    ...request,
    subagent: typeof event.toolCallId === "string" && event.toolCallId.startsWith("subagent-"),
    cwd: canonical(ctx.cwd),
    sessionPath: ctx.sessionManager.getSessionFile() || undefined,
    canRemember
  };
  const options = ["allow-once"];
  if (!forced) options.push("allow-session");
  if (canRemember) options.push("allow-project");
  options.push("deny");
  let choice;
  try {
    choice = await ctx.ui.select(MARKER + JSON.stringify(metadata), options, { timeout: TIMEOUT, signal });
  } catch {
    // Cancellation, timeout or a failed UI must never grant tool permission.
  }
  if (signal?.aborted) return { block: true, reason: abortReason };
  // Settings can change while the permission dialog is pending. A late
  // positive response must not grant/remember a category which is now denied.
  const currentPolicy = readPolicy(ctx.cwd);
  if (request.policyCategories.some((category) => currentPolicy[category] === "deny")) {
    return { block: true, reason: "Pion 项目权限策略已拒绝此工具调用" };
  }
  if (!options.includes(choice)) return { block: true, reason: "工具调用未获用户授权" };
  if (choice === "allow-session") {
    sessionAllows.add(sessionKey);
    return undefined;
  }
  if (choice === "allow-once" || choice === "allow-project") return undefined;
  return { block: true, reason: "工具调用未获用户授权" };
}

export default function (pi) {
  getToolInfo = (name) => pi.getAllTools().find((tool) => tool.name === name);
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
