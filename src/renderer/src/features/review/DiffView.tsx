import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { ReviewRevealText } from './ReviewRevealText'

interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'gap'
  num: string
  text: string
}

/**
 * Parse pi's display diff format:
 *   `+<newLineNum> <text>`  added
 *   `-<oldLineNum> <text>`  removed
 *   ` <num> <text>`         context
 *   ` <spaces> ...`         skipped lines
 */
function parseDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = []
  for (const raw of diff.split('\n')) {
    if (raw === '') continue
    const marker = raw[0]
    const rest = raw.slice(1)
    if (marker === '+') {
      const gap = rest.indexOf(' ')
      lines.push({ kind: 'add', num: gap === -1 ? '' : rest.slice(0, gap), text: rest.slice(gap + 1) })
    } else if (marker === '-') {
      const gap = rest.indexOf(' ')
      lines.push({ kind: 'del', num: gap === -1 ? '' : rest.slice(0, gap), text: rest.slice(gap + 1) })
    } else if (rest.trim() === '...' || rest.trim() === '' || /^\.+$/.test(rest.trim())) {
      lines.push({ kind: 'gap', num: '', text: '' })
    } else {
      const gap = rest.indexOf(' ')
      lines.push({ kind: 'ctx', num: gap === -1 ? '' : rest.slice(0, gap), text: rest.slice(gap + 1) })
    }
  }
  return lines
}

export const DIFF_PAGE_SIZE = 120

export const DiffView = memo(function DiffView({
  diff,
  dense = false,
  reveal = false
}: {
  diff: string
  dense?: boolean
  reveal?: boolean
}): ReactElement {
  const lines = useMemo(() => parseDiff(diff), [diff])
  const [page, setPage] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pageCount = Math.max(1, Math.ceil(lines.length / DIFF_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const start = currentPage * DIFF_PAGE_SIZE
  useLayoutEffect(() => { setPage((value) => Math.min(value, pageCount - 1)) }, [pageCount])
  useLayoutEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0 }, [currentPage])

  return (
    <div className={`diff-view${dense ? ' diff-dense' : ''}`}>
      {pageCount > 1 && <div className="diff-page-controls" role="group" aria-label="差异分页">
        <span>第 {currentPage + 1} / {pageCount} 页 · 共 {lines.length} 行</span>
        <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button>
        <button type="button" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>下一页</button>
      </div>}
      <div className="diff-table-scroll" ref={scrollRef}>
      <table>
        <tbody>
          {lines.slice(start, start + DIFF_PAGE_SIZE).map((line, i) => (
            <tr key={start + i} className={`diff-${line.kind}`}>
              <td className="diff-num">{line.num}</td>
              <td className="diff-marker">
                {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ''}
              </td>
              <td className="diff-text">
                {line.kind === 'gap' ? (
                  reveal ? <ReviewRevealText text="⋯" /> : <span className="diff-gap">⋯</span>
                ) : line.text ? (
                  reveal ? <ReviewRevealText key={line.text} text={line.text} /> : line.text
                ) : '\u00a0'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  )
})
