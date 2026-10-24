import { resolve } from 'node:path'
import type {
  DefaultResourceLoader, ExtensionAPI, InlineExtension, LoadExtensionsResult,
  RegisteredTool, SettingsManager, Skill, ToolDefinition, ToolInfo
} from '@earendil-works/pi-coding-agent'
import {
  CAPABILITY_RUNTIME_COMMAND, CAPABILITY_RUNTIME_MAX_CHARS, PI_CORE_TOOL_NAMES,
  capabilityEnabled, type CapabilityItem, type CapabilityPreferences, type CapabilityRuntimeNotice
} from '../../shared/capability-settings'
import { capabilityResourceId } from '../capability-ids'
import type { createPionNativeLoadoutBoundary } from './native-extensions'

const CORE = new Set<string>(PI_CORE_TOOL_NAMES)
const DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write']
const PION_TOOLS = new Set(['pion_task', 'pion_ask_user', 'pion_subagents', 'pion_generate_image', 'pion_computer_observe', 'pion_computer_act'])
const RESOURCE_KEYS = ['packages', 'extensions', 'skills', 'prompts', 'themes'] as const
const TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/
type Loadout = ReturnType<typeof createPionNativeLoadoutBoundary>
type ResourceOptions = ConstructorParameters<typeof DefaultResourceLoader>[0]
type Tool = Pick<ToolInfo, 'name' | 'sourceInfo' | 'exposure'> & { defaultActive?: boolean }

/** SDK 1.4.0 getDefaultTools() already resolves +/- modifiers. Its tool-name
 * matcher (not publicly exported) treats only * as a wildcard, not ? or globs.
 * Expand against real registrations only; raw negative rules remain a separate
 * execution ceiling because SDK modifier resolution can discard them. */
export function expandCapabilityDefaultTools(entries: readonly string[] | undefined, registeredNames: Iterable<string>): Set<string> {
  const selection = entries ?? DEFAULT_TOOLS
  if (selection.some((entry) => !entry || /[^A-Za-z0-9_.*-]/.test(entry))) {
    throw new Error('不支持的 SDK defaultTools 选择语法；已保守拒绝（仅支持精确名称和 *）。')
  }
  const exact = new Set(selection.filter((entry) => !entry.includes('*')))
  const patterns = selection.filter((entry) => entry.includes('*')).map((entry) =>
    new RegExp(`^${entry.split('*').map((part) => part.replace(/\./g, '\\.')).join('.*')}$`))
  return new Set([...registeredNames].filter((name) => exact.has(name) || patterns.some((pattern) => pattern.test(name))))
}

/** The SDK package resolver otherwise installs missing packages even with no*.
 * Only its public resource-list reads are narrowed; all other methods keep their
 * original receiver. The real SettingsManager still owns model/user settings. */
export function capabilityResourceSettings(settings: SettingsManager): SettingsManager {
  return new Proxy(settings, {
    get(target, property) {
      if (property === 'getGlobalSettings' || property === 'getProjectSettings') return () => {
        const snapshot = { ...target[property]() }
        for (const key of RESOURCE_KEYS) delete snapshot[key]
        return snapshot
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

export function immutableCapabilityPreferences(preferences: CapabilityPreferences): CapabilityPreferences {
  return Object.freeze({ ...preferences, defaults: Object.freeze({ ...preferences.defaults }),
    overrides: Object.freeze({ ...preferences.overrides }) })
}

function isCore(tool: Tool): boolean {
  return CORE.has(tool.name) && tool.sourceInfo.source === 'builtin' && tool.sourceInfo.path === `builtin:${tool.name}`
}
function publicText(value: string, length: number): string { return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, length) }
function toolItem(tool: Tool, preferences: CapabilityPreferences, available: boolean, inherited: boolean): CapabilityItem {
  const origin = isCore(tool) ? 'pi' : PION_TOOLS.has(tool.name) ? 'pion'
    : tool.name.startsWith('mcp__') ? 'mcp' : 'extension'
  return {
    id: `tool:${tool.name}`, kind: tool.name === 'pion_subagents' ? 'subagent' : 'tool',
    name: publicText(tool.name, 128), label: publicText(tool.name, 128), origin,
    // Never copy a tool's arbitrary description/schema/configuration into IPC.
    description: origin === 'pi' ? 'Pi 内置编码工具' : origin === 'pion' ? 'Pion 内置工具' : '扩展或 MCP 登记的工具',
    enabled: capabilityEnabled(preferences, `tool:${tool.name}`, 'tool', inherited), available,
    ...(!available ? { unavailableReason: '已关闭，或受 SDK 工具集合、来源、隐藏曝光及实验条件限制。' } : {})
  }
}

/** A bounded whitelist projection, not a transport for raw resource metadata. */
export function capabilityRuntimeDescription(notice: CapabilityRuntimeNotice): string {
  const result: CapabilityRuntimeNotice = { version: 1, revision: notice.revision, runtimeId: notice.runtimeId,
    cwd: notice.cwd, ...(notice.sessionPath ? { sessionPath: notice.sessionPath } : {}),
    subagentsEnabled: notice.subagentsEnabled, items: [], notices: notice.notices.slice(0, 64).map((text) => publicText(text, 512)) }
  let remaining = CAPABILITY_RUNTIME_MAX_CHARS - JSON.stringify(result).length - 128
  const seen = new Set<string>()
  for (const item of notice.items) {
    if (seen.has(item.id) || !/^(?:tool:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|(?:extension|mcp|skill):[a-f0-9]{64})$/.test(item.id)) continue
    if (!['tool', 'mcp', 'skill', 'extension', 'subagent'].includes(item.kind) ||
        !['pi', 'pion', 'user', 'project', 'extension', 'mcp'].includes(item.origin)) continue
    const row: CapabilityItem = { id: item.id, kind: item.kind, origin: item.origin,
      name: publicText(item.name, 128), label: publicText(item.label, 128), description: publicText(item.description, 512),
      enabled: item.enabled === true, available: item.available === true,
      ...(item.unavailableReason ? { unavailableReason: publicText(item.unavailableReason, 256) } : {}) }
    const size = JSON.stringify(row).length + 1
    if (size > remaining || result.items.length >= 1024) {
      result.notices.push('能力目录超过单次回执上限，部分条目已省略。')
      break
    }
    remaining -= size
    seen.add(item.id)
    result.items.push(row)
  }
  const description = JSON.stringify(result)
  if (description.length > CAPABILITY_RUNTIME_MAX_CHARS) throw new Error('能力运行时回执超过上限')
  return description
}

/** Immutable desired switches intersect the SDK ceiling. SDK tools/excludeTools
 * remove unreachable tools from direct declarations AND callable discovery;
 * public extension registries also reject later registrations and core spoofing.
 * This is not a file sandbox and does not erase historical prompts/skill text. */
export function createCapabilityPolicy(options: {
  preferences: CapabilityPreferences
  cwd: string
  runtimeId: string
  loadout: Loadout
  defaultTools?: readonly string[]
  items: readonly CapabilityItem[]
  notices: readonly string[]
  getSessionPath: () => string | undefined
  getSubagentsEnabled: () => boolean
  getMcpItems: (pi: ExtensionAPI) => readonly CapabilityItem[]
}) {
  const preferences = immutableCapabilityPreferences(options.preferences)
  const known = new Map<string, Tool>()
  for (const name of PI_CORE_TOOL_NAMES) known.set(name, { name, exposure: 'direct',
    sourceInfo: { path: `builtin:${name}`, source: 'builtin', scope: 'temporary', origin: 'top-level' } })
  const registries = new Set<Map<string, RegisteredTool>>()
  const discoveredSkills = new Map<string, Skill>()
  let initialized = false
  let initial: ReadonlySet<string> = new Set()
  let api: ExtensionAPI | undefined
  let noticeGeneration = 0
  let queuedNotice: number | undefined
  let sessionStarted = false
  const retire = () => {
    noticeGeneration++
    api = undefined
    sessionStarted = false
    queuedNotice = undefined
  }
  const scheduleNotice = (generation = noticeGeneration) => {
    if (!api || !sessionStarted || generation !== noticeGeneration || queuedNotice === generation) return
    queuedNotice = generation
    // registerTool refreshes the SDK registry after Map.set returns; the loader
    // likewise assigns its final skills after skillsOverride returns.
    queueMicrotask(() => {
      if (generation !== noticeGeneration) return
      queuedNotice = undefined
      refreshNotice()
    })
  }
  const desired = (tool: Tool): boolean => capabilityEnabled(preferences, `tool:${tool.name}`, 'tool') &&
    // Preset core-name overrides cannot grant a plugin impersonating a Pi tool.
    !(preferences.defaults.tool === false && CORE.has(tool.name) && !isCore(tool))
  const allowed = (tool: Tool): boolean => desired(tool) && (!initialized || options.loadout.allowed(tool.name))
  const record = (entry: RegisteredTool) => {
    const tool = { name: entry.definition.name, sourceInfo: entry.sourceInfo,
      exposure: entry.definition.exposure ?? 'direct', defaultActive: entry.definition.defaultActive }
    if (known.size < 4096 || known.has(tool.name)) known.set(tool.name, tool)
    return allowed(tool)
  }
  const install = (result: LoadExtensionsResult): LoadExtensionsResult => {
    const generation = noticeGeneration
    registries.clear()
    for (const extension of result.extensions) {
      const entries = extension.tools
      for (const [name, tool] of entries) if (!record(tool)) entries.delete(name)
      // registerTool uses this public map for initial and late registrations.
      // Reject before SDK refreshTools rebuilds its callable/loadout registry.
      extension.tools = new Proxy(entries, {
        get(target, property) {
          if (property === 'set') return (name: string, tool: RegisteredTool) => {
            if (record(tool)) target.set(name, tool)
            else target.delete(name)
            scheduleNotice(generation)
            return extension.tools
          }
          if (property === 'delete') return (name: string) => {
            const deleted = target.delete(name)
            if (deleted) scheduleNotice(generation)
            return deleted
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      registries.add(extension.tools)
    }
    return result
  }
  const skillsOverride: NonNullable<ResourceOptions['skillsOverride']> = (base) => {
    const skills = base.skills.filter((skill) => {
      const id = capabilityResourceId('skill', resolve(skill.filePath))
      if (discoveredSkills.size < 4096 || discoveredSkills.has(id)) discoveredSkills.set(id, skill)
      return capabilityEnabled(preferences, id, 'skill')
    })
    scheduleNotice()
    return { ...base, skills }
  }
  let getSkills: () => readonly Skill[] = () => []
  const refreshNotice = () => {
    if (!api || !sessionStarted) return
    const actual = new Map(api.getAllTools().map((tool) => [tool.name, tool]))
    const active = new Set(api.getActiveTools())
    const tools = [...known.values()].filter((tool) => TOOL_NAME.test(tool.name)).map((tool) => {
      const current = actual.get(tool.name)
      const inherited = current ? active.has(tool.name) || current.exposure === 'codemode' || current.exposure === 'deferred' : initial.has(tool.name)
      return toolItem(current ?? tool, preferences, !!current && current.exposure !== 'hidden' && allowed(current), inherited)
    })
    const selectedSkills = new Set(getSkills().map((skill) => capabilityResourceId('skill', resolve(skill.filePath))))
    const skillItems: CapabilityItem[] = [...discoveredSkills].map(([id, skill]) => ({ id, kind: 'skill',
      name: skill.name, label: skill.name, description: '运行时发现的 Skill；关闭不删除文件或历史内容。',
      origin: 'extension', enabled: capabilityEnabled(preferences, id, 'skill'), available: selectedSkills.has(id),
      ...(!selectedSkills.has(id) ? { unavailableReason: '已关闭，或不在最终去重后的 Skill 集合中。' } : {}) }))
    const items = options.items.map((item) => {
      if (item.kind !== 'tool' && item.kind !== 'subagent') return item
      const current = actual.get(item.name)
      const available = !!current && current.exposure !== 'hidden' && allowed(current)
      return { ...item, available, ...(!available ? { unavailableReason: '所属运行时未登记可用的工具，或受独立执行约束限制。' } : {}) }
    })
    api.registerCommand(CAPABILITY_RUNTIME_COMMAND, {
      description: capabilityRuntimeDescription({ version: 1, revision: preferences.revision, runtimeId: options.runtimeId,
        cwd: options.cwd, sessionPath: options.getSessionPath(), subagentsEnabled: options.getSubagentsEnabled(),
        items: [...tools, ...items, ...skillItems, ...options.getMcpItems(api)], notices: [...options.notices] }),
      handler: async (_args, ctx) => { ctx.ui.notify('这是 Pion 内部只读状态回执，不能作为命令执行。', 'error') }
    })
  }
  const extension: InlineExtension = { name: 'pion-capability-policy', factory: (pi) => {
    retire()
    api = pi
    const generation = noticeGeneration
    pi.registerCommand(CAPABILITY_RUNTIME_COMMAND, { description: '',
      handler: async (_args, ctx) => { ctx.ui.notify('这是 Pion 内部只读状态回执，不能作为命令执行。', 'error') } })
    pi.on('session_start', () => {
      if (generation !== noticeGeneration) return
      sessionStarted = true
      refreshNotice()
    })
    pi.on('session_shutdown', () => { if (generation === noticeGeneration) retire() })
    pi.on('before_agent_start', (event) => {
      if (generation !== noticeGeneration) return
      const inPlan = event.systemPrompt.includes('[PION PLAN MODE]')
      const tools = new Map(pi.getAllTools().map((tool) => [tool.name, tool]))
      const retained = pi.getActiveTools().filter((name) => {
        const tool = tools.get(name)
        return tool && allowed(tool) && (!inPlan ||
          (['read', 'grep', 'find', 'ls'].includes(name) && isCore(tool)) ||
          (name === 'pion_ask_user' && tool.sourceInfo.source === 'sdk'))
      })
      // SDK explicit allowlists can reactivate declarations on late registry
      // refresh. Reapply the existing plan intersection after native readiness.
      pi.setActiveTools(retained)
      const active = new Set(retained)
      event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools.filter((name) => active.has(name))
      refreshNotice()
    })
    pi.on('mcp_servers_change', () => scheduleNotice(generation))
    pi.on('input', (event, ctx) => {
      const match = /^\/skill:([^\s]*)(?:\s|$)/.exec(event.text)
      if (!match || getSkills().some((skill) => skill.name === match[1])) return
      ctx.ui.notify('此 Skill 已关闭、不可用或不存在；未发送到模型或队列。', 'error')
      return { action: 'handled' }
    })
    pi.on('tool_call', (event) => {
      const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName)
      if (tool && tool.exposure !== 'hidden' && allowed(tool)) return
      return { block: true, reason: '此工具已关闭或不在当前 SDK 能力集合中。' }
    })
  } }
  return {
    extension, extensionsOverride: install, skillsOverride, refreshNotice, retire,
    isToolEnabled: (name: string) => capabilityEnabled(preferences, `tool:${name}`, 'tool'),
    initialize(customTools: readonly ToolDefinition[], defaultNames: readonly string[] | undefined, skills: () => readonly Skill[]) {
      for (const tool of customTools) known.set(tool.name, { name: tool.name, sourceInfo: {
        path: `<sdk:${tool.name}>`, source: 'sdk', scope: 'temporary', origin: 'top-level'
      }, exposure: tool.exposure ?? 'direct', defaultActive: tool.defaultActive })
      // Reproduce the SDK's unfiltered initial selection, NOT the preset's widened
      // selection. A standard preset must not enlarge an explicit defaultTools ceiling.
      const selected = expandCapabilityDefaultTools(defaultNames,
        [...known.values()].filter((tool) => tool.exposure !== 'hidden').map((tool) => tool.name))
      for (const tool of known.values()) {
        if (!isCore(tool) && (tool.exposure === 'direct' || tool.exposure === 'model-only') && tool.defaultActive !== false) selected.add(tool.name)
      }
      initial = selected
      options.loadout.initialize([...initial])
      initialized = true
      getSkills = skills
      for (const entries of registries) for (const [name, tool] of entries) if (!record(tool)) entries.delete(name)
      const excluded = Object.entries(preferences.overrides).filter(([id, enabled]) => id.startsWith('tool:') && !enabled).map(([id]) => id.slice(5))
      if (options.defaultTools !== undefined || preferences.defaults.tool === false) {
        const names = new Set([...known.values()].filter(allowed).map((tool) => tool.name))
        for (const [id, enabled] of Object.entries(preferences.overrides)) {
          if (enabled && id.startsWith('tool:') && options.loadout.allowed(id.slice(5))) names.add(id.slice(5))
        }
        // Even a nonempty SDK allowlist otherwise retains every MCP tool for
        // codemode. This impossible native MCP name explicitly enables filtering.
        const tools = ['mcp__', ...names]
        if (preferences.defaults.tool !== false) for (const entry of options.defaultTools ?? []) {
          const pattern = entry.replace(/^[+]/, '')
          if (!entry.startsWith('-') && pattern.startsWith('mcp__')) tools.push(pattern)
        }
        return { tools, excludeTools: excluded }
      }
      // Modifier-only SDK tools preserve Pi defaults and auto-active extension
      // tools, while explicitly activating optional tools such as grep/codemode.
      const enabled = Object.entries(preferences.overrides).filter(([id, on]) => on && id.startsWith('tool:') &&
        options.loadout.allowed(id.slice(5))).map(([id]) => `+${id.slice(5)}`)
      return { ...(preferences.defaults.tool === true ? { tools: ['*'] } : enabled.length ? { tools: enabled } : {}),
        excludeTools: excluded }
    }
  }
}
