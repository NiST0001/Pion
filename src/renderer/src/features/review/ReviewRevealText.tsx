import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { armScreenTextReveal, RevealText } from '../../utils/screenTextReveal'

// One observer per scroll viewport, not one listener/geometry scan per character.
const observers = new WeakMap<Element, {
  observer: IntersectionObserver
  callbacks: Map<Element, () => void>
}>()

export const ReviewRevealText = memo(function ReviewRevealText({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [phase, setPhase] = useState<'waiting' | 'animating' | 'done'>('waiting')
  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setPhase('done')
      return
    }
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
  }, [])

  useLayoutEffect(() => {
    const element = ref.current
    if (phase !== 'animating' || !element) return
    const container = element.closest<HTMLElement>('.review-detail-body, .chat-scroll') ?? element
    armScreenTextReveal(container, element)
    // 180ms maximum stagger + 52ms fade, then release all character DOM nodes.
    const timer = window.setTimeout(() => setPhase('done'), 300)
    return () => window.clearTimeout(timer)
  }, [phase])

  return <span ref={ref} style={{ opacity: phase === 'waiting' ? 0 : undefined }}>
    {phase === 'animating' ? <RevealText text={text} mode="history" /> : text}
  </span>
})
