import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useDisclosureRevealReady } from '../common/DisclosureRevealGate'
import {
  appendedCharacterCount, armScreenTextReveal, RevealText,
  SCREEN_TEXT_REVEAL_DURATION_MS, SCREEN_TEXT_REVEAL_MAX_DELAY_MS,
  SCREEN_TEXT_REVEAL_CLEANUP_GRACE_MS,
  type TextRevealMode
} from '../../utils/screenTextReveal'

// Bound both initial character DOM and geometry work, including single-line
// JSON/minified output. Invisible chunks remain inexpensive ordinary text.
export const REVIEW_REVEAL_CHUNK_SIZE = 160
const observers = new WeakMap<Element, {
  observer: IntersectionObserver
  callbacks: Map<Element, () => void>
}>()

const RevealChunk = memo(function RevealChunk({ text, mode }: {
  text: string; mode: TextRevealMode
}) {
  const ready = useDisclosureRevealReady()
  const ref = useRef<HTMLSpanElement>(null)
  const [reducedMotion] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  const [phase, setPhase] = useState<'waiting' | 'animating' | 'done'>(reducedMotion ? 'done' : 'waiting')
  const previousText = useRef(text)
  const hasAnimated = useRef(false)
  // Authoritative replacements cannot keep obsolete text/geometry, even if
  // that means ending old fades. Defer their character allocation until release.
  const replacementWaiting = !ready && hasAnimated.current && !text.startsWith(previousText.current)
  // A closed gate must not commit incoming tokens to RevealText: it owns the
  // still-running fades, and must see the entire deferred suffix on release.
  const animationText = !ready && hasAnimated.current ? previousText.current : text
  const deferredText = !ready && hasAnimated.current && text.startsWith(animationText)
    ? text.slice(animationText.length) : ''
  const revealCount = hasAnimated.current ? appendedCharacterCount(previousText.current, animationText) : undefined
  useEffect(() => {
    const element = ref.current
    if (!element || reducedMotion || !ready || phase !== 'waiting') return
    // Keep the outer conversation/review as root: IntersectionObserver then
    // accounts for nested output scrollers and horizontal diff clipping too.
    const root = element.closest('.review-detail-body, .chat-scroll') ?? element.parentElement
    if (!root || typeof IntersectionObserver === 'undefined') {
      setPhase('animating')
      return
    }
    let group = observers.get(root)
    if (!group) {
      const callbacks = new Map<Element, () => void>()
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          callbacks.get(entry.target)?.()
          callbacks.delete(entry.target)
          observer.unobserve(entry.target)
        }
      }, { root })
      group = { observer, callbacks }
      observers.set(root, group)
    }
    const observedGroup = group
    observedGroup.callbacks.set(element, () => setPhase('animating'))
    observedGroup.observer.observe(element)
    return () => {
      observedGroup.callbacks.delete(element)
      observedGroup.observer.unobserve(element)
      if (observedGroup.callbacks.size === 0) {
        observedGroup.observer.disconnect()
        if (observers.get(root) === observedGroup) observers.delete(root)
      }
    }
  }, [reducedMotion, ready, phase])

  useLayoutEffect(() => {
    // Only consume text actually offered to the animation. Waiting chunks
    // release their full current text; played chunks release only new suffixes.
    if (!ready || reducedMotion || phase === 'waiting') return
    if (phase === 'done' && previousText.current !== text) {
      setPhase('animating')
      return
    }
    if (phase === 'animating') previousText.current = text
  }, [text, phase, reducedMotion, ready])

  useLayoutEffect(() => {
    const element = ref.current
    if (phase !== 'animating' || !element) return
    hasAnimated.current = true
    if (mode === 'history') {
      const container = element.closest<HTMLElement>('.review-detail-body, .chat-scroll') ?? element
      armScreenTextReveal(container, element)
    }
    // Live RevealText owns its independent suffix windows. Keep it mounted so
    // another token cannot recycle an older fade before that fade completes.
    if (mode === 'live') return
    const timer = window.setTimeout(() => setPhase('done'),
      SCREEN_TEXT_REVEAL_MAX_DELAY_MS + SCREEN_TEXT_REVEAL_DURATION_MS + SCREEN_TEXT_REVEAL_CLEANUP_GRACE_MS)
    return () => window.clearTimeout(timer)
  }, [phase, animationText, mode])

  return <span ref={ref} style={{ opacity: phase === 'waiting' || replacementWaiting ? 0 : undefined }}
    onAnimationEnd={(event) => {
      // Earlier characters finish first; only the final fading character can
      // reclaim the whole chunk without interrupting its remaining suffix.
      if (mode === 'history' && event.animationName === 'screen-text-reveal'
        && event.target === ref.current?.lastElementChild) setPhase('done')
    }}>
    {replacementWaiting ? text : phase === 'animating'
      ? <><RevealText text={animationText} mode={mode} revealCount={revealCount} />
        {deferredText && <span style={{ opacity: 0 }}>{deferredText}</span>}</>
      : deferredText
        ? <>{animationText}<span style={{ opacity: 0 }}>{deferredText}</span></>
        : text}
  </span>
})

/** Shared by review diffs and tool output; keep stable chunks on live append. */
export const ReviewRevealText = memo(function ReviewRevealText({ text, mode = 'history' }: {
  text: string; mode?: TextRevealMode
}) {
  const characters = useMemo(() => Array.from(text), [text])
  const chunks = useMemo(() => {
    const result: string[] = []
    for (let start = 0; start < characters.length; start += REVIEW_REVEAL_CHUNK_SIZE) {
      result.push(characters.slice(start, start + REVIEW_REVEAL_CHUNK_SIZE).join(''))
    }
    return result
  }, [characters])
  return <>{chunks.map((chunk, index) => <RevealChunk key={index} text={chunk} mode={mode} />)}</>
})
