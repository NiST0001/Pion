import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { GitDiffHunk, GitDiffLine, GitFileDiff } from '../../../../shared/types'
import { DIFF_PAGE_SIZE, DiffPagination } from './DiffPagination'
import { ReviewRevealText } from './ReviewRevealText'

function actionLabel(action: 'stage' | 'unstage' | 'discard'): string {
  return action === 'stage' ? '暂存 hunk' : action === 'unstage' ? '取消暂存 hunk' : '撤销 hunk'
}

type Segment = { hunk: GitDiffHunk; start: number; end: number }

function paginate(hunks: GitDiffHunk[]): Segment[][] {
  const pages: Segment[][] = [[]]
  let remaining = DIFF_PAGE_SIZE
  for (const hunk of hunks) {
    let start = 0
    do {
      if (remaining === 0) {
        pages.push([])
        remaining = DIFF_PAGE_SIZE
      }
      const count = Math.min(remaining, Math.max(1, hunk.lines.length - start))
      const end = Math.min(hunk.lines.length, start + count)
      pages[pages.length - 1].push({ hunk, start, end })
      remaining -= count
      start = end
    } while (start < hunk.lines.length)
  }
  return pages
}

const DiffRow = memo(function DiffRow({ line, checked, selectable, disabled, onToggleLine }: {
  line: GitDiffLine
  checked: boolean
  selectable: boolean
  disabled: boolean
  onToggleLine: (lineId: string) => void
}): ReactElement {
  const changed = line.kind === 'add' || line.kind === 'delete'
  return (
    <tr className={`git-diff-${line.kind}`}>
      <td className="git-diff-select">
        {changed && selectable && (
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            aria-label={`选择${line.kind === 'add' ? '新增' : '删除'}行 ${line.newLine ?? line.oldLine ?? ''}`}
            onChange={() => onToggleLine(line.id)}
          />
        )}
      </td>
      <td className="git-diff-old">{line.oldLine ?? ''}</td>
      <td className="git-diff-new">{line.newLine ?? ''}</td>
      <td className="git-diff-marker">{line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : ''}</td>
      <td className="git-diff-code"><ReviewRevealText key={line.text} text={line.text || '\u00a0'} deferOffscreen /></td>
    </tr>
  )
})

export const GitDiffView = memo(function GitDiffView({
  diff,
  action,
  selectedLineIds,
  disabled,
  onToggleLine,
  onApplyHunk
}: {
  diff: GitFileDiff
  action: 'stage' | 'unstage' | 'discard'
  selectedLineIds: Set<string>
  disabled: boolean
  onToggleLine: (lineId: string) => void
  onApplyHunk: (hunkId: string) => void
}): ReactElement {
  const { pages, totalLines } = useMemo(() => ({
    pages: paginate(diff.hunks),
    totalLines: diff.hunks.reduce((total, hunk) => total + hunk.lines.length, 0)
  }), [diff])
  const [position, setPosition] = useState({ diff, page: 0 })
  const currentPage = position.diff === diff ? Math.min(position.page, pages.length - 1) : 0
  const token = useMemo(() => ({}), [diff, currentPage, disabled, action, onToggleLine, onApplyHunk])
  const committed = useRef<object | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const scroll = rootRef.current?.closest<HTMLElement>('.review-detail-body')
    if (scroll) scroll.scrollTop = 0
  }, [diff, currentPage])
  useLayoutEffect(() => {
    committed.current = token
    return () => { if (committed.current === token) committed.current = null }
  }, [token])
  useLayoutEffect(() => {
    setPosition((previous) => previous.diff === diff ? previous : { diff, page: 0 })
  }, [diff])
  const toggleLine = useMemo(() => (lineId: string) => {
    if (committed.current === token && !disabled) onToggleLine(lineId)
  }, [token, disabled, onToggleLine])
  const applyHunk = (hunkId: string): void => {
    if (committed.current === token && !disabled) onApplyHunk(hunkId)
  }
  const changePage = (page: number): void => {
    if (committed.current === token && page >= 0 && page < pages.length) setPosition({ diff, page })
  }

  if (diff.binary) {
    return <div className="git-diff-binary">二进制文件不支持行级预览，请使用整文件操作。</div>
  }
  if (diff.hunks.length === 0) {
    return <div className="git-diff-binary">仅包含模式、重命名或其他元数据变化。</div>
  }

  return (
    <div className="git-diff-view" ref={rootRef}>
      <DiffPagination page={currentPage} pageCount={pages.length} totalLines={totalLines} onPageChange={changePage} compact />
      {pages[currentPage].map(({ hunk, start, end }) => (
        <section className="git-diff-hunk" key={hunk.id}>
          <header>
            <code><ReviewRevealText key={hunk.header} text={hunk.header} /></code>
            {(start > 0 || end < hunk.lines.length) && <span>（{start > 0 ? '续页' : '跨页'} · 显示 {start + 1}–{end} / {hunk.lines.length} 行）</span>}
            {diff.selectable && (
              <button type="button" disabled={disabled} onClick={() => applyHunk(hunk.id)}>
                {actionLabel(action)}{(start > 0 || end < hunk.lines.length) && '（完整 hunk）'}
              </button>
            )}
          </header>
          <table>
            <tbody>
              {hunk.lines.slice(start, end).map((line) => (
                <DiffRow key={line.id} line={line} checked={selectedLineIds.has(line.id)} selectable={diff.selectable} disabled={disabled} onToggleLine={toggleLine} />
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  )
})
