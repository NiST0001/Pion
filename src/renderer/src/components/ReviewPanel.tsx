import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { FileDiff, FilePenLine, FilePlus2, X } from 'lucide-react'
import type { FileChange } from '../hooks/useAgent'
import { DiffView } from './DiffView'

interface ReviewPanelProps {
  changes: FileChange[]
  selectedChange: FileChange | null
  width: number
  onSelect: (change: FileChange) => void
  onClose: () => void
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void
}

export function ReviewPanel({
  changes,
  selectedChange,
  width,
  onSelect,
  onClose,
  onResizeStart
}: ReviewPanelProps): ReactElement {
  const selected = selectedChange
    ? changes.find((change) => change.path === selectedChange.path) ?? selectedChange
    : null

  return (
    <aside className="review-panel" style={{ width, flexBasis: width }}>
      <div
        className="review-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整审查栏宽度"
        onPointerDown={onResizeStart}
      />
      <header className="review-panel-head">
        <div className="review-panel-title">
          <div className="review-panel-kicker">WORKSPACE</div>
          <strong>文件与审查</strong>
        </div>
        <button type="button" className="icon-button" title="关闭文件与审查栏" onClick={onClose}>
          <X size={15} />
        </button>
      </header>

      <div className="review-panel-body">
        <section className="review-files">
          <div className="review-section-head">
            <span>变更文件</span>
            <span className="review-count">{changes.length}</span>
          </div>
          {changes.length === 0 ? (
            <div className="review-empty-files">
              <FileDiff size={17} />
              <span>本会话暂无文件改动</span>
            </div>
          ) : (
            <div className="review-file-list">
              {changes.map((change) => (
                <button
                  type="button"
                  key={change.path}
                  className={`review-file-item${selected?.path === change.path ? ' active' : ''}`}
                  onClick={() => onSelect(change)}
                  title={change.path}
                >
                  {change.kind === 'edit' ? <FilePenLine size={14} /> : <FilePlus2 size={14} />}
                  <span className="review-file-name">{shortPath(change.path)}</span>
                  <span className="tool-stats">
                    <span className="stat-add">+{change.additions}</span>
                    <span className="stat-del">−{change.deletions}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="review-detail">
          {selected ? (
            <>
              <div className="review-detail-head" title={selected.path}>
                <span className="review-detail-name">{selected.path}</span>
                <span className="tool-stats">
                  <span className="stat-add">+{selected.additions}</span>
                  <span className="stat-del">−{selected.deletions}</span>
                </span>
              </div>
              <div className="review-detail-body">
                {selected.kind === 'edit' && selected.diff && <DiffView diff={selected.diff} />}
                {selected.kind === 'write' && <pre className="file-preview">{selected.content}</pre>}
              </div>
            </>
          ) : (
            <div className="review-empty-detail">
              <FileDiff size={22} />
              <strong>选择一个文件查看审查内容</strong>
              <span>变更的 diff 和新文件内容会显示在这里。</span>
            </div>
          )}
        </section>
      </div>
    </aside>
  )
}

function shortPath(path: string): string {
  const parts = path.split('/')
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path
}
