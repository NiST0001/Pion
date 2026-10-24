import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

export const SCREEN_TEXT_REVEAL_ATTRIBUTE = 'data-screen-reveal-character'
export const SCREEN_TEXT_REVEAL_CHARACTER_CLASS = 'screen-text-reveal-character'
export const SCREEN_TEXT_REVEAL_HISTORY_CLASS = 'screen-text-reveal-history'
export const SCREEN_TEXT_REVEAL_LIVE_CLASS = 'screen-text-reveal-live'
export const SCREEN_TEXT_REVEAL_ARMED_CLASS = 'screen-text-reveal-armed'
export const SCREEN_TEXT_REVEAL_LINE_CLASS = 'screen-text-reveal-line'
export const SCREEN_TEXT_REVEAL_LINE_LIVE_CLASS = 'screen-text-reveal-line-live'
export const SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS = 'screen-text-reveal-line-history'
export const SCREEN_TEXT_REVEAL_STATIC_CLASS = 'screen-text-reveal-static'
// Keep history's fast cascade; streamed suffixes fade at half its speed.
// Fade durations match refinements.css; cleanup must outlast the last delay.
export const SCREEN_TEXT_REVEAL_STAGGER_MS = 1.2
export const SCREEN_TEXT_REVEAL_MAX_DELAY_MS = 180
export const SCREEN_TEXT_REVEAL_DURATION_MS = 220
export const SCREEN_TEXT_REVEAL_LIVE_STAGGER_MS = 2.4
export const SCREEN_TEXT_REVEAL_LIVE_MAX_DELAY_MS = 360
export const SCREEN_TEXT_REVEAL_LIVE_DURATION_MS = 440
export const SCREEN_TEXT_REVEAL_LINE_DURATION_MS = 280
export const SCREEN_TEXT_REVEAL_LINE_LIVE_DURATION_MS = 560
export const SCREEN_TEXT_REVEAL_CLEANUP_GRACE_MS = 68
export const SCREEN_TEXT_REVEAL_LINE_STAGGER_MS = 20
export const SCREEN_TEXT_REVEAL_LINE_LIVE_STAGGER_MS = 40
export type TextRevealMode = 'history' | 'live'

let nextLineRevealAt = 0

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/**
 * Unmanaged compatibility clock; real timelines use their own lineReveal clock.
 * Take the next slot here only for standalone renderers. Called from ref
 * callbacks at commit time (never during render), so discarded renders cannot
 * burn slots and re-renders can never requeue a line. An idle clock restarts
 * at the next new line; a busy clock queues behind the last scheduled line.
 */
export function takeLineRevealSlot(mode: TextRevealMode = 'history'): number {
  const currentTime = now()
  if (nextLineRevealAt <= currentTime) nextLineRevealAt = currentTime
  const delay = Math.max(0, Math.round(nextLineRevealAt - currentTime))
  nextLineRevealAt = Math.max(nextLineRevealAt, currentTime) + (mode === 'live'
    ? SCREEN_TEXT_REVEAL_LINE_LIVE_STAGGER_MS
    : SCREEN_TEXT_REVEAL_LINE_STAGGER_MS)
  return delay
}

/** Reset the waterfall clock (session switches start a fresh cascade). */
export function resetLineRevealClock(): void {
  nextLineRevealAt = 0
}

/**
 * Assign waterfall delays to pending history lines, continuing the shared
 * clock. Only the bottom two viewport heights animate: everything outside
 * appears instantly, so opening a long session never makes the user wait
 * through a full-history cascade.
 */
export function assignPendingLineDelays(container: HTMLElement): void {
  if (container.matches('[data-line-reveal-owner="true"]')) {
    container.dispatchEvent(new Event('pion:line-reveal-request'))
    return
  }
  const pending = [...container.querySelectorAll<HTMLElement>(
    `.${SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS}:not([data-line-reveal-ready="true"])`
  )]
  if (pending.length === 0) return

  const containerRect = container.getBoundingClientRect()
  const windowTop = containerRect.bottom - containerRect.height * 2
  const currentTime = now()
  if (nextLineRevealAt <= currentTime) nextLineRevealAt = currentTime
  // Read every candidate before enabling any animation/style. Interleaving
  // these reads and writes forces layout once per line in a large history.
  const measured = pending.map(element => ({ element, rect: element.getBoundingClientRect() }))
  for (const { element, rect } of measured) {
    element.dataset.lineRevealReady = 'true'
    element.dataset.lineRevealStart = String(currentTime)
    if (rect.bottom < windowTop || rect.top > containerRect.bottom) {
      element.classList.add(SCREEN_TEXT_REVEAL_STATIC_CLASS)
      continue
    }
    const delay = Math.max(0, Math.round(nextLineRevealAt - currentTime))
    element.style.setProperty('--screen-text-reveal-delay', `${delay}ms`)
    element.dataset.lineRevealStart = String(currentTime + delay)
    nextLineRevealAt += SCREEN_TEXT_REVEAL_LINE_STAGGER_MS
  }
}

/**
 * Managed refs only register a line for the viewport's ordered scan. Standalone
 * history waits for its explicit scan; standalone live retains the legacy
 * immediate clock for consumers outside a timeline.
 */
export function assignLineRevealDelay(element: HTMLElement | null): void {
  if (!element || element.dataset.lineRevealReady === 'true') return
  // Managed timelines admit history and live together after layout, not in
  // child-ref order. A restored history row must never be overtaken by live.
  if (element.closest('[data-line-reveal-owner="true"]')) return
  if (element.classList.contains(SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS)) return
  const delay = takeLineRevealSlot('live')
  element.dataset.lineRevealStart = String(now() + delay)
  element.dataset.lineRevealReady = 'true'
  element.style.setProperty('--screen-text-reveal-delay', `${delay}ms`)
}

/**
 * Ref callback for a waterfall container (e.g. the assistant bubble). History
 * containers defer to the settle scan like their lines. Live containers copy
 * their first line's already assigned delay (child refs attach first), so the
 * background fades in together with that line instead of showing an empty
 * shell early.
 */
export function syncContainerRevealDelay(container: HTMLElement | null): void {
  if (!container || container.dataset.lineRevealReady === 'true') return
  container.dataset.lineRevealContainer = 'true'
  if (container.closest('[data-line-reveal-owner="true"]')) return
  if (container.classList.contains(SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS)) return
  container.dataset.lineRevealReady = 'true'
  const firstLine = container.querySelector<HTMLElement>('[data-line-reveal-ready="true"]')
  const delay = firstLine?.style.getPropertyValue('--screen-text-reveal-delay')
  container.style.setProperty('--screen-text-reveal-delay', delay || '0ms')
  container.dataset.lineRevealStart = firstLine?.dataset.lineRevealStart ?? String(now())
}

/** Render a string as independently fading lines without changing its text. */
export function RevealLines({
  text,
  mode
}: {
  text: string
  mode: TextRevealMode
}): ReactElement {
  const lines = text.split(/\r?\n/)
  return (
    <>
      {lines.map((line, index) => (
        <span
          key={index}
          ref={assignLineRevealDelay}
          className={`${SCREEN_TEXT_REVEAL_LINE_CLASS} ${mode === 'history'
            ? SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS
            : SCREEN_TEXT_REVEAL_LINE_LIVE_CLASS}`}
        >
          {line || '\u00a0'}
        </span>
      ))}
    </>
  )
}

type LiveFadeRange = { start: number; end: number; expiresAt: number; delay: number; maxDelay: number }
const MAX_LIVE_FADE_RANGES = 128
const MAX_LIVE_FADE_CHARACTERS = 4096

export function RevealText({
  text,
  mode,
  revealCount,
  ordered
}: {
  text: string
  mode: TextRevealMode
  /** For live/ordered output, only appended characters start a new animation. */
  revealCount?: number
  /** Already admitted visible text: freeze this suffix's shared root schedule. */
  ordered?: { delay: number; maxDelay: number }
}): ReactElement {
  const characters = Array.from(text)
  const committed = useRef({ text: '', mode, length: 0 })
  const [ranges, setRanges] = useState<LiveFadeRange[]>([])
  const [reducedMotion] = useState(() => typeof window !== 'undefined'
    && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false))
  const changed = committed.current.text !== text || committed.current.mode !== mode
  const append = committed.current.mode === mode && text.startsWith(committed.current.text)
  const prefixEnd = committed.current.text.length
  const completesSurrogate = append
    && /[\uD800-\uDBFF]/.test(committed.current.text.slice(-1))
    && /[\uDC00-\uDFFF]/.test(text.charAt(prefixEnd))
  const previousLength = append ? committed.current.length - (completesSurrogate ? 1 : 0) : 0
  const stagger = mode === 'live' ? SCREEN_TEXT_REVEAL_LIVE_STAGGER_MS : SCREEN_TEXT_REVEAL_STAGGER_MS
  const duration = mode === 'live' ? SCREEN_TEXT_REVEAL_LIVE_DURATION_MS : SCREEN_TEXT_REVEAL_DURATION_MS
  const cappedDelay = mode === 'live' ? SCREEN_TEXT_REVEAL_LIVE_MAX_DELAY_MS : SCREEN_TEXT_REVEAL_MAX_DELAY_MS
  const ranged = mode === 'live' || ordered !== undefined
  const start = Math.max(previousLength,
    characters.length - Math.max(0, revealCount ?? characters.length))
  // A render only projects the pending suffix. Commit records its deadline;
  // discarded/concurrent renders never consume or restart a fade window.
  const retain = (current: LiveFadeRange[], at: number): LiveFadeRange[] => !append ? [] : current
    .filter((range) => range.expiresAt > at)
    .map((range) => completesSurrogate && range.end > previousLength ? { ...range, end: previousLength } : range)
    .filter((range) => range.start < range.end)
  const retainedRanges = retain(ranges, now())
  const remainingCharacters = MAX_LIVE_FADE_CHARACTERS
    - retainedRanges.reduce((count, range) => count + range.end - range.start, 0)
  const pending = ranged && changed && start < characters.length && !reducedMotion
    && retainedRanges.length < MAX_LIVE_FADE_RANGES && remainingCharacters > 0
    ? { start, end: Math.min(characters.length, start + remainingCharacters), expiresAt: 0,
      delay: ordered?.delay ?? 0, maxDelay: ordered?.maxDelay ?? cappedDelay } : undefined
  const visibleRanges = ranged && !reducedMotion
    ? [...retainedRanges, ...(pending ? [pending] : [])] : []

  useLayoutEffect(() => {
    if (!changed || (committed.current.text === text && committed.current.mode === mode)) return
    committed.current = { text, mode, length: characters.length }
    const committedAt = now()
    setRanges((current) => {
      const retained = ranged && !reducedMotion ? retain(current, committedAt) : []
      return pending ? [...retained, { ...pending, expiresAt: committedAt
        + pending.delay + Math.min((pending.end - pending.start - 1) * stagger, pending.maxDelay)
        + duration + SCREEN_TEXT_REVEAL_CLEANUP_GRACE_MS }]
        : retained.length === current.length && retained.every((range, index) => range === current[index]) ? current : retained
    })
  }, [text, mode, changed, append, start, reducedMotion, ranged, stagger, duration])

  useLayoutEffect(() => {
    if (!ranges.length) return
    // One timer per component, not one timer per character or token. Expired
    // ranges become plain text; still-fading ranges keep their keys and delay.
    const timer = window.setTimeout(() => {
      const currentTime = now()
      setRanges((current) => current.filter((range) => range.expiresAt > currentTime))
    }, Math.max(0, Math.ceil(ranges.reduce((earliest, range) => Math.min(earliest, range.expiresAt), Infinity) - now())))
    return () => window.clearTimeout(timer)
  }, [ranges])

  const nodes: Array<ReactElement | string> = []
  let plain = ''
  let rangeIndex = 0
  characters.forEach((character, index) => {
    while (rangeIndex < visibleRanges.length && visibleRanges[rangeIndex].end <= index) rangeIndex++
    const range = visibleRanges[rangeIndex]
    const animated = !reducedMotion && (!ranged || (range && range.start <= index && index < range.end))
    if (!animated) { plain += character; return }
    if (plain) { nodes.push(plain); plain = '' }
    nodes.push(<span
      key={`${index}:${character}`}
      className={`${SCREEN_TEXT_REVEAL_CHARACTER_CLASS} ${mode === 'history'
        ? `${SCREEN_TEXT_REVEAL_HISTORY_CLASS}${ranged ? ` ${SCREEN_TEXT_REVEAL_ARMED_CLASS}` : ''}` : SCREEN_TEXT_REVEAL_LIVE_CLASS}`}
      data-screen-reveal-character="true"
      style={ranged ? { '--screen-text-reveal-delay': `${range.delay + Math.min((index - range.start) * stagger, range.maxDelay)}ms` } as CSSProperties : undefined}
      onAnimationEnd={ranged && index === range.end - 1 ? (event) => {
        if (event.animationName !== 'screen-text-reveal' || event.target !== event.currentTarget) return
        setRanges((current) => current.filter((candidate) => candidate.start !== range.start || candidate.end !== range.end))
      } : undefined}
    >{character}</span>)
  })
  if (plain) nodes.push(plain)
  return <>{nodes}</>
}

function isVisible(element: HTMLElement, containerRect: DOMRect): boolean {
  const rect = element.getBoundingClientRect()
  // Hidden <details> content reports a zero-sized rect at the document origin;
  // do not consume its reveal slot until the user actually opens it.
  return rect.width > 0
    && rect.height > 0
    && rect.bottom >= containerRect.top
    && rect.top <= containerRect.bottom
}

/**
 * Arms character reveals currently inside a scroll viewport, ordered by DOM
 * position. Lines no longer pass through here: they carry their own creation
 * time delay, so re-scans can never requeue them.
 */
export function armScreenTextReveal(container: HTMLElement, root: HTMLElement = container, containerRect?: DOMRect): void {
  const pending = [...root.querySelectorAll<HTMLElement>(
    `.${SCREEN_TEXT_REVEAL_HISTORY_CLASS}[${SCREEN_TEXT_REVEAL_ATTRIBUTE}]:not(.${SCREEN_TEXT_REVEAL_ARMED_CLASS})`
  )]
  if (pending.length === 0) return
  const bounds = containerRect ?? container.getBoundingClientRect()
  const characters = pending.filter((element) => isVisible(element, bounds))

  characters.forEach((element, index) => {
    // Re-scans happen when a detail body mounts or the viewport changes.
    // Never re-arm an existing character: that would replay the old text.
    if (element.classList.contains(SCREEN_TEXT_REVEAL_ARMED_CLASS)) return
    element.style.setProperty(
      '--screen-text-reveal-delay',
      `${Math.min(index * SCREEN_TEXT_REVEAL_STAGGER_MS, SCREEN_TEXT_REVEAL_MAX_DELAY_MS)}ms`
    )
    element.classList.add(SCREEN_TEXT_REVEAL_ARMED_CLASS)
  })
}

/** Keep newly exposed review text armable as its own scroll viewport moves. */
export function watchScreenTextReveal(container: HTMLElement, root: HTMLElement = container): () => void {
  const arm = (): void => armScreenTextReveal(container, root)
  arm()
  container.addEventListener('scroll', arm, { passive: true })
  window.addEventListener('resize', arm)
  return () => {
    container.removeEventListener('scroll', arm)
    window.removeEventListener('resize', arm)
  }
}

/** Count Unicode code points, matching RevealText's character model. */
export function characterCount(text: string): number {
  return Array.from(text).length
}

/** Return the number of newly appended characters in a streaming string. */
export function appendedCharacterCount(previous: string, current: string): number {
  if (previous === current) return 0
  const appended = current.startsWith(previous) ? current.slice(previous.length) : current
  return characterCount(appended)
}
