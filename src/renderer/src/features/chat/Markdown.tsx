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

// A bounded batch window, not one timer per character. Deadlines are stamped
// only after commit; subsequent tokens keep the original class and delay.
interface LiveFadeBatch {
  ordinal: number
  start: number
  end: number
  expiresAt: number
}
interface LiveTailTracker {
  committed: { ordinal: number, length: number } | null
  current: { ordinal: number, length: number } | null
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
  batches: LiveFadeBatch[]
): void {
  for (let index = 0; index < node.children.length; index++) {
    const child = node.children[index]
    if (isTextNode(child)) {
      const replacement: HastNode[] = Array.from(child.value).map((character, offset) => {
        const absoluteIndex = state.seen + offset
        const batch = batches.find((candidate) => absoluteIndex >= candidate.start && absoluteIndex < candidate.end)
        return {
          type: 'element',
          tagName: 'span',
          properties: {
            className: [SCREEN_TEXT_REVEAL_CHARACTER_CLASS, ...(batch ? [SCREEN_TEXT_REVEAL_LIVE_CLASS] : [])],
            ...(batch ? { style: `--screen-text-reveal-delay:${Math.min((absoluteIndex - batch.start) * SCREEN_TEXT_REVEAL_LIVE_STAGGER_MS, SCREEN_TEXT_REVEAL_LIVE_MAX_DELAY_MS)}ms` } : {})
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
    if (typeof tree !== 'object' || tree === null) return
    const root = tree as HastNode
    wrapLineTree(root, mode, liveTail)
    if (mode !== 'live' || !liveTail || liveTail.lines.length === 0) return
    const ordinal = liveTail.lines.length - 1
    if (!liveTail.allowNew) {
      liveTail.lines.forEach((line, index) => {
        if (index > (liveTail.committed?.ordinal ?? -1)) {
          const classes = line.properties?.className as string[]
          line.properties = { ...line.properties, className: [...classes, SCREEN_TEXT_REVEAL_STATIC_CLASS] }
        }
      })
    }
    const length = textLength(liveTail.lines[ordinal])
    const start = liveTail.committed?.ordinal === ordinal ? liveTail.committed.length : 0
    const remaining = MAX_LIVE_FADE_CHARACTERS - liveTail.batches.reduce((sum, batch) => sum + batch.end - batch.start, 0)
    if (liveTail.allowNew && length > start && remaining > 0 && liveTail.batches.length < MAX_LIVE_FADE_BATCHES) {
      liveTail.pending.push({ ordinal, start, end: Math.min(length, start + remaining), expiresAt: 0 })
    }
    const batches = [...liveTail.batches, ...liveTail.pending]
    liveTail.lines.forEach((line, lineOrdinal) => {
      const lineBatches = batches.filter((batch) => batch.ordinal === lineOrdinal)
      // Keep the current tail's positional spans stable even after cleanup.
      // Completed lines retain spans only while their fades are unfinished.
      if (lineOrdinal === ordinal || lineBatches.length > 0) {
        wrapLiveLineChars(line, { seen: 0 }, lineBatches)
      }
    })
    liveTail.current = { ordinal, length }
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
  const committedRef = useRef<{
    text: string
    tail: { ordinal: number, length: number } | null
    batches: LiveFadeBatch[]
  } | null>(null)
  const [, refresh] = useState(0)
  const committed = committedRef.current
  const continues = committed !== null && text.startsWith(committed.text)
  const now = performance.now()
  const batches = continues ? committed.batches.filter((batch) => batch.expiresAt > now) : []
  const allowNew = revealMode === 'live' && !readOnly
    && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const effectiveMode = batches.length > 0 ? 'live' : revealMode
  const liveTail: LiveTailTracker = {
    committed: continues ? committed.tail : null,
    current: null, batches, pending: [], allowNew, lines: []
  }
  useLayoutEffect(() => {
    const commitTime = performance.now()
    const nextBatches = [...liveTail.batches, ...liveTail.pending.map((batch) => ({
      ...batch,
      expiresAt: commitTime + SCREEN_TEXT_REVEAL_LIVE_DURATION_MS + SCREEN_TEXT_REVEAL_CLEANUP_GRACE_MS
        + Math.min((batch.end - batch.start - 1) * SCREEN_TEXT_REVEAL_LIVE_STAGGER_MS, SCREEN_TEXT_REVEAL_LIVE_MAX_DELAY_MS)
    }))]
    committedRef.current = { text, tail: liveTail.current ?? (continues ? committed.tail : null), batches: nextBatches }
    if (nextBatches.length === 0) return
    const deadline = Math.min(...nextBatches.map((batch) => batch.expiresAt))
    const timer = window.setTimeout(() => refresh((value) => value + 1), Math.max(1, Math.ceil(deadline - performance.now())))
    return () => window.clearTimeout(timer)
  })

  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={effectiveMode
          ? [rehypeHighlight, rehypeLineReveal(effectiveMode, liveTail)]
          : [rehypeHighlight]}
        components={readOnly ? READ_ONLY_MARKDOWN_COMPONENTS : MARKDOWN_COMPONENTS}
        skipHtml={readOnly}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
