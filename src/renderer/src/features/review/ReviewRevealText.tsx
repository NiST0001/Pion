import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useDisclosureRevealReady } from '../common/DisclosureRevealGate'
import { RevealText, type TextRevealMode } from '../../utils/screenTextReveal'
import { subscribeTextRevealOrder, type OrderedTextReveal } from '../../utils/textRevealOrder'

// Bound both initial character DOM and geometry work, including single-line
// JSON/minified output. Invisible chunks remain inexpensive ordinary text.
export const REVIEW_REVEAL_CHUNK_SIZE = 160

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

  useLayoutEffect(() => {
    if (!animation || stamped.current === animation || !ref.current) return
    stamped.current = animation
    // Publish only after the admitted character DOM commits. Later lines must
    // not overtake a visible predecessor still waiting for React/its root clock.
    ref.current.dataset.textRevealStart = String(performance.now() + animation.ordered.delay)
  }, [animation])

  useLayoutEffect(() => {
    if (admitted && !append) setAdmitted(null)
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
    owned.wait({ count, mode, admit: ordered => setAdmitted({ text, mode, ordered }) })
    return () => owned.wait(null)
  }, [text, mode, animation, ready, reducedMotion])

  // RevealText alone owns character ranges and their original deadlines. Keep
  // the admitted instance/text untouched while a new suffix waits for geometry,
  // disclosure or its parent line. Replacements discard invalid old fades now.
  return <span ref={ref}
    data-text-reveal-pending={!reducedMotion && text !== '' && animation?.text !== text ? 'true' : undefined}
    style={{ opacity: !reducedMotion && !animation ? 0 : undefined }}>
    {reducedMotion ? text : animation ? <>
      <RevealText text={animation.text} mode={animation.mode} ordered={animation.ordered} />
      {text.length > animation.text.length && <span style={{ opacity: 0 }}>{text.slice(animation.text.length)}</span>}
    </> : text}
  </span>
})

/** Shared by review diffs and tool output; keep stable chunks on live append. */
export const ReviewRevealText = memo(function ReviewRevealText({ text, mode = 'history' }: {
  text: string; mode?: TextRevealMode
}) {
  const committed = useRef({ text: '', chunks: [] as string[] })
  const chunks = useMemo(() => {
    const previous = committed.current
    const append = text.startsWith(previous.text)
    const result = append ? previous.chunks.slice(0, -1) : []
    // Revisit only the old tail, even when full: its last high surrogate may
    // combine with the appended low surrogate. Complete earlier chunks stay put.
    const characters = Array.from(append
      ? (previous.chunks.at(-1) ?? '') + text.slice(previous.text.length) : text)
    for (let start = 0; start < characters.length; start += REVIEW_REVEAL_CHUNK_SIZE) {
      result.push(characters.slice(start, start + REVIEW_REVEAL_CHUNK_SIZE).join(''))
    }
    return result
  }, [text])
  useLayoutEffect(() => { committed.current = { text, chunks } }, [text, chunks])
  return <>{chunks.map((chunk, index) => <RevealChunk key={index} text={chunk} mode={mode} />)}</>
})
