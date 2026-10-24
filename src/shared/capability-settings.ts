/** Pion-owned desired switches. Presets are actions, never a retained mode. */
export const PI_CORE_TOOL_NAMES = ['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls'] as const
export type CapabilityKind = 'tool' | 'mcp' | 'skill' | 'extension' | 'subagent'
export type CapabilityGroup = 'tool' | 'mcp' | 'skill' | 'extension'
export type CapabilityPreset = 'minimal' | 'standard' | 'no-skills'
export type CapabilityDefault = boolean | 'inherit'

export interface CapabilityPreferences {
  version: 1
  revision: number
  defaults: Record<CapabilityGroup, CapabilityDefault>
  /** Tool slots use tool:<name>; resources use opaque, source-bound IDs. */
  overrides: Record<string, boolean>
}

export const DEFAULT_CAPABILITY_PREFERENCES: Readonly<CapabilityPreferences> = Object.freeze({
  version: 1, revision: 0,
  defaults: Object.freeze({ tool: 'inherit', mcp: 'inherit', skill: 'inherit', extension: 'inherit' }),
  overrides: Object.freeze({})
})

export interface CapabilityItem {
  id: string
  kind: CapabilityKind
  name: string
  label: string
  description: string
  origin: 'pi' | 'pion' | 'user' | 'project' | 'extension' | 'mcp'
  enabled: boolean
  /** Desired on is not a grant of trust, tool permission, installation or experimental access. */
  available: boolean
  unavailableReason?: string
}

export interface CapabilityApplication {
  state: 'applied' | 'pending' | 'applying' | 'failed' | 'no-backend'
  requestedRevision: number
  appliedRevision?: number
  pendingBackends: number
  message?: string
}

export interface CapabilitySettingsSnapshot {
  cwd?: string
  revision: number
  catalogueRevision: string
  items: CapabilityItem[]
  notices: string[]
  application: CapabilityApplication
}

export type CapabilityChange =
  | { type: 'toggle'; id: string; enabled: boolean }
  | { type: 'preset'; preset: CapabilityPreset }

export interface CapabilitySettingsUpdate {
  cwd?: string
  expectedRevision: number
  catalogueRevision: string
  change: CapabilityChange
}

export function capabilityGroup(kind: CapabilityKind): CapabilityGroup {
  return kind === 'subagent' ? 'tool' : kind
}

export function capabilityEnabled(
  preferences: CapabilityPreferences, id: string, kind: CapabilityKind, inherited = true
): boolean {
  const own = preferences.overrides[id]
  if (typeof own === 'boolean') return own
  const fallback = preferences.defaults[capabilityGroup(kind)]
  return fallback === 'inherit' ? inherited : fallback
}

/** Read through get_commands only; this command must never be sent as a prompt. */
export const CAPABILITY_RUNTIME_COMMAND = 'pion-private-capability-state'
export const CAPABILITY_RUNTIME_SOURCE = '<inline:pion-capability-policy>'
export const CAPABILITY_RUNTIME_MAX_CHARS = 256 * 1024
export interface CapabilityRuntimeNotice {
  version: 1
  revision: number
  runtimeId: string
  cwd: string
  sessionPath?: string
  subagentsEnabled: boolean
  items: CapabilityItem[]
  notices: string[]
}
