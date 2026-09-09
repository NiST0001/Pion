import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { appendedCharacterCount, armScreenTextReveal, RevealText, type TextRevealMode } from '../../utils/screenTextReveal'

// Bound both initial character DOM and geometry work, including single-line
// JSON/minified output. Invisible chunks remain inexpensive ordinary text.
export const REVIEW_REVEAL_CHUNK_SIZE = 160
const observers = new WeakMap<Element, {
  observer: IntersectionObserver
  callbacks: Map<Element, () => void>
}>()

const RevealChunk = memo(function RevealChunk({ text, mode, revealCount }: {
  text: string; mode: TextRevealMode; revealCount: number
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const [reducedMotion] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  const [phase, setPhase] = useState<'waiting' | 'animating' | 'done'>(reducedMotion ? 'done' : 'waiting')
  const previousText = useRef(text)
  const hasAnimated = useRef(false)
  useEffect(() => {
    const element = ref.current
    if (!element || reducedMotion) return
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
  }, [reducedMotion])

  useLayoutEffect(() => {
    if (previousText.current === text) return
    previousText.current = text
    // Streaming updates to a visible chunk animate only its appended suffix;
    // unseen chunks still wait for their first intersection.
    if (!reducedMotion && phase !== 'waiting') setPhase('animating')
  }, [text, phase, reducedMotion])

  useLayoutEffect(() => {
    const element = ref.current
    if (phase !== 'animating' || !element) return
    hasAnimated.current = true
    if (mode === 'history') {
      const container = element.closest<HTMLElement>('.review-detail-body, .chat-scroll') ?? element
      armScreenTextReveal(container, element)
    }
    // 180ms maximum stagger + 52ms fade; release spans and animation state.
    const timer = window.setTimeout(() => setPhase('done'), 300)
    return () => window.clearTimeout(timer)
  }, [phase, text, mode])

  return <span ref={ref} style={{ opacity: phase === 'waiting' ? 0 : undefined }}>
    {phase === 'animating'
      ? <RevealText text={text} mode={mode} revealCount={hasAnimated.current ? revealCount : undefined} />
      : text}
  </span>
})

/** Shared by review diffs and tool output; keep stable chunks on live append. */
export const ReviewRevealText = memo(function ReviewRevealText({ text, mode = 'history' }: {
  text: string; mode?: TextRevealMode
}) {
  const previousText = useRef('')
  const characters = useMemo(() => Array.from(text), [text])
  const chunks = useMemo(() => {
    const result: string[] = []
    for (let start = 0; start < characters.length; start += REVIEW_REVEAL_CHUNK_SIZE) {
      result.push(characters.slice(start, start + REVIEW_REVEAL_CHUNK_SIZE).join(''))
    }
    return result
  }, [characters])
  const start = mode === 'live' ? characters.length - appendedCharacterCount(previousText.current, text) : 0
  useLayoutEffect(() => { previousText.current = text }, [text])
  return <>{chunks.map((chunk, index) => <RevealChunk key={index} text={chunk} mode={mode}
    revealCount={Math.max(0, Math.min(characters.length, (index + 1) * REVIEW_REVEAL_CHUNK_SIZE) - Math.max(start, index * REVIEW_REVEAL_CHUNK_SIZE))} />)}</>
})
