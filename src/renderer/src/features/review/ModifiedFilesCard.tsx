import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { ChevronDown, ChevronUp, FileDiff, RotateCcw } from 'lucide-react'
import type { FileChange } from '../../agent/types'

const DEFAULT_VISIBLE_FILES = 3
// Do not offer a text-diff action for media, even text-based SVG images.
// Git's binary evidence additionally covers binary files with unknown suffixes.
const NON_TEXT_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif', 'heic', 'heif', 'tif', 'tiff', 'psd', 'exr', 'raw',
  'mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'mpeg', 'mpg', 'wmv', 'flv', '3gp',
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'aiff', 'opus', 'mid', 'midi',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'zst',
  'exe', 'dll', 'so', 'dylib', 'bin', 'wasm', 'o', 'obj', 'a', 'lib', 'class', 'jar',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'db', 'sqlite', 'sqlite3', 'blend', 'fbx', 'glb'
])

function canPreviewChange(change: FileChange): boolean {
  if (change.binary) return false
  const name = change.path.split(/[\\/]/).pop() ?? ''
  const suffix = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  return !NON_TEXT_EXTENSIONS.has(suffix)
}

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
  const previewable = useMemo(() => changes.filter(canPreviewChange), [changes])
  const signature = previewable.map((change) => `${change.path}:${change.additions}:${change.deletions}`).join('|')

  useEffect(() => {
    setExpanded(false)
  }, [signature])

  const totals = useMemo(() => previewable.reduce(
    (total, change) => ({
      additions: total.additions + change.additions,
      deletions: total.deletions + change.deletions
    }),
    { additions: 0, deletions: 0 }
  ), [previewable])

  if (previewable.length === 0) return null
  const visibleChanges = expanded ? previewable : previewable.slice(0, DEFAULT_VISIBLE_FILES)
  const hiddenCount = Math.max(0, previewable.length - visibleChanges.length)

  return (
    <section className="modified-files-card" aria-label={workspace ? '工作区已修改文件' : '本轮工具记录'}>
      <header className="modified-files-head">
        <span className="modified-files-icon"><FileDiff size={15} /></span>
        <span className="modified-files-title">
          <strong>{workspace ? '工作区已编辑' : '本轮记录'} {previewable.length} 个文件</strong>
          <span className="modified-files-total" title={workspace ? '仅可查看文本文件：已暂存 + 未暂存，包含未跟踪文件；排除媒体/二进制，非全部工作区文件或本轮独有修改' : '仅可查看文件的当前已加载 edit/write 工具记录，排除媒体/二进制，非工作区总量'}>
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

      {(hiddenCount > 0 || expanded) && previewable.length > DEFAULT_VISIBLE_FILES && (
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
