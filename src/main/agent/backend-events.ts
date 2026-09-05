import type { AgentMode } from '../../shared/types'
import type { BackendRecord } from './types'

export interface BackendEventEffect {
  type: string | undefined
  runningStateChanged: boolean
  sessionCompleted: boolean
}

/** Apply only backend state transitions; side effects stay in AgentBridge. */
export function applyBackendEvent(
  backend: BackendRecord,
  event: unknown,
  desiredModes: Map<string, AgentMode>
): BackendEventEffect {
  const type = (event as { type?: string }).type
  let runningStateChanged = false
  let sessionCompleted = false

  if (type === 'agent_start') {
    backend.phase = 'running'
    backend.busy = true
    backend.compacting = false
    backend.completionState = undefined
    backend.awaitingRetry = false
    backend.runCompletionPromise = undefined
    runningStateChanged = true
  }
  if (type === 'compaction_start') {
    backend.compacting = true
    if (!backend.busy) runningStateChanged = true
    backend.busy = true
  }
  if (type === 'agent_end') {
    const endEvent = event as {
      messages?: Array<{ role?: string; stopReason?: string }>
      willRetry?: boolean
    }
    backend.awaitingRetry = Boolean(endEvent.willRetry)
    if (endEvent.willRetry) backend.completionState = undefined
    else {
      const assistant = [...(endEvent.messages ?? [])]
        .reverse()
        .find((message) => message.role === 'assistant')
      backend.completionState = assistant?.stopReason === 'aborted'
        ? 'aborted'
        : assistant?.stopReason === 'error'
          ? 'failed'
          : 'completed'
    }
  }
  if (type === 'compaction_end') {
    backend.compacting = false
    const compaction = event as { reason?: unknown; aborted?: unknown; errorMessage?: unknown }
    const reason = compaction.reason
    // Any failed automatic compaction is part of this run's lifecycle, even
    // when the preceding assistant response had willRetry=false (threshold
    // compaction). Never turn that boundary into a false successful settle.
    if (reason !== 'manual' && (compaction.aborted || compaction.errorMessage)) {
      backend.completionState = compaction.aborted ? 'aborted' : 'failed'
    }
    if (reason === 'manual' && backend.busy) {
      backend.busy = false
      runningStateChanged = true
    }
  }
  if (type === 'entry_appended') {
    const appended = (event as { entry?: { type?: string; customType?: string; data?: unknown } }).entry
    const data = appended?.data
    const enabled = data && typeof data === 'object'
      ? (data as Record<string, unknown>).enabled
      : undefined
    if (appended?.type === 'custom' && appended.customType === 'plan-mode-state' && typeof enabled === 'boolean') {
      const mode: AgentMode = enabled ? 'plan' : 'build'
      desiredModes.set(backend.key, mode)
      backend.modePrimed = mode
    }
  }
  if (type === 'agent_settled') {
    if (!backend.completionState && backend.awaitingRetry) backend.completionState = 'failed'
    sessionCompleted = backend.completionState === 'completed'
    if (backend.busy) runningStateChanged = true
    backend.busy = false
    backend.compacting = false
    backend.awaitingRetry = false
  }

  return { type, runningStateChanged, sessionCompleted }
}
