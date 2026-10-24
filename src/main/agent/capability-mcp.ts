import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LoadedMcpConfig, McpServerEntry } from '@earendil-works/pi-coding-agent'
import { capabilityEnabled, type CapabilityItem, type CapabilityPreferences } from '../../shared/capability-settings'
import { capabilityResourceId } from '../capability-ids'

const SDK_VERSION = '1.4.0'
const require = createRequire(import.meta.url)
const CONFIG_UNAVAILABLE = '无法只读解析当前版本的原生 MCP 配置；未启动服务器。'
const CONFIG_INVALID = '部分原生 MCP 配置无效或读取失败，已跳过；未运行配置中的命令或认证。'
export const CAPABILITY_LEGACY_MCP_NOTICE = '旧 MCP 插件若自行管理连接，须关闭对应扩展入口；原生服务器开关不能接管它，隐藏工具不等于断开连接。'

type ConfigOptions = { cwd: string; agentDir: string; projectTrusted: boolean }
type McpRegistration = { name: string; extensionPath: string; config: { enabled?: boolean } }

/** The root exports this type, not loadMcpConfig. Its exports map has an import
 * condition only: resolve the public IMPORT entry, then require the audited
 * absolute ESM file (Node >=22.19). Do not guess a public/internal subpath export.
 * Pinned config.js only reads/validates JSON; it never expands !command/env,
 * reads OAuth credentials, creates a manager, or imports the transport runtime.
 * A changed layout/version fails closed instead of falling back to a connection.
 */
function readCanonicalConfiguration(options: ConfigOptions): LoadedMcpConfig {
  const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')))
  const pkg = JSON.parse(readFileSync(join(dist, '..', 'package.json'), 'utf8')) as { version?: unknown }
  if (pkg.version !== SDK_VERSION) throw new Error(CONFIG_UNAVAILABLE)
  const module = require(join(dist, 'extensions', 'mcp', 'config.js')) as {
    loadMcpConfig?: (options: ConfigOptions) => LoadedMcpConfig
  }
  if (typeof module.loadMcpConfig !== 'function') throw new Error(CONFIG_UNAVAILABLE)
  return module.loadMcpConfig(options)
}

function mcpIdentity(entry: Pick<McpServerEntry, 'source' | 'scope' | 'name' | 'override'>, cwd: string): string {
  // Global definitions share their exact source/name across project selections.
  // Only project definitions/overrides and extension registrations bind cwd.
  // Never use the normalized mcp__ namespace as a definition identity.
  const scope = entry.scope ?? 'global'
  const owner = scope === 'global' && !entry.override ? '' : resolve(cwd)
  return capabilityResourceId('mcp', entry.source, scope, owner, entry.name, entry.override ?? '')
}

function configurationItem(entry: McpServerEntry, cwd: string, preferences: CapabilityPreferences): CapabilityItem {
  const id = mcpIdentity(entry, cwd)
  return {
    id, kind: 'mcp', name: entry.name.slice(0, 128), label: entry.name.slice(0, 128),
    description: entry.override ? '全局 MCP 服务器（可信项目覆盖）'
      : entry.scope === 'project' ? '可信项目 MCP 服务器' : '全局 MCP 服务器',
    origin: entry.scope === 'project' || entry.override ? 'project' : 'user',
    enabled: capabilityEnabled(preferences, id, 'mcp', entry.config.enabled !== false),
    // Available means valid/manageable configuration, NOT a live connection or grant.
    available: true
  }
}

/** Main/runtime-private config only. Items/notices are the credential-free UI
 * projection. Pass config directly to createMcpExtension({ loadConfig }) so
 * desired switches apply before spawn, !command expansion or HTTP OAuth.
 */
export function loadCapabilityMcpConfiguration(options: ConfigOptions & { preferences: CapabilityPreferences }): {
  config: LoadedMcpConfig; items: CapabilityItem[]; notices: string[]
} {
  const notices = [CAPABILITY_LEGACY_MCP_NOTICE]
  if (!options.projectTrusted) notices.push('项目 MCP 配置仅在项目信任后读取；开启偏好不授予信任。')
  let loaded: LoadedMcpConfig
  try {
    loaded = readCanonicalConfiguration({ cwd: resolve(options.cwd), agentDir: resolve(options.agentDir), projectTrusted: options.projectTrusted })
  } catch {
    // Returning an empty canonical list would let same-name registrations win.
    // Throw before native session_start creates its live session/transport state.
    throw new Error(CONFIG_UNAVAILABLE)
  }
  const items = loaded.servers.map((entry) => configurationItem(entry, options.cwd, options.preferences))
  const errors = loaded.errors.length ? [CONFIG_INVALID] : []
  if (errors.length) notices.push(CONFIG_INVALID)
  return {
    config: {
      ...loaded,
      // Keep even disabled entries: removing one would revive an extension's
      // registration with the same name/namespace during the SDK's merge.
      servers: loaded.servers.map((entry, index) => ({ ...entry, config: { ...entry.config, enabled: items[index].enabled } })),
      // SDK parse/validation messages may contain file contents/paths. Never project them.
      errors
    },
    items, notices
  }
}

/** Pure facade for native pi.getMcpServers(), including late registrations.
 * Do not filter disabled rows, mutate the registry, or create another manager.
 */
export function applyCapabilityMcpRegistrations<T extends McpRegistration>(
  entries: readonly T[], preferences: CapabilityPreferences, cwd: string
): T[] {
  return entries.map((entry) => {
    const id = mcpIdentity({ name: entry.name, source: entry.extensionPath, scope: 'extension' }, cwd)
    return { ...entry, config: { ...entry.config, enabled: capabilityEnabled(preferences, id, 'mcp', entry.config.enabled !== false) } }
  })
}

export function capabilityMcpRegistrationItems<T extends McpRegistration>(
  entries: readonly T[], preferences: CapabilityPreferences, cwd: string
): CapabilityItem[] {
  return entries.map((entry) => {
    const id = mcpIdentity({ name: entry.name, source: entry.extensionPath, scope: 'extension' }, cwd)
    return {
      id, kind: 'mcp', name: entry.name.slice(0, 128), label: entry.name.slice(0, 128),
      description: '扩展登记的原生 MCP 服务器', origin: 'extension', available: true,
      enabled: capabilityEnabled(preferences, id, 'mcp', entry.config.enabled !== false)
    }
  })
}
