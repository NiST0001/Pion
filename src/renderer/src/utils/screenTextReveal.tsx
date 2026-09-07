import type { CSSProperties, ReactElement } from 'react'

export const SCREEN_TEXT_REVEAL_ATTRIBUTE = 'data-screen-reveal-character'
export const SCREEN_TEXT_REVEAL_CHARACTER_CLASS = 'screen-text-reveal-character'
export const SCREEN_TEXT_REVEAL_HISTORY_CLASS = 'screen-text-reveal-history'
export const SCREEN_TEXT_REVEAL_LIVE_CLASS = 'screen-text-reveal-live'
export const SCREEN_TEXT_REVEAL_ARMED_CLASS = 'screen-text-reveal-armed'
export const SCREEN_TEXT_REVEAL_LINE_CLASS = 'screen-text-reveal-line'
export const SCREEN_TEXT_REVEAL_LINE_LIVE_CLASS = 'screen-text-reveal-line-live'
export const SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS = 'screen-text-reveal-line-history'
export const SCREEN_TEXT_REVEAL_STATIC_CLASS = 'screen-text-reveal-static'
// Five times faster than the original 6ms / 260ms reveal while retaining a
// small left-to-right cue on long messages.
export const SCREEN_TEXT_REVEAL_STAGGER_MS = 1.2
export const SCREEN_TEXT_REVEAL_MAX_DELAY_MS = 180
export const SCREEN_TEXT_REVEAL_LINE_STAGGER_MS = 20
export type TextRevealMode = 'history' | 'live'

let nextLineRevealAt = 0

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/**
 * Take the next slot on the single global waterfall clock. Called from ref
 * callbacks at commit time (never during render), so discarded renders cannot
 * burn slots and re-renders can never requeue a line. An idle clock restarts
 * at the next new line; a busy clock queues behind the last scheduled line.
 */
export function takeLineRevealSlot(): number {
  const currentTime = now()
  if (nextLineRevealAt <= currentTime) nextLineRevealAt = currentTime
  const delay = Math.max(0, Math.round(nextLineRevealAt - currentTime))
  nextLineRevealAt = Math.max(nextLineRevealAt, currentTime) + SCREEN_TEXT_REVEAL_LINE_STAGGER_MS
  return delay
}

/** Reset the waterfall clock (session switches start a fresh cascade). */
export function resetLineRevealClock(): void {
  nextLineRevealAt = 0
}

/**
 * Assign waterfall delays to pending history lines, continuing the shared
 * clock. Only the bottom two viewport heights animate: everything older
 * appears instantly, so opening a long session never makes the user wait
 * through a full-history cascade.
 */
export function assignPendingLineDelays(container: HTMLElement): void {
  const pending = [...container.querySelectorAll<HTMLElement>(
    `.${SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS}:not([data-line-reveal-ready="true"])`
  )]
  if (pending.length === 0) return

  const containerRect = container.getBoundingClientRect()
  const windowTop = containerRect.bottom - containerRect.height * 2
  const currentTime = now()
  if (nextLineRevealAt <= currentTime) nextLineRevealAt = currentTime
  for (const element of pending) {
    element.dataset.lineRevealReady = 'true'
    if (element.getBoundingClientRect().bottom < windowTop) {
      element.classList.add(SCREEN_TEXT_REVEAL_STATIC_CLASS)
      continue
    }
    const delay = Math.max(0, Math.round(nextLineRevealAt - currentTime))
    element.style.setProperty('--screen-text-reveal-delay', `${delay}ms`)
    nextLineRevealAt += SCREEN_TEXT_REVEAL_LINE_STAGGER_MS
  }
}

/**
 * Ref callback for waterfall line elements. History lines (class
 * line-history) are left for the DOM-order settle scan so paged batches join
 * one clean cascade; live lines (streaming output, newly sent messages) take
 * a clock slot immediately at attach.
 */
export function assignLineRevealDelay(element: HTMLElement | null): void {
  if (!element || element.dataset.lineRevealReady === 'true') return
  if (element.classList.contains(SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS)) return
  element.dataset.lineRevealReady = 'true'
  element.style.setProperty('--screen-text-reveal-delay', `${takeLineRevealSlot()}ms`)
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
  if (container.classList.contains(SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS)) return
  container.dataset.lineRevealReady = 'true'
  const firstLine = container.querySelector<HTMLElement>('[data-line-reveal-ready="true"]')
  const delay = firstLine?.style.getPropertyValue('--screen-text-reveal-delay')
  container.style.setProperty('--screen-text-reveal-delay', delay || '0ms')
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

export function RevealText({
  text,
  mode,
  revealCount
}: {
  text: string
  mode: TextRevealMode
  /** For live output, only the newest characters receive the animation. */
  revealCount?: number
}): ReactElement {
  const characters = Array.from(text)
  const start = mode === 'history'
    ? 0
    : Math.max(0, characters.length - Math.max(0, revealCount ?? characters.length))

  return (
    <>
      {characters.map((character, index) => {
        const animated = index >= start
        const delayIndex = index - start
        const style = animated && mode === 'live'
          ? { '--screen-text-reveal-delay': `${Math.min(delayIndex * SCREEN_TEXT_REVEAL_STAGGER_MS, SCREEN_TEXT_REVEAL_MAX_DELAY_MS)}ms` } as CSSProperties
          : undefined
        return (
          <span
            key={`${index}:${character}`}
            className={`${SCREEN_TEXT_REVEAL_CHARACTER_CLASS} ${mode === 'history'
              ? SCREEN_TEXT_REVEAL_HISTORY_CLASS
              : animated
                ? SCREEN_TEXT_REVEAL_LIVE_CLASS
                : ''}`.trim()}
            data-screen-reveal-character={animated ? 'true' : undefined}
            style={style}
          >
            {character}
          </span>
        )
      })}
    </>
  )
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
export function armScreenTextReveal(container: HTMLElement, root: HTMLElement = container): void {
  const containerRect = container.getBoundingClientRect()
  const characters = [...root.querySelectorAll<HTMLElement>(`[${SCREEN_TEXT_REVEAL_ATTRIBUTE}]`)]
    .filter((element) => (
      element.classList.contains(SCREEN_TEXT_REVEAL_HISTORY_CLASS)
      && isVisible(element, containerRect)
    ))

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
