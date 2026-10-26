import type { AgentSession, ExtensionFactory, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { PION_TURN_TIMING_TYPE, parseTurnTiming, turnTimingFromEntry, type TurnTiming } from '../../shared/conversation-timing'

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
        const branch = manager.getBranch()
        const matched = inputs.flatMap(([message, input]) => {
          const receipt = inputReceipts.get(message)
          if (!receipt || input.manager !== manager || receipt.manager !== manager || input.generation !== capturedGeneration
            || receipt.generation !== capturedGeneration || input.sessionId !== manager.getSessionId() || receipt.sessionId !== input.sessionId
            || input.sessionFile !== manager.getSessionFile() || receipt.sessionFile !== input.sessionFile) return []
          const matches = branch.flatMap((entry, index) => entry.type === 'message' && entry.message === message ? [{ entry, index }] : [])
          return matches.length === 1 && matches[0].entry === receipt.entry && receipt.entry.id === receipt.entryId
            && manager.getEntry(receipt.entryId) === receipt.entry && branch.filter(entry => entry.id === receipt.entryId).length === 1
            ? [{ ...matches[0], input, receipt }] : []
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
        const recorded = new Set(branch.map(turnTimingFromEntry).filter(record => record !== undefined).map(record => record.userEntryId))
        for (const { entry, input, receipt } of matched) {
          if (!active || capturedGeneration !== generation || input.sessionId !== manager.getSessionId()
            || input.sessionFile !== manager.getSessionFile()) return
          const currentBranch = manager.getBranch()
          if (entry.id !== receipt.entryId || manager.getEntry(receipt.entryId) !== entry || !currentBranch.includes(entry)
            || currentBranch.filter(value => value.id === receipt.entryId).length !== 1
            || currentBranch.filter(value => value.type === 'message' && value.message === entry.message).length !== 1
            || recorded.has(entry.id) || entry.message.role !== 'user') continue
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
            recorded.add(entry.id)
          } catch { /* Display metadata failure leaves this input unknown. */ }
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
