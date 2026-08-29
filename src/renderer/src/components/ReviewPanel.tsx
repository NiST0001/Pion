import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { FileDiff, FilePenLine, FilePlus2, RotateCcw, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import type { RunCheckpointStatus } from '../../../shared/types'
import type { FileChange } from '../agent/types'
import { DiffView } from './DiffView'

interface ReviewPanelProps {
  changes: FileChange[]
  selectedChange: FileChange | null
  checkpoint: RunCheckpointStatus | null
  agentBusy: boolean
  rollbackBusy: boolean
  rollbackError: string
  width: number
  onSelect: (change: FileChange) => void
  onRollback: () => void
  onClose: () => void
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void
}

export function ReviewPanel({
  changes,
  selectedChange,
  checkpoint,
  agentBusy,
  rollbackBusy,
  rollbackError,
  width,
  onSelect,
  onRollback,
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

      <div
        className={`review-checkpoint review-checkpoint-${checkpoint?.state ?? 'empty'}`}
        aria-live="polite"
      >
        <div className="review-checkpoint-icon">
          {checkpoint?.state === 'unavailable'
            ? <ShieldAlert size={15} />
            : <ShieldCheck size={15} />}
        </div>
        <div className="review-checkpoint-copy">
          <strong>{checkpointTitle(checkpoint, agentBusy)}</strong>
          <span>{rollbackError || checkpointDescription(checkpoint)}</span>
        </div>
        {checkpoint?.state === 'ready' && (
          <button
            type="button"
            className="review-checkpoint-rollback"
            disabled={agentBusy || rollbackBusy || !checkpoint.hasChanges}
            title={agentBusy
              ? '请先等待 Agent 完成或中止运行'
              : checkpoint.hasChanges
                ? '恢复发送本轮任务前的工作区状态'
                : '本轮尚未检测到工作区变更'}
            onClick={onRollback}
          >
            <RotateCcw size={13} className={rollbackBusy ? 'spin' : undefined} />
            <span>{rollbackBusy ? '恢复中' : '撤销本轮'}</span>
          </button>
        )}
      </div>

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

function checkpointTitle(checkpoint: RunCheckpointStatus | null, agentBusy: boolean): string {
  if (!checkpoint) return '运行检查点'
  if (checkpoint.state === 'unavailable') return '检查点不可用'
  if (checkpoint.state === 'rolled-back') return '已恢复本轮检查点'
  if (agentBusy) return '本轮检查点已保护'
  if (checkpoint.hasChanges) return `${checkpoint.changedFileCount} 个文件可恢复`
  return '本轮检查点已保护'
}

function checkpointDescription(checkpoint: RunCheckpointStatus | null): string {
  if (!checkpoint) return '发送任务后自动保护工作区状态'
  if (checkpoint.state === 'unavailable') return checkpoint.error || '无法保护当前工作区'
  if (checkpoint.state === 'rolled-back') return '工作区已恢复到发送本轮任务之前'
  const time = new Date(checkpoint.createdAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  })
  return checkpoint.hasChanges
    ? `创建于 ${time} · 发送前已有修改会保留`
    : `创建于 ${time} · 正在监测本轮修改`
}

function shortPath(path: string): string {
  const parts = path.split('/')
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path
}
