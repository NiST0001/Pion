import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { ReviewRevealText } from './ReviewRevealText'
import { DIFF_PAGE_SIZE, DiffPagination } from './DiffPagination'

export { DIFF_PAGE_SIZE } from './DiffPagination'

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
function parseDiffLine(raw: string): DiffLine {
  const marker = raw[0]
  const rest = raw.slice(1)
  if (marker === '+') {
    const gap = rest.indexOf(' ')
    return { kind: 'add', num: gap === -1 ? '' : rest.slice(0, gap), text: rest.slice(gap + 1) }
  } else if (marker === '-') {
    const gap = rest.indexOf(' ')
    return { kind: 'del', num: gap === -1 ? '' : rest.slice(0, gap), text: rest.slice(gap + 1) }
  } else if (rest.trim() === '...' || rest.trim() === '' || /^\.+$/.test(rest.trim())) {
    return { kind: 'gap', num: '', text: '' }
  }
  const gap = rest.indexOf(' ')
  return { kind: 'ctx', num: gap === -1 ? '' : rest.slice(0, gap), text: rest.slice(gap + 1) }
}

interface DiffIndex {
  diff: string
  starts: number[]
}

function indexDiff(diff: string, previous: DiffIndex | null): DiffIndex {
  const append = previous !== null && diff.startsWith(previous.diff)
  const starts = append ? previous.starts.slice() : []
  let offset = append ? previous.diff.length : 0
  // The previous final nonempty line is already indexed; resume after its newline.
  if (append && offset > 0 && previous.diff[offset - 1] !== '\n') {
    const newline = diff.indexOf('\n', offset)
    offset = newline === -1 ? diff.length : newline + 1
  }
  while (offset < diff.length) {
    const newline = diff.indexOf('\n', offset)
    const end = newline === -1 ? diff.length : newline
    if (end > offset) starts.push(offset)
    offset = end + 1
  }
  return { diff, starts }
}

export const DiffView = memo(function DiffView({
  diff,
  dense = false,
  reveal = false
}: {
  diff: string
  dense?: boolean
  reveal?: boolean
}): ReactElement {
  const committedIndex = useRef<DiffIndex | null>(null)
  const index = useMemo(() => indexDiff(diff, committedIndex.current), [diff])
  useLayoutEffect(() => { committedIndex.current = index }, [index])
  const [page, setPage] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pageCount = Math.max(1, Math.ceil(index.starts.length / DIFF_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const start = currentPage * DIFF_PAGE_SIZE
  const lines = useMemo(() => index.starts.slice(start, start + DIFF_PAGE_SIZE).map((offset) => {
    const end = diff.indexOf('\n', offset)
    return parseDiffLine(diff.slice(offset, end === -1 ? diff.length : end))
  }), [index, diff, start])
  useLayoutEffect(() => { setPage((value) => Math.min(value, pageCount - 1)) }, [pageCount])
  useLayoutEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0 }, [currentPage])

  return (
    <div className={`diff-view${dense ? ' diff-dense' : ''}`}>
      <DiffPagination page={currentPage} pageCount={pageCount} totalLines={index.starts.length} onPageChange={setPage} />
      <div className="diff-table-scroll" ref={scrollRef}>
      <table>
        <tbody>
          {lines.map((line, i) => (
            <tr key={start + i} className={`diff-${line.kind}`}>
              <td className="diff-num">{line.num}</td>
              <td className="diff-marker">
                {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ''}
              </td>
              <td className="diff-text">
                {line.kind === 'gap' ? (
                  reveal ? <ReviewRevealText text="⋯" /> : <span className="diff-gap">⋯</span>
                ) : line.text ? (
                  reveal ? <ReviewRevealText key={line.text} text={line.text} deferOffscreen /> : line.text
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
