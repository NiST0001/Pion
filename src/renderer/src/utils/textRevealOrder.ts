import {
  SCREEN_TEXT_REVEAL_LINE_CLASS, SCREEN_TEXT_REVEAL_STATIC_CLASS,
  SCREEN_TEXT_REVEAL_STAGGER_MS, SCREEN_TEXT_REVEAL_MAX_DELAY_MS,
  SCREEN_TEXT_REVEAL_LIVE_STAGGER_MS, SCREEN_TEXT_REVEAL_LIVE_MAX_DELAY_MS,
  type TextRevealMode
} from './screenTextReveal'

export type OrderedTextReveal = { delay: number; maxDelay: number }
type Request = { count: number; mode: TextRevealMode; admit: (ordered: OrderedTextReveal) => void }
type Record = { element: HTMLElement; request: Request | null }
type Subscription = { wait: (request: Request | null) => void; dispose: () => void }
type Group = { subscribe: (element: HTMLElement) => Subscription }
type Bounds = { top: number; right: number; bottom: number; left: number }
const groups = new WeakMap<Element, Group>()
// A gate may temporarily remove every subscriber while the last admitted tail
// has not started yet. Keep only its absolute clock, never observers or timers.
const tails = new WeakMap<Element, { scope: string | null; at: number }>()
const attributes = ['class', 'style', 'hidden', 'aria-hidden', 'open',
  'data-text-reveal-ready', 'data-text-reveal-open', 'data-line-reveal-ready', 'data-line-reveal-start', 'data-line-reveal-scope']
const OPENING_GATE_SELECTOR = '[data-text-reveal-open="true"][data-text-reveal-ready="false"]'

function revealRoot(element: HTMLElement): Element | null {
  return element.closest('.review-detail-body, .chat-scroll') ?? element.parentElement
}

function clip(bounds: Bounds, other: Bounds, x = true, y = true): Bounds {
  return {
    left: x ? Math.max(bounds.left, other.left) : bounds.left,
    right: x ? Math.min(bounds.right, other.right) : bounds.right,
    top: y ? Math.max(bounds.top, other.top) : bounds.top,
    bottom: y ? Math.min(bounds.bottom, other.bottom) : bounds.bottom
  }
}

/** IO is only a wakeup: every wake admits current visible chunks in DOM order. */
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
  let active = true
  let frame: number | null = null
  const schedule = (): void => {
    if (!active || frame !== null || ![...records.values()].some(record => record.request)) return
    const scheduled = window.requestAnimationFrame(() => {
      if (!active || frame !== scheduled || groups.get(root) !== group) return
      frame = null
      scan()
    })
    frame = scheduled
  }
  const intersection = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
    if (entries.some(entry => records.get(entry.target as HTMLElement)?.request)) schedule()
  }, { root })
  const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
  resize?.observe(root)
  const mutations = new MutationObserver(schedule)
  mutations.observe(root, { subtree: true, attributes: true, attributeFilter: attributes })
  // Root visibility may change without another intersection (e.g. a retained
  // hidden panel). Observe ancestor attributes, not arbitrary DOM/text changes.
  for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
    mutations.observe(ancestor, { attributes: true, attributeFilter: attributes })
  }
  root.addEventListener('scroll', schedule, { capture: true, passive: true })
  root.addEventListener('pion:line-reveal', schedule)
  root.addEventListener('toggle', schedule, true)
  window.addEventListener('resize', schedule)

  const scan = (): void => {
    if (!root.isConnected) return
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
    const currentTime = performance.now()
    const pending: Array<{ element: HTMLElement; record?: Record }> = [...records.values()]
      .filter(record => record.request).map(record => ({ element: record.element, record }))
    // Headers/compaction rows can be siblings rather than ancestors. They must
    // join the same ordering barrier, or a detail can appear before its header.
    for (const element of root.querySelectorAll<HTMLElement>(`.${SCREEN_TEXT_REVEAL_LINE_CLASS}, ${OPENING_GATE_SELECTOR}`)) {
      pending.push({ element })
    }
    pending.sort((a, b) => {
      const position = a.element.compareDocumentPosition(b.element)
      return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : position & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0
    })
    const candidates: Array<{ record?: Record; request?: Request; lineStart: number | null }> = []
    for (const { element: node, record } of pending) {
      if (!node.isConnected || revealRoot(node) !== root) continue
      const rect = rectFor(node)
      if (rect.width <= 0 || rect.height <= 0) continue
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
      candidates.push({ record, request: record?.request ?? undefined, lineStart })
    }
    // Measure everything before admitting React updates. A visible earlier
    // parent's unassigned clock blocks later chunks; offscreen chunks do not.
    const scope = root.getAttribute('data-line-reveal-scope')
    const tail = tails.get(root)
    let cursor = Math.max(currentTime, tail?.scope === scope ? tail.at : 0)
    const origin = Math.max(currentTime, candidates[0]?.lineStart ?? currentTime)
    for (const { record, request, lineStart } of candidates) {
      if (!active) break
      if (lineStart === null) break
      if (!record) { cursor = Math.max(cursor, lineStart); continue }
      if (!request || records.get(record.element) !== record || record.request !== request) continue
      const live = request.mode === 'live'
      const stagger = live ? SCREEN_TEXT_REVEAL_LIVE_STAGGER_MS : SCREEN_TEXT_REVEAL_STAGGER_MS
      const cap = live ? SCREEN_TEXT_REVEAL_LIVE_MAX_DELAY_MS : SCREEN_TEXT_REVEAL_MAX_DELAY_MS
      const start = Math.max(cursor, lineStart)
      // One cap for the whole wake, not a fresh full cap for every block.
      // A later parent's future start can exceed it, but never move backwards.
      const remaining = Math.max(0, origin + cap - start)
      cursor = start + Math.min(request.count * stagger, remaining)
      tails.set(root, { scope, at: cursor })
      record.request = null
      intersection?.unobserve(record.element)
      resize?.unobserve(record.element)
      request.admit({ delay: start - currentTime, maxDelay: remaining })
    }
  }
  const group: Group = {
    subscribe(element) {
      const record: Record = { element, request: null }
      records.set(element, record)
      return {
        wait(request) {
          if (!active || records.get(element) !== record) return
          const observing = record.request !== null
          record.request = request && request.count > 0 ? request : null
          if (record.request) {
            if (!observing) { intersection?.observe(element); resize?.observe(element) }
            schedule()
          } else if (observing) { intersection?.unobserve(element); resize?.unobserve(element) }
        },
        dispose() {
          if (records.get(element) !== record) return
          records.delete(element)
          intersection?.unobserve(element)
          resize?.unobserve(element)
          if (records.size) return
          active = false
          if (frame !== null) window.cancelAnimationFrame(frame)
          frame = null
          intersection?.disconnect()
          resize?.disconnect()
          mutations.disconnect()
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
