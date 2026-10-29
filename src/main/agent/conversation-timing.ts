import type { AgentSession, ExtensionFactory, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent'
import { PION_TURN_TIMING_TYPE, parseTurnTiming, turnTimingFromEntry, type TurnTiming } from '../../shared/conversation-timing'

function indexBranch(branch: SessionEntry[]) {
  const entries = new Map<string, SessionEntry | null>()
  const messages = new Map<object, { entry: Extract<SessionEntry, { type: 'message' }>; index: number } | null>()
  const recorded = new Set<string>()
  for (const [index, entry] of branch.entries()) {
    // Null retires every occurrence, including repeated references to one entry.
    entries.set(entry.id, entries.has(entry.id) ? null : entry)
    if (entry.type === 'message') {
      messages.set(entry.message, messages.has(entry.message) ? null : { entry, index })
    }
    const timing = turnTimingFromEntry(entry)
    if (timing) recorded.add(timing.userEntryId)
  }
  return { branch, entries, messages, recorded }
}

/** One helper per actual SDK runtime; no model, tool, credential or startup I/O. */
export function createConversationTiming(runtimeId: string): { extension: ExtensionFactory; attach(session: AgentSession): void } {
  let sequence = 0
  let generation = 0
  let active = true
  let disposed = false
  let inputIds = new WeakMap<object, string>()
  type Source = { manager: ExtensionContext['sessionManager']; sessionId: string; sessionFile: string | undefined; generation: number }
  let receipts = new WeakMap<object, Source & { entryId: string; entry: NonNullable<ReturnType<AgentSession['sessionManager']['getEntry']>> }>()
  const pending = new Map<object, Source & { inputId: string }>()
  const reset = () => { generation++; pending.clear(); inputIds = new WeakMap(); receipts = new WeakMap() }
  const extension: ExtensionFactory = (pi) => {
    pi.on('session_start', () => { reset(); active = !disposed })
    pi.on('session_shutdown', () => { reset(); active = false })
    pi.on('message_start', (event, ctx) => {
      const message = event.message
      if (!active || message?.role !== 'user' || inputIds.has(message)) return
      const inputId = `${runtimeId}:${++sequence}`
      if (inputId.length > 512) return
      inputIds.set(message, inputId)
      pending.set(message, { inputId, manager: ctx.sessionManager, sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(), generation })
    })
    pi.on('agent_settled', (event, ctx) => {
      // Consume before any append/listener can reenter; failed bookkeeping is
      // deliberately left unknown rather than retried with a later clock.
      const inputs = [...pending]
      const inputReceipts = receipts
      pending.clear()
      inputIds = new WeakMap()
      receipts = new WeakMap()
      if (!active || !inputs.length) return
      const finishedAt = Date.now()
      const capturedGeneration = generation
      try {
        const manager = ctx.sessionManager
        let leafId = manager.getLeafId()
        let snapshot = indexBranch(manager.getBranch())
        let appended = false
        const { branch } = snapshot
        const matched = inputs.flatMap(([message, input]) => {
          const receipt = inputReceipts.get(message)
          if (!receipt || input.manager !== manager || receipt.manager !== manager || input.generation !== capturedGeneration
            || receipt.generation !== capturedGeneration || input.sessionId !== manager.getSessionId() || receipt.sessionId !== input.sessionId
            || input.sessionFile !== manager.getSessionFile() || receipt.sessionFile !== input.sessionFile) return []
          const match = snapshot.messages.get(message)
          return match && match.entry === receipt.entry && receipt.entry.id === receipt.entryId
            && manager.getEntry(receipt.entryId) === receipt.entry && snapshot.entries.get(receipt.entryId) === receipt.entry
            ? [{ ...match, message, input, receipt }] : []
        })
        if (!matched.length) return
        // Earlier retries/assistants may precede a steering input. Only a real
        // assistant after the final proven user input can classify this ending.
        const lastUserIndex = matched.reduce((last, { index }) => Math.max(last, index), -1)
        const lastAssistant = branch.slice(lastUserIndex + 1).reverse()
          .find(entry => entry.type === 'message' && entry.message.role === 'assistant')
        const reason = lastAssistant?.type === 'message' && lastAssistant.message.role === 'assistant'
          ? lastAssistant.message.stopReason : undefined
        const outcome: TurnTiming['outcome'] = event.aborted || reason === 'aborted' ? 'aborted'
          : reason === 'stop' ? 'completed' : reason === 'error' ? 'failed' : 'ended'
        for (const { entry, message, input, receipt } of matched) {
          if (!active || capturedGeneration !== generation || ctx.sessionManager !== manager || input.sessionId !== manager.getSessionId()
            || input.sessionFile !== manager.getSessionFile()) return
          // An append listener can replace/duplicate a leaf with the same ID.
          // Reindex after every append attempt as well as branch navigation.
          const currentLeafId = manager.getLeafId()
          if (appended || currentLeafId !== leafId) {
            snapshot = indexBranch(manager.getBranch())
            leafId = currentLeafId
            appended = false
          }
          if (entry.message !== message || entry.id !== receipt.entryId || manager.getEntry(receipt.entryId) !== entry || snapshot.entries.get(receipt.entryId) !== entry
            || snapshot.messages.get(entry.message)?.entry !== entry || snapshot.recorded.has(entry.id) || entry.message.role !== 'user') continue
          const startedAt = entry.message.timestamp
          const difference = finishedAt - startedAt
          const timing = parseTurnTiming({ startedAt, finishedAt, outcome,
            ...(difference >= 0 ? { durationMs: difference } : {}) })
          if (!timing) continue
          const data = { version: 1 as const, userEntryId: entry.id, inputId: input.inputId, ...timing }
          if (!turnTimingFromEntry({ type: 'custom', customType: PION_TURN_TIMING_TYPE, data })) continue
          try {
            // SDK synchronously persists this custom entry before emitting its
            // real entry_appended event. Custom entries stay out of model context.
            pi.appendEntry(PION_TURN_TIMING_TYPE, data)
          } catch { /* Display metadata failure leaves this input unknown. */ }
          finally { appended = true }
        }
      } catch { /* Missing/failed SDK evidence never gets a synthetic fallback. */ }
    })
  }
  const attached = new WeakSet<AgentSession>()
  return { extension, attach(session) {
    if (attached.has(session)) return
    attached.add(session)
    const manager = session.sessionManager
    const originalAppend = manager.appendMessage
    const originalSubscribe = session.subscribe
    const originalDispose = session.dispose
    let observing = true
    const subscriptions = new Set<() => void>()
    const append: typeof manager.appendMessage = function (message) {
      if (!observing || !active || message.role !== 'user') return originalAppend.call(manager, message)
      let source: Source | undefined
      receipts.delete(message)
      try {
        source = { manager, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), generation }
      } catch { /* Missing source evidence only disables this append's observer. */ }
      // SDK mutates its tree before persistence. A thrown append is never a receipt.
      const id = originalAppend.call(manager, message)
      try {
        if (source && observing && active && source.generation === generation && session.sessionManager === manager
          && manager.getSessionId() === source.sessionId && manager.getSessionFile() === source.sessionFile) {
          const entry = manager.getEntry(id)
          if (entry?.type === 'message' && entry.id === id && entry.message === message) {
            receipts.set(message, { ...source, entryId: id, entry })
          }
        }
      } catch { /* Observer failure must preserve the successful SDK append return. */ }
      return id
    }
    const subscribe: AgentSession['subscribe'] = function (this: AgentSession, listener) {
      let listening = observing
      const unsubscribe = originalSubscribe.call(this, (event) => {
        if (!observing || !listening) return
        if ((event.type === 'message_start' || event.type === 'message_end') && event.message.role === 'user') {
          const inputId = inputIds.get(event.message)
          if (inputId) {
            const message = { ...event.message, _pionTurnInputId: inputId }
            listener({ ...event, message })
            return
          }
        }
        listener(event)
      })
      const retire = function (this: unknown) {
        if (!listening) return
        listening = false
        subscriptions.delete(retire)
        unsubscribe.call(this)
      }
      if (listening) subscriptions.add(retire)
      else unsubscribe.call(this)
      return retire
    }
    manager.appendMessage = append
    session.subscribe = subscribe
    session.dispose = function (this: AgentSession) {
      if (!observing) return
      observing = false
      disposed = true
      active = false
      reset()
      for (const unsubscribe of subscriptions) {
        try { unsubscribe.call(session) } catch { console.warn('[conversation-timing] subscription cleanup failed') }
      }
      if (manager.appendMessage === append) manager.appendMessage = originalAppend
      else console.warn('[conversation-timing] append observer retired; outer wrapper retained')
      if (session.subscribe === subscribe) session.subscribe = originalSubscribe
      if (session.dispose === dispose) session.dispose = originalDispose
      originalDispose.call(this)
    }
    const dispose = session.dispose
  } }
}
