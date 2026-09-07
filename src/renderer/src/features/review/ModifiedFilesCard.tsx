import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { ChevronDown, ChevronUp, FileDiff, RotateCcw } from 'lucide-react'
import type { FileChange } from '../../agent/types'

const DEFAULT_VISIBLE_FILES = 3

interface ModifiedFilesCardProps {
  changes: FileChange[]
  workspace?: boolean
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
  workspace = false,
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
    <section className="modified-files-card" aria-label={workspace ? '工作区已修改文件' : '本轮工具记录'}>
      <header className="modified-files-head">
        <span className="modified-files-icon"><FileDiff size={15} /></span>
        <span className="modified-files-title">
          <strong>{workspace ? '工作区已编辑' : '本轮记录'} {changes.length} 个文件</strong>
          <span className="modified-files-total" title={workspace ? '与审查栏相同：已暂存 + 未暂存，包含未跟踪文件；非本轮独有修改' : '仅当前已加载的 edit/write 工具记录，非工作区总量'}>
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
            {undoBusy ? '撤销中' : workspace ? '撤销本轮' : '撤销'}
          </button>
          <button
            type="button"
            className="modified-files-review"
            aria-label="打开文件与审查栏"
            onClick={(event) => {
              event.stopPropagation()
              onReview()
            }}
          >
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
            onPointerUp={(event) => {
              if (event.button !== 0) return
              event.preventDefault()
              event.stopPropagation()
              onSelect(change)
            }}
            onClick={(event) => {
              // Pointer activation is handled on pointer-up so a tiny movement
              // inside the scroll container cannot suppress the review action.
              // detail=0 preserves keyboard and programmatic activation.
              if (event.detail !== 0) return
              event.stopPropagation()
              onSelect(change)
            }}
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
