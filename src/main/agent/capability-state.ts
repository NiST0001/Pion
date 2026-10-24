import { isAbsolute, resolve } from 'node:path'
import { RpcClient, VERSION } from '@earendil-works/pi-coding-agent'
import {
  CAPABILITY_RUNTIME_COMMAND, CAPABILITY_RUNTIME_MAX_CHARS, CAPABILITY_RUNTIME_SOURCE,
  type CapabilityApplication, type CapabilityItem, type CapabilityRuntimeNotice
} from '../../shared/capability-settings'
import type { BackendRecord } from './types'

export type CapabilityCommands = Awaited<ReturnType<RpcClient['getCommands']>>
export interface BackendCapabilityState {
  requestedRevision: number
  appliedRevision?: number
  state: 'applied' | 'pending' | 'applying' | 'failed'
  notice?: CapabilityRuntimeNotice
  noticeClient?: RpcClient
  noticeTrust?: string
  /** Every application invalidates earlier read RPCs, even when its path is unchanged. */
  epoch: object
  /** Last verified metadata only; missing registrations are never execution receipts. */
  catalogue?: { client: RpcClient; cwd: string; trust: string; sourceRevision?: string; items: CapabilityItem[] }
  commands?: CapabilityCommands
  commandsPromise?: Promise<CapabilityCommands>
  applyPromise?: Promise<void>
  /** A rejected replacement RPC can be a timeout, not a negative close receipt. */
  quarantined?: boolean
  attemptedRevision?: number
  runPending?: boolean
  /** Explicit first input admitted while idle, not a fabricated settle receipt. */
  idleInputRunId?: string
  retiredRuntimeIds: string[]
  planCommandPath?: string
}

export function newBackendCapabilityState(revision: number): BackendCapabilityState {
  return { requestedRevision: revision, state: 'pending', retiredRuntimeIds: [], epoch: {} }
}

export function capabilityNeedsApplication(backend: BackendRecord): boolean {
  const state = backend.capability
  return !!state && (state.state !== 'applied' || state.appliedRevision !== state.requestedRevision)
}

export function capabilityApplication(backends: readonly BackendRecord[], revision: number): CapabilityApplication {
  const pending = backends.filter(backend => !backend.capability || capabilityNeedsApplication(backend)
    || backend.capability.appliedRevision !== revision)
  const states = pending.map(backend => backend.capability)
  const failed = states.some(state => !state || state.state === 'failed')
  const applying = states.some(state => state?.applyPromise)
  const applied = backends.map(backend => backend.capability?.appliedRevision)
  const appliedRevision = applied.length && applied.every(value => value !== undefined && value === applied[0]) ? applied[0] : undefined
  return {
    state: !backends.length ? 'no-backend' : failed ? 'failed' : applying ? 'applying' : pending.length ? 'pending' : 'applied',
    requestedRevision: revision, ...(appliedRevision !== undefined ? { appliedRevision } : {}), pendingBackends: pending.length,
    ...(failed ? { message: '设置已保存；部分会话未确认应用，未知收尾的后端保持隔离，未自动重启或重试连接。' }
      : pending.length ? { message: '设置已保存；等待所属运行及实际调用收尾后应用。' } : {})
  }
}

export function capabilityBackendIdle(backend: BackendRecord): boolean {
  return backend.phase === 'running' && !backend.busy && !backend.compacting && !backend.awaitingRetry
    && !backend.historyMutation && !backend.historyStopFailed && !backend.sessionExportPending
    && !backend.activeRunId && !backend.localQueueDispatching && !backend.localQueueDispatchPromise
    && !backend.promptDispatch && !backend.steeringDispatchPromises?.size && !backend.controlDispatchPromises?.size
    && !backend.runCompletionPromise && !backend.checkpointCreatePromise && !backend.checkpointRefreshPromise
    && !backend.subagentsModePending && !backend.capability?.runPending
    && !backend.rawQueue?.steering.length && !backend.rawQueue?.followUp.length
}

export type CapabilityRpcRejection = { command: 'set_model'; provider: string; modelId: string } | { command: 'compact' }
const negativeResponses = new WeakMap<Error, { client: RpcClient; command: string; message: string }>()
const observedClients = new WeakSet<RpcClient>()

/** SDK 1.4.0 erases RPC negatives into ordinary Errors in getData. Observe that
 * exact decoder, not error text/stack or arbitrary transport rejections. */
export function observeCapabilityRpcRejections(client: RpcClient): void {
  if (VERSION !== '1.4.0' || observedClients.has(client)) return
  type Decoder = { getData(response: unknown): unknown }
  const decoder = client as unknown as Decoder
  const original = (RpcClient.prototype as unknown as Decoder).getData
  if (typeof original !== 'function' || decoder.getData !== original) return
  decoder.getData = function (response: unknown): unknown {
    try { return original.call(this, response) }
    catch (error) {
      if (error instanceof Error && record(response) && response.type === 'response' && response.success === false
        && typeof response.id === 'string' && /^req_[1-9][0-9]*$/.test(response.id)
        && (response.command === 'set_model' || response.command === 'compact')
        && typeof response.error === 'string' && response.error === error.message) {
        negativeResponses.set(error, { client, command: response.command, message: response.error })
      }
      throw error
    }
  }
  observedClients.add(client)
}

export function knownCapabilityRpcRejection(client: RpcClient, error: unknown, expected?: CapabilityRpcRejection): boolean {
  if (!(error instanceof Error) || !expected) return false
  const receipt = negativeResponses.get(error)
  negativeResponses.delete(error)
  if (!receipt || receipt.client !== client || receipt.command !== expected.command) return false
  return expected.command === 'set_model'
    ? receipt.message === `Model not found: ${expected.provider}/${expected.modelId}`
      || receipt.message === `No API key for ${expected.provider}/${expected.modelId}`
    : receipt.message === 'Nothing to compact (session too small)' || receipt.message === 'Already compacted'
}

/** Same client/cwd/trust and the verified native command are the metadata
 * source fence. Preserve disabled extension slots without claiming availability. */
export function rememberCapabilityRuntimeItems(state: BackendCapabilityState, client: RpcClient,
  notice: CapabilityRuntimeNotice, trust: string): void {
  const previous = state.catalogue
  const items = new Map<string, CapabilityItem>()
  for (const entry of notice.items) items.set(entry.id, { ...entry })
  if (previous?.client === client && previous.cwd === notice.cwd && previous.trust === trust) {
    for (const entry of previous.items) {
      if (items.size >= 1024) break
      if (!items.has(entry.id)) items.set(entry.id, { ...entry, available: false,
        unavailableReason: '先前所属运行时已登记；当前入口未登记，开启偏好不代表可用。' })
    }
  }
  const sourceRevision = previous?.client === client && previous.cwd === notice.cwd && previous.trust === trust
    ? previous.sourceRevision : undefined
  state.catalogue = { client, cwd: notice.cwd, trust, sourceRevision, items: [...items.values()] }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}
function path(value: unknown): value is string {
  return text(value, 16_000) && !!value && isAbsolute(value) && resolve(value) === value
}

/** SDK's real command source is required. Names and the JSON body are not source receipts. */
export function capabilityCommandFrom(commands: CapabilityCommands, name: string, sourcePath: string): boolean {
  return commands.filter(command => command.name === name).length === 1 && commands.some(command =>
    command.name === name && command.source === 'extension' && command.sourceInfo?.path === sourcePath
    && command.sourceInfo.source === (sourcePath.startsWith('<inline:') ? 'inline' : 'cli')
    && command.sourceInfo.scope === 'temporary' && command.sourceInfo.origin === 'top-level')
}

function item(value: unknown): CapabilityItem {
  if (!record(value) || !text(value.id, 160) || !text(value.name, 128) || !text(value.label, 128)
    || !text(value.description, 1024) || typeof value.enabled !== 'boolean' || typeof value.available !== 'boolean'
    || !['pi', 'pion', 'user', 'project', 'extension', 'mcp'].includes(String(value.origin))
    || !['tool', 'subagent', 'mcp', 'skill', 'extension'].includes(String(value.kind))
    || (value.unavailableReason !== undefined && !text(value.unavailableReason, 256))) throw new Error('能力运行时条目无效')
  const kind = value.kind as CapabilityItem['kind']
  if ((kind === 'tool' || kind === 'subagent')
    ? !/^tool:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(value.id) || value.id !== `tool:${value.name}`
      || (kind === 'subagent') !== (value.id === 'tool:pion_subagents')
    : !new RegExp(`^${kind}:[a-f0-9]{64}$`).test(value.id)) throw new Error('能力运行时条目标识无效')
  return { id: value.id, name: value.name, label: value.label, description: value.description,
    kind, origin: value.origin as CapabilityItem['origin'], enabled: value.enabled, available: value.available,
    ...(value.unavailableReason !== undefined ? { unavailableReason: value.unavailableReason as string } : {}) }
}

/** Return only the explicit public whitelist; never spread a runtime payload. */
export function readCapabilityRuntimeNotice(commands: CapabilityCommands, scope: {
  cwd: string; sessionPath?: string; revision?: number; runtimeId?: string; retiredRuntimeIds?: readonly string[]
}): CapabilityRuntimeNotice {
  if (!Array.isArray(commands) || commands.length > 4096
    || !capabilityCommandFrom(commands, CAPABILITY_RUNTIME_COMMAND, CAPABILITY_RUNTIME_SOURCE)) throw new Error('能力运行时来源未确认')
  const description = commands.find(command => command.name === CAPABILITY_RUNTIME_COMMAND)!.description
  if (typeof description !== 'string' || description.length > CAPABILITY_RUNTIME_MAX_CHARS) throw new Error('能力运行时回执无效')
  const value: unknown = JSON.parse(description)
  if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || !text(value.runtimeId, 256) || !value.runtimeId || !path(value.cwd) || value.cwd !== scope.cwd
    || (value.sessionPath !== undefined && !path(value.sessionPath)) || value.sessionPath !== scope.sessionPath
    || (scope.revision !== undefined && value.revision !== scope.revision)
    || (scope.runtimeId !== undefined && value.runtimeId !== scope.runtimeId)
    || scope.retiredRuntimeIds?.includes(value.runtimeId)
    || typeof value.subagentsEnabled !== 'boolean' || !Array.isArray(value.items) || value.items.length > 1024
    || !Array.isArray(value.notices) || value.notices.length > 65 || !value.notices.every(notice => text(notice, 512))) {
    throw new Error('能力运行时回执身份或修订不匹配')
  }
  const items = value.items.map(item)
  if (new Set(items.map(entry => entry.id)).size !== items.length) throw new Error('能力运行时条目重复')
  return { version: 1, revision: value.revision as number, runtimeId: value.runtimeId, cwd: value.cwd,
    ...(value.sessionPath !== undefined ? { sessionPath: value.sessionPath as string } : {}),
    subagentsEnabled: value.subagentsEnabled, items, notices: [...value.notices] as string[] }
}
