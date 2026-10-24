import { memo, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy } from 'lucide-react'
import { BROWSER_BLANK_URL, isAllowedBrowserUrl } from '../../../../shared/browser'
import { BrowserNavigationContext } from '../browser/BrowserNavigationContext'
import {
  assignLineRevealDelay,
  SCREEN_TEXT_REVEAL_CHARACTER_CLASS,
  SCREEN_TEXT_REVEAL_LINE_CLASS,
  SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS,
  SCREEN_TEXT_REVEAL_LINE_LIVE_CLASS,
  SCREEN_TEXT_REVEAL_LIVE_CLASS,
  SCREEN_TEXT_REVEAL_LIVE_DURATION_MS,
  SCREEN_TEXT_REVEAL_CLEANUP_GRACE_MS,
  SCREEN_TEXT_REVEAL_STATIC_CLASS,
  SCREEN_TEXT_REVEAL_LIVE_MAX_DELAY_MS,
  SCREEN_TEXT_REVEAL_LIVE_STAGGER_MS
} from '../../utils/screenTextReveal'
import type { TextRevealMode } from '../../utils/screenTextReveal'

type HastNode = {
  type: string
  value?: unknown
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

function hasChildren(node: HastNode): node is HastNode & { children: HastNode[] } {
  return Array.isArray(node.children)
}

function isTextNode(node: HastNode): node is HastNode & { value: string } {
  return node.type === 'text' && typeof node.value === 'string'
}

const LINE_CONTAINERS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'dt',
  'dd',
  'td',
  'th',
  'pre'
])

const BLOCK_ELEMENTS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul'
])

function cloneWithChildren(node: HastNode, children: HastNode[]): HastNode {
  return { ...node, children }
}

/** Split inline markup at source line boundaries without discarding formatting. */
function splitInlineNode(node: HastNode): HastNode[][] {
  if (isTextNode(node)) {
    return node.value.split(/\r?\n/).map((value) => value === '' ? [] : [{ ...node, value }])
  }
  if (!hasChildren(node)) return [[node]]

  const lines: HastNode[][] = [[]]
  for (const child of node.children) {
    const parts = splitInlineNode(child)
    lines[lines.length - 1].push(...parts[0])
    for (let index = 1; index < parts.length; index++) {
      lines.push(parts[index])
    }
  }
  return lines.map((children) => [cloneWithChildren(node, children)])
}

function splitInlineChildren(children: HastNode[]): HastNode[][] {
  const lines: HastNode[][] = [[]]
  for (const child of children) {
    if (child.type === 'element' && child.tagName === 'br') {
      lines.push([])
      continue
    }
    const parts = splitInlineNode(child)
    lines[lines.length - 1].push(...parts[0])
    for (let index = 1; index < parts.length; index++) {
      lines.push(parts[index])
    }
  }
  return lines
}

function lineProperties(mode: TextRevealMode): Record<string, unknown> {
  return {
    className: [
      SCREEN_TEXT_REVEAL_LINE_CLASS,
      mode === 'history'
        ? SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS
        : SCREEN_TEXT_REVEAL_LINE_LIVE_CLASS
    ]
  }
}

function lineWrapper(
  children: HastNode[],
  mode: TextRevealMode
): HastNode & { children: HastNode[] } {
  return {
    type: 'element',
    tagName: 'span',
    properties: lineProperties(mode),
    children
  }
}

// A bounded batch window, not one timer per character. A managed line may
// wait offscreen indefinitely; only its admission can start the fade clock.
interface LiveFadeBatch {
  ordinal: number
  start: number
  end: number
  schedule: { delay: number; expiresAt: number } | null
}
interface LiveTailSnapshot {
  ordinal: number
  length: number
  staticLines: ReadonlySet<number>
}
interface LiveTailTracker {
  committed: LiveTailSnapshot | null
  current: LiveTailSnapshot | null
  batches: LiveFadeBatch[]
  pending: LiveFadeBatch[]
  allowNew: boolean
  lines: Array<HastNode & { children: HastNode[] }>
}
const MAX_LIVE_FADE_BATCHES = 128
const MAX_LIVE_FADE_CHARACTERS = 4096

function wrapLiveLineChars(
  node: HastNode & { children: HastNode[] },
  state: { seen: number },
  batches?: ReadonlyMap<number, LiveFadeBatch>
): void {
  for (let index = 0; index < node.children.length; index++) {
    const child = node.children[index]
    if (isTextNode(child)) {
      const replacement: HastNode[] = Array.from(child.value).map((character, offset) => {
        const absoluteIndex = state.seen + offset
        const batch = batches?.get(absoluteIndex)
        return {
          type: 'element',
          tagName: 'span',
          properties: {
            className: [SCREEN_TEXT_REVEAL_CHARACTER_CLASS, ...(batch ? [SCREEN_TEXT_REVEAL_LIVE_CLASS] : [])],
            ...(batch ? { style: `--screen-text-reveal-delay:${(batch.schedule?.delay ?? 0) + Math.min((absoluteIndex - batch.start) * SCREEN_TEXT_REVEAL_LIVE_STAGGER_MS, SCREEN_TEXT_REVEAL_LIVE_MAX_DELAY_MS)}ms${batch.schedule ? '' : ';animation-play-state:paused'}` } : {})
          },
          children: [{ type: 'text', value: character }]
        }
      })
      state.seen += replacement.length
      node.children.splice(index, 1, ...replacement)
      index += replacement.length - 1
    } else if (hasChildren(child)) {
      wrapLiveLineChars(child, state, batches)
    }
  }
}

function textLength(node: HastNode): number {
  if (isTextNode(node)) return Array.from(node.value).length
  return node.children?.reduce((sum, child) => sum + textLength(child), 0) ?? 0
}

function hasBlockChild(node: HastNode): boolean {
  return Boolean(node.children?.some((child) => (
    child.type === 'element' && BLOCK_ELEMENTS.has(child.tagName ?? '')
  )))
}

function wrapLineTree(node: HastNode, mode: TextRevealMode, liveTail?: LiveTailTracker): void {
  if (!hasChildren(node)) return
  if (node.type === 'element' && node.tagName === 'li') {
    const properties = lineProperties(mode)
    const existingClassName = node.properties?.className
    const existingClasses = Array.isArray(existingClassName)
      ? existingClassName
      : typeof existingClassName === 'string'
        ? [existingClassName]
        : []
    node.properties = {
      ...node.properties,
      ...properties,
      className: [...existingClasses, ...(properties.className as string[])]
    }
    if (mode === 'live' && liveTail) liveTail.lines.push(node)
    return
  }
  if (
    node.type === 'element'
    && LINE_CONTAINERS.has(node.tagName ?? '')
    && !hasBlockChild(node)
  ) {
    node.children = splitInlineChildren(node.children)
      .map((children) => {
        const wrapper = lineWrapper(children, mode)
        if (mode === 'live' && liveTail) liveTail.lines.push(wrapper)
        return wrapper
      })
    return
  }
  node.children.forEach((child) => wrapLineTree(child, mode, liveTail))
}

function rehypeLineReveal(mode: TextRevealMode, liveTail?: LiveTailTracker) {
  return () => (tree: unknown): void => {
    // StrictMode can transform twice with the same projection object. Only
    // this run's draft is reset; committed batches remain read-only until layout.
    if (liveTail) {
      liveTail.lines = []
      liveTail.pending = []
      liveTail.current = null
    }
    if (typeof tree !== 'object' || tree === null) return
    const root = tree as HastNode
    wrapLineTree(root, mode, liveTail)
    if (mode !== 'live' || !liveTail || liveTail.lines.length === 0) return
    const ordinal = liveTail.lines.length - 1
    const staticLines = new Set<number>()
    liveTail.lines.forEach((line, index) => {
      // Settlement may append plain lines. Keep their eligibility after the
      // committed tail advances, including later cleanup and live renders.
      if (liveTail.committed?.staticLines.has(index)
        || (!liveTail.allowNew && index > (liveTail.committed?.ordinal ?? -1))) {
        staticLines.add(index)
        const classes = line.properties?.className as string[]
        line.properties = { ...line.properties, className: [...classes, SCREEN_TEXT_REVEAL_STATIC_CLASS] }
      }
    })
    const length = textLength(liveTail.lines[ordinal])
    const start = liveTail.committed?.ordinal === ordinal ? liveTail.committed.length : 0
    const remaining = MAX_LIVE_FADE_CHARACTERS - liveTail.batches.reduce((sum, batch) => sum + batch.end - batch.start, 0)
    if (liveTail.allowNew && length > start && remaining > 0 && liveTail.batches.length < MAX_LIVE_FADE_BATCHES) {
      liveTail.pending.push({ ordinal, start, end: Math.min(length, start + remaining), schedule: null })
    }
    // Index only the bounded active characters once. Preserve first-batch
    // precedence even when appended Markdown changes rendered text lengths.
    const batchesByLine = new Map<number, Map<number, LiveFadeBatch>>()
    for (const batch of [...liveTail.batches, ...liveTail.pending]) {
      let lineBatches = batchesByLine.get(batch.ordinal)
      if (!lineBatches) {
        lineBatches = new Map()
        batchesByLine.set(batch.ordinal, lineBatches)
      }
      for (let index = batch.start; index < batch.end; index++) {
        if (!lineBatches.has(index)) lineBatches.set(index, batch)
      }
    }
    liveTail.lines.forEach((line, lineOrdinal) => {
      const lineBatches = batchesByLine.get(lineOrdinal)
      // Keep the current tail's positional spans stable even after cleanup.
      // Completed lines retain spans only while their fades are unfinished.
      if (lineOrdinal === ordinal || lineBatches) {
        wrapLiveLineChars(line, { seen: 0 }, lineBatches)
      }
    })
    liveTail.current = { ordinal, length, staticLines }
  }
}

function CodeBlock({ children }: { children?: React.ReactNode }): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)

  const copy = useCallback(async () => {
    const text = preRef.current?.textContent ?? ''
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable - ignore
    }
  }, [])

  return (
    <div className="code-block">
      <button className="code-copy" onClick={() => void copy()} title="复制代码">
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <pre ref={preRef}>{children}</pre>
    </div>
  )
}

function hasLineRevealClass(className: unknown): boolean {
  if (typeof className === 'string') {
    return className.split(' ').includes(SCREEN_TEXT_REVEAL_LINE_CLASS)
  }
  return Array.isArray(className) && className.includes(SCREEN_TEXT_REVEAL_LINE_CLASS)
}

function BrowserMarkdownLink({ href, children }: {
  href?: string
  children?: React.ReactNode
}): React.ReactElement {
  const navigate = useContext(BrowserNavigationContext)
  if (!isAllowedBrowserUrl(href) || href === BROWSER_BLANK_URL) return <span>{children}</span>

  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault()
        if (event.button === 0) navigate?.(href)
      }}
      onAuxClick={(event) => {
        event.preventDefault()
        if (event.button === 1) navigate?.(href)
      }}
    >
      {children}
    </a>
  )
}

const MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: BrowserMarkdownLink,
  // Waterfall line wrappers carry a marker class; attach their one fixed
  // delay at commit time via a ref callback. List items are marked directly
  // (so their bullet fades too); every other element renders untouched.
  span: ({ node: _node, className, children, ...props }) => (
    <span
      {...props}
      className={className}
      ref={hasLineRevealClass(className) ? assignLineRevealDelay : undefined}
    >
      {children}
    </span>
  ),
  li: ({ node: _node, className, children, ...props }) => (
    <li
      {...props}
      className={className}
      ref={hasLineRevealClass(className) ? assignLineRevealDelay : undefined}
    >
      {children}
    </li>
  )
}

// Preserve all formatting/reveal components, but never mount URL-bearing
// elements for private, text-only transcripts. Raw HTML is skipped below.
const READ_ONLY_MARKDOWN_COMPONENTS: Components = {
  ...MARKDOWN_COMPONENTS,
  a: ({ children }) => <span>{children}</span>,
  img: ({ alt }) => <span>{alt ?? ''}</span>
}

export const Markdown = memo(function Markdown({
  text,
  readOnly = false,
  revealMode
}: {
  text: string
  readOnly?: boolean
  revealMode?: TextRevealMode
}): React.ReactElement {
  const [highlightPlugin] = useState(() => {
    // ReactMarkdown creates a processor per render; reuse this instance's
    // transformer instead of registering lowlight's languages on each cleanup.
    const transform = rehypeHighlight()
    return () => transform
  })
  const rootRef = useRef<HTMLDivElement>(null)
  const committedRef = useRef<{
    text: string
    tail: LiveTailSnapshot | null
    batches: LiveFadeBatch[]
    projection: object
  } | null>(null)
  const [, refresh] = useState(0)
  const committed = committedRef.current
  const continues = committed !== null && text.startsWith(committed.text)
  const now = performance.now()
  const batches = continues ? committed.batches.filter((batch) => !batch.schedule || batch.schedule.expiresAt > now) : []
  const allowNew = revealMode === 'live' && !readOnly
    && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  // A line's fade can outlast its characters. Keep committed live wrappers
  // (and their links) in place after settlement instead of reparenting them.
  const effectiveMode = continues && committed.tail !== null ? 'live' : revealMode
  const liveTail: LiveTailTracker = {
    committed: continues ? committed.tail : null,
    current: null, batches, pending: [], allowNew, lines: []
  }
  const projection = {}
  useLayoutEffect(() => {
    // Repeated StrictMode setup must reuse this commit, not restamp its fades.
    const snapshot = committedRef.current?.projection === projection ? committedRef.current : {
      text, tail: liveTail.current ?? (continues ? committed.tail : null),
      batches: [...liveTail.batches, ...liveTail.pending], projection
    }
    committedRef.current = snapshot
    const root = rootRef.current
    const owner = root?.closest<HTMLElement>('[data-line-reveal-owner="true"]') ?? null
    let active = true
    let timer: number | undefined
    const isCurrent = (): boolean => active && committedRef.current === snapshot
      && rootRef.current === root && Boolean(root?.isConnected)
      && (root?.closest('[data-line-reveal-owner="true"]') ?? null) === owner
    const scheduleCleanup = (): void => {
      window.clearTimeout(timer)
      const deadline = Math.min(...snapshot.batches.map((batch) => batch.schedule?.expiresAt ?? Infinity))
      if (!Number.isFinite(deadline)) return
      timer = window.setTimeout(() => {
        if (isCurrent()) refresh((value) => value + 1)
      }, Math.max(1, Math.ceil(deadline - performance.now())))
    }
    const admit = (event?: Event): void => {
      if (!isCurrent() || (event && event.target !== owner)) return
      const lines = root!.querySelectorAll<HTMLElement>(`.${SCREEN_TEXT_REVEAL_LINE_CLASS}`)
      const admittedAt = performance.now()
      let changed = false
      snapshot.batches = snapshot.batches.map((batch) => {
        if (batch.schedule) return batch
        const line = lines[batch.ordinal]
        if (!line) return batch
        const lineStart = Number(line.dataset.lineRevealStart)
        if (owner && (line.dataset.lineRevealReady !== 'true'
          || line.dataset.lineRevealStart === undefined || !Number.isFinite(lineStart))) return batch
        // Unmanaged Markdown keeps its original immediate suffix behavior.
        // A ready-but-still-queued line must also retain its future start.
        const delay = owner ? Math.max(0, lineStart - admittedAt) : 0
        changed = true
        return { ...batch, schedule: {
          delay,
          expiresAt: admittedAt + delay + SCREEN_TEXT_REVEAL_LIVE_DURATION_MS + SCREEN_TEXT_REVEAL_CLEANUP_GRACE_MS
            + Math.min((batch.end - batch.start - 1) * SCREEN_TEXT_REVEAL_LIVE_STAGGER_MS, SCREEN_TEXT_REVEAL_LIVE_MAX_DELAY_MS)
        } }
      })
      if (changed) refresh((value) => value + 1)
      scheduleCleanup()
    }
    if (snapshot.batches.some((batch) => !batch.schedule)) {
      owner?.addEventListener('pion:line-reveal', admit)
      admit()
    } else scheduleCleanup()
    return () => {
      active = false
      window.clearTimeout(timer)
      owner?.removeEventListener('pion:line-reveal', admit)
    }
  })

  return (
    <div className="markdown" ref={rootRef}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={effectiveMode
          ? [highlightPlugin, rehypeLineReveal(effectiveMode, liveTail)]
          : [highlightPlugin]}
        components={readOnly ? READ_ONLY_MARKDOWN_COMPONENTS : MARKDOWN_COMPONENTS}
        skipHtml={readOnly}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
