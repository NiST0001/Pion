import { Fragment, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { ChevronDown, ChevronUp, FileDiff } from 'lucide-react'
import type { FileChange } from '../../agent/types'
import { AnimatedDisclosure } from '../common/AnimatedDisclosure'
import { DiffView } from './DiffView'

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
  cwd?: string
}

export function ModifiedFilesCard({
  changes,
  cwd
}: ModifiedFilesCardProps): ReactElement | null {
  const [expanded, setExpanded] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const previewable = useMemo(() => changes.filter(canPreviewChange), [changes])
  const signature = previewable.map((change) => `${change.path}:${change.additions}:${change.deletions}`).join('|')

  useEffect(() => {
    setExpanded(false)
  }, [signature])

  useEffect(() => {
    setSelectedPath((path) => previewable.some((change) => change.path === path) ? path : null)
  }, [previewable])

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
    <section className="modified-files-card" aria-label="本轮工具记录">
      <header className="modified-files-head">
        <span className="modified-files-icon"><FileDiff size={15} /></span>
        <span className="modified-files-title">
          <strong>本轮记录 {previewable.length} 个文件</strong>
          <span className="modified-files-total" title="本轮已加载且成功的 edit/write 工具记录；排除媒体/二进制，不含终端等其他修改途径，非 Git 净变化">
            <b className="stat-add">+{totals.additions}</b>
            <b className="stat-del">−{totals.deletions}</b>
          </span>
        </span>
        <span className="modified-files-actions">
          <button
            type="button"
            className="modified-files-review"
            aria-expanded={selectedPath !== null}
            title="只读查看本轮成功工具记录，不读取当前文件或 Git 差异"
            onClick={(event) => {
              event.stopPropagation()
              setSelectedPath((path) => path === null ? previewable[0].path : null)
            }}
          >
            {selectedPath === null ? '查看记录' : '收起记录'}
          </button>
        </span>
      </header>

      <div className="review-captured-note">本轮成功的 edit/write 工具记录，非 Git 净变化。</div>
      <div className="modified-files-list">
        {visibleChanges.map((change) => (
          <Fragment key={change.path}>
            <button
              type="button"
              className="modified-files-row"
              aria-expanded={selectedPath === change.path}
              aria-pressed={selectedPath === change.path}
              title={`查看 ${change.path} 的本轮记录`}
              onPointerUp={(event) => {
                if (event.button !== 0) return
                event.preventDefault()
                event.stopPropagation()
                setSelectedPath((path) => path === change.path ? null : change.path)
              }}
              onClick={(event) => {
                // Pointer activation is handled on pointer-up so a tiny movement
                // inside the scroll container cannot suppress the record action.
                // detail=0 preserves keyboard and programmatic activation.
                if (event.detail !== 0) return
                event.stopPropagation()
                setSelectedPath((path) => path === change.path ? null : change.path)
              }}
            >
              <span className="modified-files-path">{displayPath(change.path, cwd)}</span>
              <span className="modified-files-stats">
                <span className="stat-add">+{change.additions}</span>
                <span className="stat-del">−{change.deletions}</span>
              </span>
            </button>
            <AnimatedDisclosure open={selectedPath === change.path}>
              <CapturedChangeDetails change={change} />
            </AnimatedDisclosure>
          </Fragment>
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

function CapturedChangeDetails({ change }: { change: FileChange }): ReactElement {
  const diff = useMemo(() => {
    if (change.kind === 'edit') return change.diff ?? ''
    if (!change.content) return ''
    return change.content.split('\n').map((line, index) => `+${index + 1} ${line}`).join('\n')
  }, [change])

  return diff.trim()
    ? <DiffView diff={diff} dense reveal />
    : <div className="review-captured-note">该工具记录没有可显示的文本差异</div>
}

function displayPath(path: string, cwd?: string): string {
  if (!cwd) return path
  const root = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}
