import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  DefaultPackageManager, getAgentDir, loadSkills, SettingsManager, VERSION,
  type ResolvedPaths, type ResolvedResource
} from '@earendil-works/pi-coding-agent'
import {
  capabilityEnabled, DEFAULT_CAPABILITY_PREFERENCES, PI_CORE_TOOL_NAMES,
  type CapabilityItem, type CapabilityPreferences
} from '../shared/capability-settings'
import { capabilityResourceId } from './capability-ids'
import { CAPABILITY_LEGACY_MCP_NOTICE, loadCapabilityMcpConfiguration } from './agent/capability-mcp'
import { expandCapabilityDefaultTools } from './agent/capability-policy'

const MAX_ITEMS = 4096
const MAX_SETTINGS_BYTES = 1024 * 1024
const RESOURCE_TYPES = ['extensions', 'skills', 'prompts', 'themes'] as const
const BUILTINS = ['codemode', 'tool-search', 'mcp']
const DYNAMIC_NOTICE = '未执行扩展工厂或连接 MCP；动态工具和扩展登记的服务器仅由所属现有运行时补充，未登记项保持未知。'
const READ_NOTICE = '部分资源设置或元数据无法只读解析，目录可能不完整；未安装、修复或执行扩展。'

export interface ReadCapabilityResourcesOptions {
  cwd?: string
  agentDir?: string
  projectTrusted: boolean
  preferences: CapabilityPreferences
  /** Already projected metadata from the caller's exact current runtime/cwd. */
  runtimeItems?: readonly CapabilityItem[]
}
export interface CapabilityResources {
  items: CapabilityItem[]
  notices: string[]
  catalogueRevision: string
  /** Main/runtime-private only; never spread this object into a renderer response. */
  extensionPaths: string[]
  skillPaths: string[]
  promptPaths: string[]
  themePaths: string[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** No locks or writes (SettingsManager.create acquires filesystem locks).
 * Bound reads and report fixed notices, never JSON/parser/FS diagnostic text.
 */
function readJson(path: string): unknown {
  let fd: number
  try { fd = openSync(path, 'r') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) throw new Error(READ_NOTICE)
    const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const bytes = readSync(fd, buffer, length, buffer.length - length, length)
      if (!bytes) break
      length += bytes
    }
    if (length > MAX_SETTINGS_BYTES) throw new Error(READ_NOTICE)
    return JSON.parse(buffer.subarray(0, length).toString('utf8').replace(/^\uFEFF/, ''))
  } finally { closeSync(fd) }
}

function settingsSnapshot(path: string): string | undefined {
  const parsed = readJson(path)
  if (parsed === undefined) return undefined
  if (!record(parsed)) throw new Error(READ_NOTICE)
  // Do not retain unrelated provider/auth/environment configuration in the scan.
  return JSON.stringify(Object.fromEntries([...RESOURCE_TYPES, 'packages', 'defaultTools'].flatMap((key) =>
    Object.hasOwn(parsed, key) ? [[key, parsed[key]]] : [])))
}

function sourceStamp(path: string): string {
  if (path.startsWith('builtin:')) return path
  try {
    const stat = statSync(path, { bigint: true })
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  } catch { return 'unknown-or-missing' }
}

function extensionId(resource: ResolvedResource): string {
  return capabilityResourceId('extension', resource.metadata.source, resource.metadata.scope, resource.path)
}

function extensionItem(resource: ResolvedResource): CapabilityItem {
  const builtin = resource.path.startsWith('builtin:')
  const name = builtin ? resource.path.slice('builtin:'.length)
    : /^index\.(?:ts|js)$/.test(basename(resource.path)) ? basename(dirname(resource.path)) : basename(resource.path)
  return {
    id: extensionId(resource), kind: 'extension', name: name.slice(0, 128), label: name.slice(0, 128),
    description: builtin ? 'Pi 内置扩展入口' : '扩展入口；扫描不执行工厂，动态能力可能尚未登记。',
    origin: builtin ? 'pi' : resource.metadata.scope === 'project' ? 'project' : 'user',
    enabled: resource.enabled, available: true
  }
}

function fixedTools(defaultTools: readonly string[], resources: ResolvedPaths): CapabilityItem[] {
  const defaults = expandCapabilityDefaultTools(defaultTools, [...PI_CORE_TOOL_NAMES, 'codemode', 'tool_search'])
  const tools: CapabilityItem[] = PI_CORE_TOOL_NAMES.map((name) => ({
    id: `tool:${name}`, kind: 'tool', name, label: name, description: 'Pi 内置编码工具',
    origin: 'pi', enabled: defaults.has(name), available: true
  }))
  for (const [name, label] of [
    ['pion_task', 'Pion 任务'], ['pion_ask_user', 'Pion 提问'], ['pion_subagents', 'Pion 子代理'],
    ['pion_generate_image', 'Pion 生图']
  ]) tools.push({
    id: `tool:${name}`, kind: name === 'pion_subagents' ? 'subagent' : 'tool', name, label,
    description: name === 'pion_generate_image' ? 'Codex 订阅生图；开启偏好不代替登录、额度或工具批准。' : 'Pion 原生能力；执行仍受所属会话和权限约束。',
    origin: 'pion', enabled: true, available: true
  })
  for (const [name, extension] of [['codemode', 'codemode'], ['tool_search', 'tool-search']]) tools.push({
    id: `tool:${name}`, kind: 'tool', name, label: name, description: 'Pi 内置扩展工具；沿原生 defaultTools 或 MCP 曝光按需激活。',
    origin: 'pi', enabled: defaults.has(name), available: resources.extensions.some((entry) => entry.path === `builtin:${extension}`)
  })
  for (const name of ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']) tools.push({
    id: `tool:${name}`, kind: 'tool', name, label: name, description: '原生 MCP 资源工具；目录不连接服务器。',
    origin: 'pi', enabled: true, available: false, unavailableReason: '需所属运行时实际登记 MCP 资源。'
  })
  for (const name of ['pion_computer_observe', 'pion_computer_act']) tools.push({
    id: `tool:${name}`, kind: 'tool', name, label: name, description: '实验性 ComputerUse；开关不授予捕获、外发或输入许可。',
    origin: 'pion', enabled: true, available: false, unavailableReason: '需明确启用的开发实例与所属运行时；目录不探测桌面或授予许可。'
  })
  return tools
}

function runtimeText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}

/** Metadata whitelist only: a source-bound ID is not a source receipt. The
 * bridge must already have checked the exact runtime/client/cwd/generation.
 */
function runtimeItem(item: unknown): CapabilityItem | undefined {
  if (!record(item) || !runtimeText(item.id, 160) || !runtimeText(item.name, 128)
    || !runtimeText(item.label, 128) || !runtimeText(item.description, 1024)
    || typeof item.enabled !== 'boolean' || typeof item.available !== 'boolean'
    || typeof item.origin !== 'string' || !['pi', 'pion', 'user', 'project', 'extension', 'mcp'].includes(item.origin)
    || typeof item.kind !== 'string' || !['tool', 'subagent', 'mcp', 'skill', 'extension'].includes(item.kind)
    || (item.unavailableReason !== undefined && !runtimeText(item.unavailableReason, 256))) return undefined
  const kind = item.kind as CapabilityItem['kind']
  if ((kind === 'tool' || kind === 'subagent')
    ? !/^tool:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(item.id) || item.id !== `tool:${item.name}`
      || (kind === 'subagent') !== (item.id === 'tool:pion_subagents')
    : !new RegExp(`^${kind}:[a-f0-9]{64}$`).test(item.id)) return undefined
  return {
    id: item.id, kind, name: item.name, label: item.label, description: item.description,
    origin: item.origin as CapabilityItem['origin'], enabled: item.enabled, available: item.available,
    ...(item.unavailableReason !== undefined ? { unavailableReason: item.unavailableReason as string } : {})
  }
}

/** Read-only catalogue: no ResourceLoader, extension factory, ModelRuntime,
 * session, temporary extension source, credential resolver or MCP manager.
 */
export async function readCapabilityResources(options: ReadCapabilityResourcesOptions): Promise<CapabilityResources> {
  const agentDir = resolve(options.agentDir ?? getAgentDir())
  // No selected project must not accidentally scan process.cwd() or its ancestors.
  const cwd = options.cwd === undefined ? agentDir : resolve(options.cwd)
  const projectTrusted = options.cwd !== undefined && options.projectTrusted
  const preferences = structuredClone(options.preferences)
  const runtimeItems = options.runtimeItems?.map(runtimeItem).filter((item): item is CapabilityItem => item !== undefined) ?? []
  const notices = new Set<string>([DYNAMIC_NOTICE, CAPABILITY_LEGACY_MCP_NOTICE])
  if (options.cwd !== undefined && !projectTrusted) notices.add('项目未信任，未读取项目设置、扩展或 Skill；开启偏好不授予信任。')
  const settings = SettingsManager.fromStorage({
    withLock(scope, callback) {
      const path = scope === 'global' ? join(agentDir, 'settings.json') : join(cwd, '.pi', 'settings.json')
      const next = callback(settingsSnapshot(path))
      if (next !== undefined) throw new Error('Capability catalogue settings are read-only')
    }
  }, { projectTrusted })
  if (settings.drainErrors().length) notices.add(READ_NOTICE)
  let settingsIdentity: [ReturnType<SettingsManager['getGlobalSettings']>, ReturnType<SettingsManager['getProjectSettings']>]
  let defaultTools: ReturnType<SettingsManager['getDefaultTools']>
  try {
    settingsIdentity = [settings.getGlobalSettings(), settings.getProjectSettings()]
    defaultTools = settings.getDefaultTools()
  } catch { throw new Error(READ_NOTICE) }
  // Audited SDK 1.4.0 resolve: npm version/range/tag checking reads installed
  // package.json only; missing installs/repairs go exclusively through onMissing.
  // BUT global legacy lookup calls npm/pnpm/bun through getNpmCommand even with
  // skip. Block that public getter on this scan-only manager BEFORE resolve.
  // Its legacy lookup catches this refusal and uses the managed (possibly absent)
  // path. Never execute a user npmCommand, probe global roots, or change PI_OFFLINE.
  settings.getNpmCommand = () => {
    notices.add('旧全局 npm 安装位置未探测（unknown）；目录不执行包管理器命令。')
    throw new Error('Capability catalogue cannot execute package-manager commands')
  }
  let resources: ResolvedPaths = { extensions: [], skills: [], prompts: [], themes: [] }
  if (VERSION === '1.4.0') {
    try {
      resources = await new DefaultPackageManager({ cwd, agentDir, settingsManager: settings, builtinExtensions: BUILTINS }).resolve(async () => {
        notices.add('部分包未安装或版本不匹配（unknown）；目录已跳过，不安装或修复。')
        return 'skip'
      })
    } catch { notices.add(READ_NOTICE) }
  } else notices.add('当前 SDK 版本尚未核对只读资源解析；包和扩展目录保持未知。')

  // SDK 1.4.0's object-form package filters fall back to convention directories
  // for an omitted/empty manifest field. A preference must NEVER widen a package
  // manifest. The SDK already applies nonempty manifest patterns/exclusions.
  const manifests = new Map<string, unknown>()
  for (const type of RESOURCE_TYPES) resources[type] = resources[type].filter((resource) => {
    const root = resource.metadata.packageRoot
    if (resource.metadata.origin !== 'package' || !root) return true
    try {
      if (!manifests.has(root)) manifests.set(root, readJson(join(root, 'package.json')))
      const pkg = manifests.get(root)
      if (!record(pkg) || !record(pkg.pi)) return true
      const entries = pkg.pi[type]
      return Array.isArray(entries) && entries.length > 0 && entries.every((entry) => typeof entry === 'string')
    } catch { notices.add(READ_NOTICE); return false }
  })

  const raw = new Map<string, CapabilityItem>()
  const projected = new Map<string, CapabilityItem>()
  const add = (item: CapabilityItem): CapabilityItem | undefined => {
    if (raw.has(item.id)) return projected.get(item.id)
    if (raw.size >= MAX_ITEMS) { notices.add('能力目录已达到显示上限，后续项未枚举。'); return undefined }
    raw.set(item.id, item)
    const desired = { ...item, enabled: capabilityEnabled(preferences, item.id, item.kind, item.enabled) }
    projected.set(item.id, desired)
    return desired
  }
  for (const item of fixedTools(defaultTools ?? ['read', 'bash', 'edit', 'write'], resources)) add(item)
  const extensionPaths: string[] = []
  for (const resource of resources.extensions) {
    const item = add(extensionItem(resource))
    if (item?.enabled && item.available) extensionPaths.push(resource.path)
  }
  for (const [name, path] of [['codemode', 'builtin:codemode'], ['tool_search', 'builtin:tool-search']]) {
    if (extensionPaths.includes(path)) continue
    const item = projected.get(`tool:${name}`)!
    item.available = false
    item.unavailableReason = '对应内置扩展入口未选中；替代工具须由所属运行时确认。'
  }
  const skillPaths: string[] = []
  const skillNames = new Set<string>()
  for (const resource of resources.skills) {
    try {
      const result = loadSkills({ cwd, agentDir, skillPaths: [resource.path], includeDefaults: false })
      if (result.diagnostics.length) notices.add('部分 Skill 元数据存在警告或无法读取；未透传原始诊断。')
      for (const skill of result.skills) {
        const item = add({
          id: capabilityResourceId('skill', skill.filePath), kind: 'skill', name: skill.name.slice(0, 128), label: skill.name.slice(0, 128),
          description: skill.description.slice(0, 1024), origin: resource.metadata.scope === 'project' ? 'project' : 'user',
          enabled: resource.enabled, available: true
        })
        if (!item?.enabled) continue
        if (skillNames.has(skill.name)) {
          item.available = false
          item.unavailableReason = '同名 Skill 已由更高优先级的选中资源提供。'
        } else { skillNames.add(skill.name); skillPaths.push(skill.filePath) }
      }
    } catch { notices.add(READ_NOTICE) }
  }
  try {
    const mcp = loadCapabilityMcpConfiguration({ cwd, agentDir, projectTrusted, preferences: DEFAULT_CAPABILITY_PREFERENCES })
    for (const item of mcp.items) add(item)
    for (const notice of mcp.notices) notices.add(notice)
  } catch { notices.add('原生 MCP 配置读取器不可用，服务器目录保持未知；未连接服务器。') }
  // Snapshot ORIGINAL settings/enablement, not desired preferences or their revision.
  const baseline = [...raw.values()]
  const runtime: CapabilityItem[] = []
  for (const item of runtimeItems) {
    runtime.push(item)
    const known = projected.get(item.id)
    if (known) {
      known.enabled = capabilityEnabled(preferences, known.id, known.kind, item.enabled)
      known.available = item.available
      if (item.available) delete known.unavailableReason
      else known.unavailableReason = item.unavailableReason ?? '所属运行时当前不可用。'
    } else add(item)
  }
  const sourceIdentity = RESOURCE_TYPES.flatMap((type) => resources[type].map((entry) => [type, entry.path, entry.enabled, entry.metadata, sourceStamp(entry.path)]))
  const catalogueRevision = createHash('sha256').update(JSON.stringify({
    version: VERSION, cwd: options.cwd === undefined ? null : cwd, agentDir, projectTrusted,
    settings: settingsIdentity, sources: sourceIdentity,
    settingsSources: [sourceStamp(join(agentDir, 'settings.json')), ...(projectTrusted ? [sourceStamp(join(cwd, '.pi', 'settings.json'))] : [])],
    mcpSources: [sourceStamp(join(agentDir, 'mcp.json')), ...(projectTrusted ? [sourceStamp(join(cwd, '.pi', 'mcp.json'))] : [])],
    items: baseline,
    // Runtime enabled AND available can reflect already-applied desired switches
    // (including final Skill filtering). Hash registration/source identity only.
    runtime: runtime.map(({ id, kind, name, origin }) => ({ id, kind, name, origin })).sort((a, b) => a.id.localeCompare(b.id))
  })).digest('hex')
  return {
    items: [...projected.values()], notices: [...notices], catalogueRevision, extensionPaths, skillPaths,
    promptPaths: resources.prompts.filter((entry) => entry.enabled).map((entry) => entry.path),
    themePaths: resources.themes.filter((entry) => entry.enabled).map((entry) => entry.path)
  }
}
