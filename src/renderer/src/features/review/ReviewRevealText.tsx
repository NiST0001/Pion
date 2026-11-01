import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useDisclosureRevealReady } from '../common/DisclosureRevealGate'
import { RevealText, type TextRevealMode } from '../../utils/screenTextReveal'
import { retireTextRevealTail, subscribeTextRevealOrder, type OrderedTextReveal } from '../../utils/textRevealOrder'
import { textRevealRoot } from '../../utils/textRevealRoot'

// Bound both initial character DOM and geometry work, including single-line
// JSON/minified output. Invisible chunks remain inexpensive ordinary text.
export const REVIEW_REVEAL_CHUNK_SIZE = 160
export const REVIEW_REVEAL_COARSE_SIZE = 8192

/** A streamed low surrogate may complete the last committed code point. */
function safePrefixLength(text: string, prefix: string): number {
  if (!text.startsWith(prefix)) return 0
  const end = prefix.length
  const before = text.charCodeAt(end - 1)
  const after = text.charCodeAt(end)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? end - 1 : end
}

const RevealChunk = memo(function RevealChunk({ text, mode }: {
  text: string; mode: TextRevealMode
}) {
  const ready = useDisclosureRevealReady()
  const ref = useRef<HTMLSpanElement>(null)
  const [reducedMotion] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  const [admitted, setAdmitted] = useState<{ text: string; mode: TextRevealMode; ordered: OrderedTextReveal } | null>(null)
  const subscription = useRef<ReturnType<typeof subscribeTextRevealOrder> | null>(null)
  const append = admitted?.mode === mode && text.startsWith(admitted.text)
  const animation = append ? admitted : null
  const stamped = useRef<typeof admitted>(null)
  const pending = useRef<{ text: string; mode: TextRevealMode; lineage: object } | null>(null)

  // Track only committed pending content. An interrupted render must not
  // replace the identity of the request currently awaiting admission.
  useLayoutEffect(() => {
    const previous = pending.current
    if (!previous) return
    if (previous.mode !== mode || !text.startsWith(previous.text)) pending.current = null
    else previous.text = text
  }, [text, mode])

  useLayoutEffect(() => {
    if (!animation || stamped.current === animation || !ref.current) return
    stamped.current = animation
    // Publish only after the admitted character DOM commits. Later lines must
    // not overtake a visible predecessor still waiting for React/its root clock.
    ref.current.dataset.textRevealStart = String(performance.now() + animation.ordered.delay)
  }, [animation])

  useLayoutEffect(() => {
    if (admitted && !append) {
      if (ref.current) retireTextRevealTail(ref.current)
      setAdmitted(null)
    }
  }, [admitted, append])

  useLayoutEffect(() => {
    const element = ref.current
    if (!element || reducedMotion || !ready) return
    const owned = subscribeTextRevealOrder(element)
    subscription.current = owned
    return () => {
      owned.dispose()
      if (subscription.current === owned) subscription.current = null
    }
  }, [reducedMotion, ready])

  useLayoutEffect(() => {
    const owned = subscription.current
    if (!owned || !ready || reducedMotion) return
    if (animation?.text === text) { owned.wait(null); return }
    // Count only the bounded pending suffix. A low surrogate completing the
    // prior code point must also get a slot, without replaying earlier text.
    let count = 0
    for (const _character of text.slice(animation ? safePrefixLength(text, animation.text) : 0)) count++
    const current = pending.current ?? { text, mode, lineage: {} }
    pending.current = current
    owned.wait({ count, mode, lineage: current.lineage, admit: ordered => {
      if (pending.current === current) pending.current = null
      setAdmitted({ text, mode, ordered })
    } })
    return () => owned.wait(null)
  }, [text, mode, animation, ready, reducedMotion])

  // RevealText alone owns character ranges and their original deadlines. Keep
  // the admitted instance/text untouched while a new suffix waits for geometry,
  // disclosure or its parent line. Replacements discard invalid old fades now.
  return <span ref={ref}
    data-text-reveal-pending={!reducedMotion && text !== '' && animation?.text !== text ? 'true' : undefined}
    style={{ opacity: !reducedMotion && !animation ? 0 : undefined }}>
    {reducedMotion ? text : animation ? <>
      <RevealText text={animation.text} mode={animation.mode} ordered={animation.ordered}
        cleanupRoot={ref.current ? textRevealRoot(ref.current) : null} />
      {text.length > animation.text.length && <span style={{ opacity: 0 }}>{text.slice(animation.text.length)}</span>}
    </> : text}
  </span>
})

function useTextChunks(text: string, size: number): string[] {
  const committed = useRef({ text: '', chunks: [] as string[] })
  const chunks = useMemo(() => {
    const previous = committed.current
    const append = text.startsWith(previous.text)
    const result = append ? previous.chunks.slice(0, -1) : []
    // Revisit the old tail so a streamed low surrogate joins its high half.
    const tail = append ? (previous.chunks.at(-1) ?? '') + text.slice(previous.text.length) : text
    let start = 0, offset = 0, count = 0
    for (const character of tail) {
      offset += character.length
      if (++count === size) {
        result.push(tail.slice(start, offset))
        start = offset
        count = 0
      }
    }
    if (start < offset) result.push(tail.slice(start, offset))
    return result
  }, [text, size])
  useLayoutEffect(() => { committed.current = { text, chunks } }, [text, chunks])
  return chunks
}

function FineChunks({ text, mode }: { text: string; mode: TextRevealMode }) {
  const chunks = useTextChunks(text, REVIEW_REVEAL_CHUNK_SIZE)
  return <>{chunks.map((chunk, index) => <RevealChunk key={index} text={chunk} mode={mode} />)}</>
}

function selectionIntersects(element: HTMLElement): boolean {
  const selection = element.ownerDocument.getSelection()
  if (!selection || selection.isCollapsed) return false
  for (let i = 0; i < selection.rangeCount; i++) {
    if (selection.getRangeAt(i).intersectsNode(element)) return true
  }
  return false
}

const CoarseChunk = memo(function CoarseChunk({ text, mode }: { text: string; mode: TextRevealMode }) {
  const ready = useDisclosureRevealReady()
  const ref = useRef<HTMLSpanElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [reducedMotion] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element || expanded || reducedMotion || !ready) return
    const owned = subscribeTextRevealOrder(element)
    let active = true, listening = false
    const stopListening = () => {
      if (listening) element.ownerDocument.removeEventListener('selectionchange', onSelectionChange)
      listening = false
    }
    const request = {
      count: 0 as const, mode, prepare: true as const,
      admit: () => {
        if (!active || ref.current !== element) return false
        if (selectionIntersects(element)) {
          if (!listening) {
            element.ownerDocument.addEventListener('selectionchange', onSelectionChange)
            listening = true
          }
          return false
        }
        stopListening()
        // Commit the fine pending markers before another root scan can run.
        flushSync(() => setExpanded(true))
        return true
      }
    }
    function onSelectionChange() {
      if (!element || !active || ref.current !== element || selectionIntersects(element)) return
      stopListening()
      owned.wait(request)
    }
    owned.wait(request)
    return () => { active = false; stopListening(); owned.dispose() }
  }, [expanded, mode, ready, reducedMotion])

  return <span ref={ref} data-text-reveal-coarse="true"
    data-text-reveal-pending={!reducedMotion && !expanded && text !== '' ? 'true' : undefined}
    style={{ opacity: !reducedMotion && !expanded ? 0 : undefined }}>
    {expanded ? <FineChunks text={text} mode={mode} /> : text}
  </span>
})

/** Freeze the initial structure so later streaming never reparents active fades. */
export const ReviewRevealText = memo(function ReviewRevealText({ text, mode = 'history', deferOffscreen = false }: {
  text: string; mode?: TextRevealMode
  /** Opt in only for the non-wrapping diff/code surfaces measured by the fixture. */
  deferOffscreen?: boolean
}) {
  const [coarse] = useState(() => {
    if (!deferOffscreen) return false
    let count = 0
    for (const _character of text) if (++count >= REVIEW_REVEAL_COARSE_SIZE) return true
    return false
  })
  const chunks = useTextChunks(text, coarse ? REVIEW_REVEAL_COARSE_SIZE : REVIEW_REVEAL_CHUNK_SIZE)
  return <>{chunks.map((chunk, index) => coarse
    ? <CoarseChunk key={index} text={chunk} mode={mode} />
    : <RevealChunk key={index} text={chunk} mode={mode} />)}</>
})
