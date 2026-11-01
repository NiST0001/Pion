import {
  SCREEN_TEXT_REVEAL_LINE_CLASS, SCREEN_TEXT_REVEAL_STATIC_CLASS,
  SCREEN_TEXT_REVEAL_STAGGER_MS, SCREEN_TEXT_REVEAL_MAX_DELAY_MS,
  SCREEN_TEXT_REVEAL_LIVE_STAGGER_MS, SCREEN_TEXT_REVEAL_LIVE_MAX_DELAY_MS,
  type TextRevealMode
} from './screenTextReveal'
import { textRevealRoot as revealRoot } from './textRevealRoot'

export const TEXT_REVEAL_FRAME_CHARACTER_BUDGET = 1024
export type OrderedTextReveal = { delay: number; maxDelay: number }
type Request =
  | { count: number; mode: TextRevealMode; lineage?: object; prepare?: false; admit: (ordered: OrderedTextReveal) => void }
  | { count: 0; mode: TextRevealMode; lineage?: object; prepare: true; admit: (ordered: OrderedTextReveal) => boolean }
type Record = { element: HTMLElement; request: Request | null; ancestors: Node[]; observedAt: number; admittedText?: string }
type Subscription = { wait: (request: Request | null) => void; dispose: () => void }
type Group = { subscribe: (element: HTMLElement) => Subscription }
type Bounds = { top: number; right: number; bottom: number; left: number }
const groups = new WeakMap<Element, Group>()
type PreparedReceipt = { scope: string | null; origin: number; element: WeakRef<HTMLElement> }
const preparedReceipts = new WeakMap<Element, PreparedReceipt>()
// A gate may temporarily remove every subscriber while admitted tails are
// still in the future. Weak sources preserve clocks without retaining old DOM.
const tails = new WeakMap<Element, { scope: string | null; sources: Map<WeakRef<HTMLElement>, number> }>()
const sourceRefs = new WeakMap<HTMLElement, WeakRef<HTMLElement>>()

function sourceRef(element: HTMLElement): WeakRef<HTMLElement> {
  let source = sourceRefs.get(element)
  if (!source) { source = new WeakRef(element); sourceRefs.set(element, source) }
  return source
}
const OPENING_GATE_SELECTOR = '[data-text-reveal-open="true"][data-text-reveal-ready="false"]'

function clip(bounds: Bounds, other: Bounds, x = true, y = true): Bounds {
  return {
    left: x ? Math.max(bounds.left, other.left) : bounds.left,
    right: x ? Math.min(bounds.right, other.right) : bounds.right,
    top: y ? Math.max(bounds.top, other.top) : bounds.top,
    bottom: y ? Math.min(bounds.bottom, other.bottom) : bounds.bottom
  }
}

/** Past line clocks cannot delay a new batch; ancestors may still be pending. */
function hasPendingLineClock(element: HTMLElement, time: number): boolean {
  for (let line: HTMLElement | null = element; line; line = line.parentElement) {
    if (!line.classList.contains(SCREEN_TEXT_REVEAL_LINE_CLASS)
      || line.classList.contains(SCREEN_TEXT_REVEAL_STATIC_CLASS)) continue
    const start = line.dataset.lineRevealStart
    if (line.dataset.lineRevealReady !== 'true' || start === undefined
      || !Number.isFinite(Number(start)) || Number(start) > time) return true
  }
  return false
}

/** Retire only this element's obsolete admitted text, even during a gate pause. */
export function retireTextRevealTail(element: HTMLElement): void {
  const root = revealRoot(element)
  const source = sourceRefs.get(element)
  const tail = root && tails.get(root)
  if (!root || !source || !tail) return
  tail.sources.delete(source)
  if (!tail.sources.size) tails.delete(root)
}

/** IO filters known offscreen chunks; actual admission still measures current geometry and DOM order. */
export function subscribeTextRevealOrder(element: HTMLElement): Subscription {
  const root = revealRoot(element)
  if (!root) return { wait() {}, dispose() {} }
  let group = groups.get(root)
  if (!group) {
    group = createGroup(root)
    groups.set(root, group)
  }
  return group.subscribe(element)
}

function createGroup(root: Element): Group {
  const records = new Map<HTMLElement, Record>()
  const pendingRecords = new Set<Record>()
  const candidates = new Set<Record>()
  const ancestorRecords = new WeakMap<Node, Set<Record>>()
  const unindex = (record: Record): void => {
    for (const node of record.ancestors) {
      const members = ancestorRecords.get(node)
      members?.delete(record)
      if (members?.size === 0) ancestorRecords.delete(node)
    }
    record.ancestors = []
  }
  const index = (record: Record): void => {
    unindex(record)
    for (let node: Node | null = record.element; node; node = node.parentNode) {
      record.ancestors.push(node)
      let members = ancestorRecords.get(node)
      if (!members) { members = new Set(); ancestorRecords.set(node, members) }
      members.add(record)
    }
  }
  const invalidate = (record: Record, reindex = false): void => {
    if (!pendingRecords.has(record)) return
    candidates.add(record)
    if (reindex) index(record)
    refreshIntersection(record)
  }
  const invalidateAll = (reindex = false): void => {
    for (const record of pendingRecords) invalidate(record, reindex)
  }
  let active = true
  let frame: number | null = null
  let continuation: { scope: string | null; origin: number; record: Record; request: Request; prepared?: HTMLElement } | undefined
  const schedule = (): void => {
    if (!active || frame !== null || pendingRecords.size === 0) return
    const scheduled = window.requestAnimationFrame(() => {
      if (!active || frame !== scheduled || groups.get(root) !== group) return
      frame = null
      scan()
    })
    frame = scheduled
  }
  const acceptIntersections = (entries: IntersectionObserverEntry[], ignored?: HTMLElement): void => {
    if (!active) return
    let changed = false
    for (const entry of entries) {
      if (entry.target === ignored) continue
      const record = records.get(entry.target as HTMLElement)
      if (!record?.request) continue
      if (entry.isIntersecting) candidates.add(record)
      else if (Number.isFinite(entry.time) && entry.time > record.observedAt) candidates.delete(record)
      else candidates.add(record)
      changed = true
    }
    if (changed) schedule()
  }
  const intersection = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
    acceptIntersections(entries)
  }, { root })
  const refreshIntersection = (record: Record): void => {
    if (!intersection) return
    // Preserve queued receipts for other targets while discarding this target's
    // old observation. Unknown/equal timestamps remain conservative.
    acceptIntersections(intersection.takeRecords?.() ?? [], record.element)
    intersection.unobserve(record.element)
    record.observedAt = performance.now()
    intersection.observe(record.element)
  }
  const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(entries => {
    if (!active) return
    for (const entry of entries) {
      if (entry.target === root) invalidateAll()
      else {
        const record = records.get(entry.target as HTMLElement)
        if (record) invalidate(record)
      }
    }
    schedule()
  })
  resize?.observe(root)
  const projectionMutation = (change: MutationRecord, owner: Record | undefined): boolean => {
    if (!owner || owner.request || owner.admittedText === undefined || owner.element.textContent !== owner.admittedText) return false
    if (change.type === 'childList' && change.target === owner.element) {
      const projection = (node: Node): boolean => node.nodeType === Node.TEXT_NODE
        || (node instanceof HTMLElement && node.getAttribute('data-screen-reveal-character') === 'true'
          && [...node.childNodes].every(child => child.nodeType === Node.TEXT_NODE))
      return [...change.addedNodes, ...change.removedNodes].every(projection)
    }
    if (change.type !== 'attributes' || change.target !== owner.element) return false
    if (change.attributeName === 'data-text-reveal-start' || change.attributeName === 'data-text-reveal-pending') return true
    if (change.attributeName !== 'style') return false
    const before = document.createElement('span').style
    before.cssText = change.oldValue ?? ''
    const after = owner.element.style
    const names = new Set([...before, ...after])
    return [...names].every(name => name === 'opacity' || name === '--screen-text-reveal-delay'
      || (before.getPropertyValue(name) === after.getPropertyValue(name)
        && before.getPropertyPriority(name) === after.getPropertyPriority(name)))
  }
  const mutations = new MutationObserver(changes => {
    if (!active || !pendingRecords.size) return
    let ancestryChanged = false
    for (const change of changes) {
      if ((change.type !== 'attributes' && change.type !== 'childList') || !change.target) {
        invalidateAll(true)
        continue
      }
      // Character animation/reclamation within an admitted chunk has no
      // pending descendants. Its own mutation must not invalidate siblings.
      let owner: Record | undefined
      for (let node: Node | null = change.target; node && node !== root; node = node.parentNode) {
        const found = node instanceof HTMLElement ? records.get(node) : undefined
        if (found) { owner = found; break }
      }
      if (projectionMutation(change, owner)) continue
      const affected = new Set(ancestorRecords.get(change.target))
      if (owner?.request) affected.add(owner)
      if (change.type === 'childList') {
        if (change.target !== root && !root.contains(change.target)) ancestryChanged = true
        // Removed paths still point at their old ancestors; added paths may be
        // moving from another branch. Rebuild each affected path after delivery.
        for (const node of [...change.addedNodes, ...change.removedNodes]) {
          for (const record of ancestorRecords.get(node) ?? []) affected.add(record)
        }
      }
      if (!affected.size) {
        // An unindexed external barrier or an unrecognized path can influence
        // later pending geometry. Keep the conservative full-scan fallback.
        invalidateAll(change.type === 'childList')
      } else {
        for (const record of affected) invalidate(record, change.type === 'childList')
      }
    }
    if (ancestryChanged) refreshRootPath()
    schedule()
  })
  // Removing a preceding barrier may leave pending geometry unchanged.
  // A detached root needs a temporary wakeup when inserted outside its old
  // ancestry. This observer exists only while pending and disconnected.
  const reconnect = new MutationObserver(() => {
    if (!active || !pendingRecords.size) return
    if (root.isConnected) { reconnect.disconnect(); refreshRootPath(); invalidateAll(true); schedule() }
  })
  const syncReconnect = (): void => {
    reconnect.disconnect()
    if (active && pendingRecords.size && !root.isConnected) {
      reconnect.observe(root.ownerDocument, { childList: true, subtree: true })
    }
  }
  // Rebind instead of accumulating ancestors after a move.
  const observeAncestors = (): void => {
    mutations.disconnect()
    mutations.observe(root, { subtree: true, childList: true, attributes: true, attributeOldValue: true })
    for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
      mutations.observe(ancestor, { childList: true, attributes: true, attributeOldValue: true })
    }
  }
  let rootPath: Node[] = []
  const refreshRootPath = (): void => {
    const path: Node[] = []
    for (let node: Node | null = root.parentNode; node; node = node.parentNode) path.push(node)
    if (path.length === rootPath.length && path.every((node, i) => node === rootPath[i])) return
    rootPath = path
    invalidateAll(true)
    observeAncestors()
    syncReconnect()
  }
  refreshRootPath()
  root.addEventListener('scroll', schedule, { capture: true, passive: true })
  root.addEventListener('pion:line-reveal', schedule)
  root.addEventListener('toggle', schedule, true)
  window.addEventListener('resize', schedule)

  const scan = (): void => {
    const previous = continuation
    continuation = undefined
    if (pendingRecords.size === 0) { syncReconnect(); return }
    refreshRootPath()
    if (!root.isConnected) { syncReconnect(); return }
    const currentTime = performance.now()
    const scope = root.getAttribute('data-line-reveal-scope')
    let tail = tails.get(root)
    if (tail && tail.scope !== scope) { tails.delete(root); tail = undefined }
    if (tail) {
      for (const [source, at] of tail.sources) {
        const element = source.deref()
        if (at <= currentTime || !element || !element.isConnected || !root.contains(element) || revealRoot(element) !== root) {
          tail.sources.delete(source)
        }
      }
      if (!tail.sources.size) { tails.delete(root); tail = undefined }
    }
    const rects = new Map<Element, DOMRect>()
    const styles = new Map<Element, CSSStyleDeclaration>()
    const rectFor = (node: Element): DOMRect => {
      let rect = rects.get(node)
      if (!rect) { rect = node.getBoundingClientRect(); rects.set(node, rect) }
      return rect
    }
    const styleFor = (node: Element): CSSStyleDeclaration => {
      let style = styles.get(node)
      if (!style) { style = getComputedStyle(node); styles.set(node, style) }
      return style
    }
    const rootRect = rectFor(root)
    if (rootRect.width <= 0 || rootRect.height <= 0) return
    const viewport = clip(rootRect, { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight })
    const pending: Array<{ element: HTMLElement; record?: Record }> = [...candidates]
      .map(record => ({ element: record.element, record }))
    // Headers/compaction rows can be siblings rather than ancestors. They must
    // join the same ordering barrier, or a detail can appear before its header.
    for (const element of root.querySelectorAll<HTMLElement>(`.${SCREEN_TEXT_REVEAL_LINE_CLASS}, ${OPENING_GATE_SELECTOR}`)) {
      // Smooth-follow scrolls must not measure every completed header again.
      // Keep actual pending/future ancestor clocks and opening gates as barriers.
      if (!element.matches(OPENING_GATE_SELECTOR) && !hasPendingLineClock(element, currentTime)) continue
      pending.push({ element })
    }
    const visibleCandidates: Array<{ element: HTMLElement; record?: Record; request?: Request; lineStart: number | null }> = []
    for (const { element: node, record } of pending) {
      if (!node.isConnected || revealRoot(node) !== root) continue
      const rect = rectFor(node)
      if (rect.width <= 0 || rect.height <= 0) continue
      // Ancestor clipping can only shrink this intersection.
      if (rect.right <= viewport.left || rect.left >= viewport.right
        || rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue
      let bounds = viewport
      let hidden = false
      const openingGate = node.matches(OPENING_GATE_SELECTOR)
      let lineStart: number | null = openingGate ? null : currentTime
      for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.hidden || ancestor.getAttribute('aria-hidden') === 'true') { hidden = true; break }
        if (ancestor.dataset.textRevealReady === 'false'
          && (!openingGate || ancestor.dataset.textRevealOpen !== 'true')) { hidden = true; break }
        if (ancestor.tagName === 'DETAILS' && !ancestor.hasAttribute('open')) {
          const summary: Element | undefined = [...ancestor.children].find(child => child.tagName === 'SUMMARY')
          if (!summary?.contains(node)) { hidden = true; break }
        }
        const style = styleFor(ancestor)
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') { hidden = true; break }
        // Opacity is deliberately not a visibility gate: pending text/lines
        // need real geometry before their first animation can be allocated.
        if (ancestor !== node) {
          const x = /^(auto|scroll|hidden|clip)$/.test(style.overflowX || style.overflow)
          const y = /^(auto|scroll|hidden|clip)$/.test(style.overflowY || style.overflow)
          if (x || y) bounds = clip(bounds, rectFor(ancestor), x, y)
        }
        if (ancestor.classList.contains(SCREEN_TEXT_REVEAL_LINE_CLASS)
          && !ancestor.classList.contains(SCREEN_TEXT_REVEAL_STATIC_CLASS)) {
          const start = ancestor.dataset.lineRevealStart
          if (ancestor.dataset.lineRevealReady !== 'true' || start === undefined || !Number.isFinite(Number(start))) lineStart = null
          else if (lineStart !== null) lineStart = Math.max(lineStart, Number(start))
        }
      }
      if (hidden || bounds.right <= bounds.left || bounds.bottom <= bounds.top
        || rect.right <= bounds.left || rect.left >= bounds.right || rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue
      visibleCandidates.push({ element: node, record, request: record?.request ?? undefined, lineStart })
    }
    visibleCandidates.sort((a, b) => {
      const position = a.element.compareDocumentPosition(b.element)
      return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : position & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0
    })
    // Measure everything before admitting React updates. A visible earlier
    // parent's unassigned clock blocks later chunks; offscreen chunks do not.
    let cursor = currentTime
    if (tail) for (const at of tail.sources.values()) cursor = Math.max(cursor, at)
    const continuing = previous && previous.scope === scope && visibleCandidates.some(candidate =>
      previous.prepared ? !!candidate.request && previous.prepared.contains(candidate.element)
        : candidate.record === previous.record && (candidate.request === previous.request
          || (candidate.request?.lineage !== undefined && candidate.request.lineage === previous.request.lineage)))
    const receipt = preparedReceipts.get(root)
    const prepared = receipt?.element.deref()
    const receiptValid = !!receipt && receipt.scope === scope && !!prepared && prepared.isConnected
      && revealRoot(prepared) === root
    if (receipt && !receiptValid) preparedReceipts.delete(root)
    const receiptMatches = receiptValid && visibleCandidates.some(candidate =>
      !!candidate.request && !candidate.request.prepare && prepared!.contains(candidate.element))
    // Like an in-group continuation, the handoff is considered once by the
    // next actual scan, even when its prepared descendants are not visible.
    if (receipt) preparedReceipts.delete(root)
    const origin = continuing && previous ? previous.origin : receiptMatches && receipt ? receipt.origin
      : Math.max(currentTime, visibleCandidates[0]?.lineStart ?? currentTime)
    let admitted = 0
    for (const { record, request, lineStart } of visibleCandidates) {
      if (!active) break
      if (lineStart === null) break
      if (!record) { cursor = Math.max(cursor, lineStart); continue }
      if (!request || records.get(record.element) !== record || record.request !== request) continue
      if (request.prepare) {
        // Leave the barrier intact while selection blocks refinement. A successful
        // preparation yields to the actual React commit and its fine requests.
        const receipt = { scope, origin, element: sourceRef(record.element) }
        preparedReceipts.set(root, receipt)
        let prepared = false
        try { prepared = request.admit({ delay: 0, maxDelay: 0 }) }
        finally { if (!prepared && preparedReceipts.get(root) === receipt) preparedReceipts.delete(root) }
        if (prepared) {
          if (active) {
            continuation = { scope, origin, record, request, prepared: record.element }
            if (preparedReceipts.get(root) === receipt) preparedReceipts.delete(root)
          }
          if (records.get(record.element) === record && record.request === request) {
            record.request = null
            pendingRecords.delete(record)
            candidates.delete(record)
            unindex(record)
            intersection?.unobserve(record.element)
            resize?.unobserve(record.element)
          }
        }
        break
      }
      if (admitted > 0 && admitted + request.count > TEXT_REVEAL_FRAME_CHARACTER_BUDGET) {
        continuation = { scope, origin, record, request }
        schedule()
        break
      }
      const live = request.mode === 'live'
      const stagger = live ? SCREEN_TEXT_REVEAL_LIVE_STAGGER_MS : SCREEN_TEXT_REVEAL_STAGGER_MS
      const cap = live ? SCREEN_TEXT_REVEAL_LIVE_MAX_DELAY_MS : SCREEN_TEXT_REVEAL_MAX_DELAY_MS
      const start = Math.max(cursor, lineStart)
      // One cap for the whole wake, not a fresh full cap for every block.
      // A later parent's future start can exceed it, but never move backwards.
      const remaining = Math.max(0, origin + cap - start)
      cursor = start + Math.min(request.count * stagger, remaining)
      if (!tail) { tail = { scope, sources: new Map() }; tails.set(root, tail) }
      const source = sourceRef(record.element)
      tail.sources.set(source, Math.max(cursor, tail.sources.get(source) ?? 0))
      record.admittedText = record.element.textContent ?? ''
      record.request = null
      pendingRecords.delete(record)
      candidates.delete(record)
      unindex(record)
      admitted += request.count
      intersection?.unobserve(record.element)
      resize?.unobserve(record.element)
      request.admit({ delay: start - currentTime, maxDelay: remaining })
    }
    syncReconnect()
  }
  const group: Group = {
    subscribe(element) {
      const replaced = records.get(element)
      if (replaced) {
        pendingRecords.delete(replaced)
        candidates.delete(replaced)
        unindex(replaced)
        intersection?.unobserve(element)
        resize?.unobserve(element)
      }
      const record: Record = { element, request: null, ancestors: [], observedAt: 0 }
      records.set(element, record)
      return {
        wait(request) {
          if (!active || records.get(element) !== record) return
          const observing = record.request !== null
          record.request = request && (request.count > 0 || (request.prepare === true && request.count === 0)) ? request : null
          if (record.request) {
            pendingRecords.add(record)
            candidates.add(record)
            index(record)
            refreshIntersection(record)
            if (!observing) resize?.observe(element)
            syncReconnect()
            schedule()
          } else {
            pendingRecords.delete(record)
            candidates.delete(record)
            unindex(record)
            if (observing) { intersection?.unobserve(element); resize?.unobserve(element) }
            syncReconnect()
          }
        },
        dispose() {
          if (records.get(element) !== record) return
          records.delete(element)
          pendingRecords.delete(record)
          candidates.delete(record)
          unindex(record)
          intersection?.unobserve(element)
          resize?.unobserve(element)
          syncReconnect()
          if (records.size) return
          active = false
          if (frame !== null) window.cancelAnimationFrame(frame)
          frame = null
          intersection?.disconnect()
          resize?.disconnect()
          mutations.disconnect()
          reconnect.disconnect()
          root.removeEventListener('scroll', schedule, true)
          root.removeEventListener('pion:line-reveal', schedule)
          root.removeEventListener('toggle', schedule, true)
          window.removeEventListener('resize', schedule)
          if (groups.get(root) === group) groups.delete(root)
        }
      }
    }
  }
  return group
}
