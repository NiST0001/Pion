import { memo, useCallback, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy } from 'lucide-react'

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

/** Memoised markdown renderer used for assistant messages. */
export const Markdown = memo(function Markdown({ text }: { text: string }): React.ReactElement {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
