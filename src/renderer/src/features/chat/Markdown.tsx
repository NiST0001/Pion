import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy } from 'lucide-react'
import {
  assignLineRevealDelay,
  SCREEN_TEXT_REVEAL_CHARACTER_CLASS,
  SCREEN_TEXT_REVEAL_LINE_CLASS,
  SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS,
  SCREEN_TEXT_REVEAL_LINE_LIVE_CLASS,
  SCREEN_TEXT_REVEAL_LIVE_CLASS,
  SCREEN_TEXT_REVEAL_MAX_DELAY_MS,
  SCREEN_TEXT_REVEAL_STAGGER_MS
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

/** Per-render line character bookkeeping for live mode. `committed` holds the
    character counts from the last commit; `next` collects this render. The
    ref is written only in a layout effect, keeping render side-effect free. */
interface LiveCharTracker {
  committed: number[]
  next: number[]
}

/** Wrap every character of a live line in a stable per-position span; only
    characters beyond the committed count carry the fade class. */
function wrapLiveLineChars(
  node: HastNode & { children: HastNode[] },
  state: { seen: number },
  startFrom: number
): void {
  for (let index = 0; index < node.children.length; index++) {
    const child = node.children[index]
    if (isTextNode(child)) {
      const replacement: HastNode[] = Array.from(child.value).map((character, offset) => {
        const absoluteIndex = state.seen + offset
        const isNew = absoluteIndex >= startFrom
        return {
          type: 'element',
          tagName: 'span',
          properties: {
            className: [
              SCREEN_TEXT_REVEAL_CHARACTER_CLASS,
              ...(isNew ? [SCREEN_TEXT_REVEAL_LIVE_CLASS] : [])
            ],
            ...(isNew
              ? { style: `--screen-text-reveal-delay:${Math.min((absoluteIndex - startFrom) * SCREEN_TEXT_REVEAL_STAGGER_MS, SCREEN_TEXT_REVEAL_MAX_DELAY_MS)}ms` }
              : {})
          },
          children: [{ type: 'text', value: character }]
        }
      })
      state.seen += replacement.length
      node.children.splice(index, 1, ...replacement)
      index += replacement.length - 1
    } else if (hasChildren(child)) {
      wrapLiveLineChars(child, state, startFrom)
    }
  }
}

function wrapLiveLine(node: HastNode & { children: HastNode[] }, tracker: LiveCharTracker): void {
  const ordinal = tracker.next.length
  const startFrom = tracker.committed[ordinal] ?? 0
  const state = { seen: 0 }
  wrapLiveLineChars(node, state, startFrom)
  tracker.next.push(state.seen)
}

function hasBlockChild(node: HastNode): boolean {
  return Boolean(node.children?.some((child) => (
    child.type === 'element' && BLOCK_ELEMENTS.has(child.tagName ?? '')
  )))
}

function wrapLineTree(node: HastNode, mode: TextRevealMode, liveChars?: LiveCharTracker): void {
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
    if (mode === 'live' && liveChars) wrapLiveLine(node, liveChars)
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
        if (mode === 'live' && liveChars) wrapLiveLine(wrapper, liveChars)
        return wrapper
      })
    return
  }
  node.children.forEach((child) => wrapLineTree(child, mode, liveChars))
}

function rehypeLineReveal(mode: TextRevealMode, liveChars?: LiveCharTracker) {
  return () => (tree: unknown): void => {
    if (typeof tree !== 'object' || tree === null) return
    const root = tree as HastNode
    wrapLineTree(root, mode, liveChars)
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

const MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
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

export const Markdown = memo(function Markdown({
  text,
  revealMode
}: {
  text: string
  revealMode?: TextRevealMode
}): React.ReactElement {
  // Live mode additionally fades newly streamed characters within each line.
  // The committed counts are read during render and written back only after
  // commit, so StrictMode double renders cannot skip or replay the fade.
  const committedLineCharsRef = useRef<number[]>([])
  const nextLineChars: number[] = []
  useLayoutEffect(() => {
    committedLineCharsRef.current = nextLineChars
  })

  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={revealMode
          ? [rehypeHighlight, rehypeLineReveal(revealMode, { committed: committedLineCharsRef.current, next: nextLineChars })]
          : [rehypeHighlight]}
        components={MARKDOWN_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
