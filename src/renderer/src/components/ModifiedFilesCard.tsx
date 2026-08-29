import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { ChevronDown, ChevronUp, FileDiff, RotateCcw } from 'lucide-react'
import type { FileChange } from '../agent/types'

const DEFAULT_VISIBLE_FILES = 3

interface ModifiedFilesCardProps {
  changes: FileChange[]
  cwd?: string
  canUndo: boolean
  undoBusy: boolean
  error: string
  onUndo: () => void
  onReview: () => void
  onSelect: (change: FileChange) => void
}

export function ModifiedFilesCard({
  changes,
  cwd,
  canUndo,
  undoBusy,
  error,
  onUndo,
  onReview,
  onSelect
}: ModifiedFilesCardProps): ReactElement | null {
  const [expanded, setExpanded] = useState(false)
  const signature = changes.map((change) => `${change.path}:${change.additions}:${change.deletions}`).join('|')

  useEffect(() => {
    setExpanded(false)
  }, [signature])

  const totals = useMemo(() => changes.reduce(
    (total, change) => ({
      additions: total.additions + change.additions,
      deletions: total.deletions + change.deletions
    }),
    { additions: 0, deletions: 0 }
  ), [changes])

  if (changes.length === 0) return null
  const visibleChanges = expanded ? changes : changes.slice(0, DEFAULT_VISIBLE_FILES)
  const hiddenCount = Math.max(0, changes.length - visibleChanges.length)

  return (
    <section className="modified-files-card" aria-label="本轮已修改文件">
      <header className="modified-files-head">
        <span className="modified-files-icon"><FileDiff size={15} /></span>
        <span className="modified-files-title">
          <strong>已编辑 {changes.length} 个文件</strong>
          <span className="modified-files-total">
            <b className="stat-add">+{totals.additions}</b>
            <b className="stat-del">−{totals.deletions}</b>
          </span>
        </span>
        <span className="modified-files-actions">
          <button
            type="button"
            className="modified-files-undo"
            disabled={!canUndo || undoBusy}
            title={canUndo ? '恢复发送本轮任务前的工作区状态' : '当前修改不可撤销'}
            onClick={onUndo}
          >
            <RotateCcw size={12} className={undoBusy ? 'spin' : undefined} />
            {undoBusy ? '撤销中' : '撤销'}
          </button>
          <button type="button" className="modified-files-review" onClick={onReview}>
            审查
          </button>
        </span>
      </header>

      {error && <div className="modified-files-error">{error}</div>}

      <div className="modified-files-list">
        {visibleChanges.map((change) => (
          <button
            type="button"
            key={change.path}
            className="modified-files-row"
            title={`查看 ${change.path} 的变更`}
            onClick={() => onSelect(change)}
          >
            <span className="modified-files-path">{displayPath(change.path, cwd)}</span>
            <span className="modified-files-stats">
              <span className="stat-add">+{change.additions}</span>
              <span className="stat-del">−{change.deletions}</span>
            </span>
          </button>
        ))}
      </div>

      {(hiddenCount > 0 || expanded) && changes.length > DEFAULT_VISIBLE_FILES && (
        <button
          type="button"
          className="modified-files-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <>收起文件 <ChevronUp size={13} /></>
          ) : (
            <>再显示 {hiddenCount} 个文件 <ChevronDown size={13} /></>
          )}
        </button>
      )}
    </section>
  )
}

function displayPath(path: string, cwd?: string): string {
  if (!cwd) return path
  const root = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}
