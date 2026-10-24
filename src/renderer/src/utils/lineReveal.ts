import {
  SCREEN_TEXT_REVEAL_LINE_CLASS,
  SCREEN_TEXT_REVEAL_LINE_LIVE_CLASS,
  SCREEN_TEXT_REVEAL_LINE_STAGGER_MS,
  SCREEN_TEXT_REVEAL_LINE_LIVE_STAGGER_MS,
  SCREEN_TEXT_REVEAL_STATIC_CLASS
} from './screenTextReveal'

const OWNER_SELECTOR = '[data-line-reveal-owner="true"]'
const LINE_SELECTOR = `.${SCREEN_TEXT_REVEAL_LINE_CLASS}`
const OPENING_GATE_SELECTOR = '[data-text-reveal-open="true"][data-text-reveal-ready="false"]'

function isBlocked(element: HTMLElement, openingGate = false): boolean {
  if (element.closest('[hidden], [aria-hidden="true"]')) return true
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.dataset.textRevealReady === 'false'
      && (!openingGate || ancestor.dataset.textRevealOpen !== 'true')) return true
    const style = getComputedStyle(ancestor)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return true
    if (ancestor.tagName !== 'DETAILS' || ancestor.hasAttribute('open')) continue
    const summary = [...ancestor.children].find(child => child.tagName === 'SUMMARY')
    if (!summary?.contains(element)) return true
  }
  return false
}

function textIntersectsViewport(element: HTMLElement, rect: DOMRect, bounds: DOMRect): boolean {
  let top = Math.max(bounds.top, 0), bottom = Math.min(bounds.bottom, window.innerHeight)
  let left = Math.max(bounds.left, 0), right = Math.min(bounds.right, window.innerWidth)
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    const clipX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX || style.overflow)
    const clipY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY || style.overflow)
    if (!clipX && !clipY) continue
    const parentRect = parent.getBoundingClientRect()
    if (clipX) { left = Math.max(left, parentRect.left); right = Math.min(right, parentRect.right) }
    if (clipY) { top = Math.max(top, parentRect.top); bottom = Math.min(bottom, parentRect.bottom) }
  }
  return bottom > top && right > left && rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right
}

type MeasuredLine = { element: HTMLElement; static: boolean }
type RevealStart = { at: number; static: boolean }

/** One viewport owns one clock: history and live rows enter in committed DOM order. */
export function watchLineReveals(container: HTMLElement): () => void {
  let active = true
  let frame: number | null = null
  let nextStart = 0
  const observed = new Set<Element>()

  const schedule = (): void => {
    if (!active || frame !== null) return
    const scheduled = window.requestAnimationFrame(() => {
      if (!active || frame !== scheduled) return
      frame = null
      scan()
    })
    frame = scheduled
  }
  const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
  const observeSizes = (elements: Set<Element>): void => {
    for (const element of observed) if (!elements.has(element)) {
      resize?.unobserve(element)
      observed.delete(element)
    }
    for (const element of elements) if (!observed.has(element)) {
      resize?.observe(element)
      observed.add(element)
    }
  }

  const scan = (): void => {
    if (!container.isConnected || isBlocked(container)) return
    const bounds = container.getBoundingClientRect()
    const sizeTargets = new Set<Element>([container, ...container.children])
    if (bounds.width <= 0 || bounds.height <= 0) { observeSizes(sizeTargets); return }
    const windowTop = bounds.top - bounds.height
    const items = [...container.querySelectorAll<HTMLElement>(`${LINE_SELECTOR}, ${OPENING_GATE_SELECTOR}, [data-text-reveal-pending="true"], [data-text-reveal-start]`)]
      .filter(element => !element.closest(OWNER_SELECTOR) || element.closest(OWNER_SELECTOR) === container)
    const lines = items.filter(element => element.classList.contains(SCREEN_TEXT_REVEAL_LINE_CLASS))
    const pending = lines.filter(element => element.dataset.lineRevealReady !== 'true')
    const pendingContainers = pending.filter(element => element.dataset.lineRevealContainer === 'true')
    const measured = new Map<HTMLElement, MeasuredLine>()
    const visibleText = new Set<HTMLElement>()
    const openingGates = new Set<HTMLElement>()
    // Finish all layout reads before assigning any ready flag, class or delay.
    // Ready children are only measured if a new bubble needs to follow them.
    for (const element of items) {
      const isLine = element.classList.contains(SCREEN_TEXT_REVEAL_LINE_CLASS)
      if (isLine && element.dataset.lineRevealReady === 'true' && !pendingContainers.some(parent => parent.contains(element))) continue
      const openingGate = element.matches(OPENING_GATE_SELECTOR)
      if (isBlocked(element, openingGate)) continue
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        // A zero-sized line is not static text. Observe its real size so a later
        // font/image/layout completion can release it without polling.
        sizeTargets.add(element)
        continue
      }
      if (rect.top > bounds.bottom) continue
      if (!isLine) {
        if (textIntersectsViewport(element, rect, bounds)) {
          if (openingGate) openingGates.add(element)
          else visibleText.add(element)
        }
        continue
      }
      measured.set(element, { element, static: element.classList.contains(SCREEN_TEXT_REVEAL_STATIC_CLASS)
        || rect.bottom < windowTop })
    }
    observeSizes(sizeTargets)
    const currentTime = performance.now()
    nextStart = Math.max(nextStart, currentTime)
    // A retained viewport can hide/rebind while its earlier lines are still
    // queued. New rows must stay behind those starts without replaying them.
    for (const element of lines) {
      if (element.dataset.lineRevealReady !== 'true' || element.dataset.lineRevealContainer === 'true'
        || element.classList.contains(SCREEN_TEXT_REVEAL_STATIC_CLASS)) continue
      const start = Number(element.dataset.lineRevealStart)
      if (Number.isFinite(start)) nextStart = Math.max(nextStart, start + (
        element.classList.contains(SCREEN_TEXT_REVEAL_LINE_LIVE_CLASS)
          ? SCREEN_TEXT_REVEAL_LINE_LIVE_STAGGER_MS : SCREEN_TEXT_REVEAL_LINE_STAGGER_MS))
    }
    const starts = new Map<HTMLElement, RevealStart>()
    const startFor = (line: MeasuredLine): RevealStart => {
      const { element } = line
      const assigned = starts.get(element)
      if (assigned) return assigned
      let start: RevealStart
      if (element.dataset.lineRevealReady === 'true') {
        const previousStart = Number(element.dataset.lineRevealStart)
        start = { at: Number.isFinite(previousStart) ? previousStart : currentTime, static: line.static }
      } else if (line.static) {
        start = { at: currentTime, static: true }
      } else {
        const firstChild = element.dataset.lineRevealContainer === 'true'
          ? [...measured.values()].find(child => child.element !== element && element.contains(child.element)) : undefined
        if (firstChild) start = startFor(firstChild)
        else {
          start = { at: nextStart, static: false }
          nextStart += element.classList.contains(SCREEN_TEXT_REVEAL_LINE_LIVE_CLASS)
            ? SCREEN_TEXT_REVEAL_LINE_LIVE_STAGGER_MS : SCREEN_TEXT_REVEAL_LINE_STAGGER_MS
        }
      }
      starts.set(element, start)
      return start
    }
    const writes: Array<{ element: HTMLElement; start: RevealStart }> = []
    for (const element of items) {
      // An open disclosure is already part of the visible reading order. Unlike
      // closed/offscreen content it cannot let later new rows race its 200ms gate.
      if (openingGates.has(element)) break
      if (visibleText.has(element)) {
        if (element.dataset.textRevealPending === 'true') break
        const textStart = Number(element.dataset.textRevealStart)
        if (Number.isFinite(textStart)) nextStart = Math.max(nextStart, textStart)
      }
      if (element.dataset.lineRevealReady === 'true') continue
      const line = measured.get(element)
      if (line) writes.push({ element, start: startFor(line) })
    }
    for (const { element, start } of writes) {
      element.style.setProperty('--screen-text-reveal-delay', `${Math.max(0, start.at - currentTime)}ms`)
      element.dataset.lineRevealStart = String(start.at)
      if (start.static) element.classList.add(SCREEN_TEXT_REVEAL_STATIC_CLASS)
      element.dataset.lineRevealReady = 'true'
    }
    if (writes.length) container.dispatchEvent(new Event('pion:line-reveal'))
  }

  const finish = (event: AnimationEvent): void => {
    const element = event.target
    if (event.animationName !== 'screen-text-reveal' || !(element instanceof HTMLElement)
      || !element.matches(LINE_SELECTOR) || element.closest(OWNER_SELECTOR) !== container
      || element.dataset.lineRevealReady !== 'true') return
    // Retaining a DOM node is not enough: display:none restarts a CSS animation
    // when shown again. Only a real completed line may release its animation.
    element.classList.add(SCREEN_TEXT_REVEAL_STATIC_CLASS)
  }
  const mutations = new MutationObserver(schedule)
  const attributeFilter = ['class', 'style', 'hidden', 'aria-hidden', 'data-text-reveal-ready',
    'data-text-reveal-open', 'data-text-reveal-pending', 'data-text-reveal-start', 'open']
  mutations.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter })
  for (let ancestor = container.parentElement; ancestor; ancestor = ancestor.parentElement) {
    mutations.observe(ancestor, { attributes: true, attributeFilter })
  }
  observeSizes(new Set([container]))
  container.addEventListener('animationend', finish)
  container.addEventListener('scroll', schedule, { capture: true, passive: true })
  container.addEventListener('toggle', schedule, true)
  container.addEventListener('pion:line-reveal-request', schedule)
  window.addEventListener('resize', schedule)
  // The first frame follows parent navigation layout effects; no settle timer
  // or token update can let a live ref jump ahead of restored history.
  schedule()
  return () => {
    active = false
    if (frame !== null) window.cancelAnimationFrame(frame)
    frame = null
    mutations.disconnect()
    resize?.disconnect()
    observed.clear()
    container.removeEventListener('animationend', finish)
    container.removeEventListener('scroll', schedule, true)
    container.removeEventListener('toggle', schedule, true)
    container.removeEventListener('pion:line-reveal-request', schedule)
    window.removeEventListener('resize', schedule)
  }
}
