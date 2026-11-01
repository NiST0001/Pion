import type { ReactElement } from 'react'

export const DIFF_PAGE_SIZE = 120

/** Shared by Git worktree review and captured tool diffs. */
export function DiffPagination({ page, pageCount, totalLines, onPageChange, compact = false }: {
  page: number
  pageCount: number
  totalLines: number
  onPageChange: (page: number) => void
  compact?: boolean
}): ReactElement | null {
  if (pageCount <= 1) return null
  return <div className="diff-page-controls" role="group" aria-label="差异分页">
    <span style={compact ? { flex: 'none' } : undefined}>第 {page + 1} / {pageCount} 页 · 共 {totalLines} 行</span>
    <button type="button" disabled={page === 0} onClick={() => onPageChange(page - 1)}>上一页</button>
    <button type="button" disabled={page === pageCount - 1} onClick={() => onPageChange(page + 1)}>下一页</button>
  </div>
}
