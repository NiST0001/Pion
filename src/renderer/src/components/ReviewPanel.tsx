import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import {
  AlertTriangle,
  Check,
  FileDiff,
  FilePenLine,
  FilePlus2,
  GitCommitHorizontal,
  Loader2,
  Minus,
  RotateCcw,
  Save,
  Trash2,
  X
} from 'lucide-react'
import type {
  GitConflictContent,
  GitDiffScope,
  GitFileDiff,
  GitFileStatus,
  GitOperation,
  GitSelectionRequest,
  GitWorkspaceSnapshot,
  RunCheckpointStatus
} from '../../../shared/types'
import { ConfirmDialog } from './ConfirmDialog'
import { GitDiffView } from './GitDiffView'

interface PendingDiscard {
  paths?: string[]
  selection?: Omit<GitSelectionRequest, 'cwd' | 'snapshotId'>
}

interface ReviewPanelProps {
  snapshot: GitWorkspaceSnapshot | null
  diff: GitFileDiff | null
  conflict: GitConflictContent | null
  selectedPath: string | null
  scope: GitDiffScope
  checkpoint: RunCheckpointStatus | null
  agentBusy: boolean
  loading: boolean
  diffLoading: boolean
  gitBusy: boolean
  gitError: string
  gitResult: string
  rollbackBusy: boolean
  rollbackError: string
  width: number
  onSelect: (path: string | null) => void
  onScopeChange: (scope: GitDiffScope) => void
  onLoadDiff: (path: string, scope: GitDiffScope) => void
  onStage: (paths: string[]) => void
  onUnstage: (paths: string[]) => void
  onDiscard: (paths: string[]) => void
  onApplySelection: (request: Omit<GitSelectionRequest, 'cwd' | 'snapshotId'>) => void
  onCommit: (message: string) => Promise<boolean>
  onReadConflict: (path: string) => void
  onResolveConflict: (path: string, strategy: 'ours' | 'theirs' | 'content', content?: string) => void
  onContinueOperation: () => void
  onAbortOperation: () => void
  onRollback: () => void
  onClose: () => void
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void
}

function operationLabel(operation: GitOperation): string {
  if (operation === 'merge') return '合并'
  if (operation === 'rebase') return '变基'
  if (operation === 'cherry-pick') return 'Cherry-pick'
  if (operation === 'revert') return 'Revert'
  return ''
}

function shortPath(path: string): string {
  const parts = path.split('/')
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path
}

function fileIcon(file: GitFileStatus): ReactElement {
  if (file.kind === 'added' || file.kind === 'untracked') return <FilePlus2 size={14} />
  if (file.kind === 'deleted') return <Trash2 size={14} />
  if (file.conflicted) return <AlertTriangle size={14} />
  return <FilePenLine size={14} />
}

function FileList({
  title,
  files,
  scope,
  selectedPath,
  activeScope,
  onSelect
}: {
  title: string
  files: GitFileStatus[]
  scope: GitDiffScope
  selectedPath: string | null
  activeScope: GitDiffScope
  onSelect: (path: string, scope: GitDiffScope) => void
}): ReactElement | null {
  if (files.length === 0) return null
  return (
    <section className="git-file-group">
      <div className="review-section-head"><span>{title}</span><span className="review-count">{files.length}</span></div>
      <div className="review-file-list">
        {files.map((file) => (
          <button
            type="button"
            key={`${scope}:${file.path}`}
            className={`review-file-item${selectedPath === file.path && (file.conflicted || activeScope === scope) ? ' active' : ''}${file.conflicted ? ' conflicted' : ''}`}
            onClick={() => onSelect(file.path, scope)}
            title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
          >
            {fileIcon(file)}
            <span className="review-file-name">{shortPath(file.path)}</span>
            <span className="git-file-code">{scope === 'staged' ? file.indexCode : file.worktreeCode}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

export function ReviewPanel({
  snapshot,
  diff,
  conflict,
  selectedPath,
  scope,
  checkpoint,
  agentBusy,
  loading,
  diffLoading,
  gitBusy,
  gitError,
  gitResult,
  rollbackBusy,
  rollbackError,
  width,
  onSelect,
  onScopeChange,
  onLoadDiff,
  onStage,
  onUnstage,
  onDiscard,
  onApplySelection,
  onCommit,
  onReadConflict,
  onResolveConflict,
  onContinueOperation,
  onAbortOperation,
  onRollback,
  onClose,
  onResizeStart
}: ReviewPanelProps): ReactElement {
  const [selectedLineIds, setSelectedLineIds] = useState<Set<string>>(new Set())
  const [lineAction, setLineAction] = useState<'stage' | 'discard'>('stage')
  const [commitMessage, setCommitMessage] = useState('')
  const [conflictDraft, setConflictDraft] = useState('')
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null)
  const [abortConfirmOpen, setAbortConfirmOpen] = useState(false)
  const loadDiffRef = useRef(onLoadDiff)
  const readConflictRef = useRef(onReadConflict)
  loadDiffRef.current = onLoadDiff
  readConflictRef.current = onReadConflict

  const files = snapshot?.files ?? []
  const selected = files.find((file) => file.path === selectedPath) ?? null
  const staged = files.filter((file) => file.staged && !file.conflicted)
  const unstaged = files.filter((file) => file.unstaged && !file.conflicted)
  const conflicts = files.filter((file) => file.conflicted)

  useEffect(() => {
    if (selectedPath && !files.some((file) => file.path === selectedPath)) onSelect(null)
  }, [files, onSelect, selectedPath])

  useEffect(() => {
    setSelectedLineIds(new Set())
    if (!selected) return
    if (selected.conflicted) readConflictRef.current(selected.path)
    else loadDiffRef.current(selected.path, scope)
  }, [scope, selected?.path, selected?.conflicted, snapshot?.snapshotId])

  useEffect(() => {
    setConflictDraft(conflict?.working ?? '')
  }, [conflict?.path, conflict?.working])

  useEffect(() => {
    if (scope === 'staged') setLineAction('stage')
  }, [scope])

  const applyAction = scope === 'staged' ? 'unstage' : lineAction
  const selectedStats = useMemo(() => diff ? { additions: diff.additions, deletions: diff.deletions } : null, [diff])

  const selectFile = (path: string, nextScope: GitDiffScope): void => {
    onSelect(path)
    onScopeChange(nextScope)
  }

  const applySelection = (selection: Omit<GitSelectionRequest, 'cwd' | 'snapshotId'>): void => {
    if (selection.action === 'discard') setPendingDiscard({ selection })
    else onApplySelection(selection)
  }

  return (
    <aside className="review-panel" style={{ width, flexBasis: width }}>
      <div className="review-resizer" role="separator" aria-orientation="vertical" aria-label="调整审查栏宽度" onPointerDown={onResizeStart} />
      <header className="review-panel-head">
        <div className="review-panel-title">
          <div className="review-panel-kicker">GIT WORKSPACE</div>
          <strong>文件与审查</strong>
        </div>
        <div className="review-panel-actions">
          {checkpoint?.state === 'ready' && checkpoint.hasChanges && (
            <button
              type="button"
              className="icon-button review-rollback-button"
              disabled={agentBusy || rollbackBusy}
              aria-label={rollbackBusy ? '正在撤销本轮修改' : '撤销本轮修改'}
              title={rollbackError || (agentBusy ? '请先等待 Agent 完成或中止运行' : '恢复发送本轮任务前的工作区状态')}
              onClick={onRollback}
            >
              <RotateCcw size={15} className={rollbackBusy ? 'spin' : undefined} />
            </button>
          )}
          <button type="button" className="icon-button review-close-button" title="关闭文件与审查栏" onClick={onClose}><X size={15} /></button>
        </div>
      </header>

      {snapshot && snapshot.operation !== 'none' && (
        <div className="git-operation-banner">
          <AlertTriangle size={13} />
          <span>正在进行{operationLabel(snapshot.operation)} · {snapshot.conflictCount} 个冲突</span>
          <button type="button" disabled={gitBusy || snapshot.conflictCount > 0} onClick={onContinueOperation}><Check size={11} />继续</button>
          <button type="button" disabled={gitBusy} onClick={() => setAbortConfirmOpen(true)}><X size={11} />中止</button>
        </div>
      )}

      <div className="review-panel-body">
        <section className="review-files">
          {loading && !snapshot ? <div className="review-empty-files"><Loader2 size={15} className="spin" />读取 Git 状态…</div>
            : !snapshot ? <div className="review-empty-files"><FileDiff size={17} /><span>{gitError || '当前目录不是 Git 工作区'}</span></div>
              : files.length === 0 ? <div className="review-empty-files"><Check size={17} /><span>工作区干净</span></div>
                : (
                  <>
                    <FileList title="冲突" files={conflicts} scope="unstaged" selectedPath={selectedPath} activeScope={scope} onSelect={selectFile} />
                    <FileList title="已暂存" files={staged} scope="staged" selectedPath={selectedPath} activeScope={scope} onSelect={selectFile} />
                    <FileList title="修改" files={unstaged} scope="unstaged" selectedPath={selectedPath} activeScope={scope} onSelect={selectFile} />
                  </>
                )}

          {snapshot && snapshot.stagedCount > 0 && snapshot.conflictCount === 0 && (
            <div className="git-commit-box">
              <textarea
                rows={3}
                value={commitMessage}
                placeholder="提交说明"
                disabled={gitBusy}
                onChange={(event) => setCommitMessage(event.target.value)}
              />
              <button
                type="button"
                disabled={gitBusy || commitMessage.trim() === ''}
                onClick={() => void onCommit(commitMessage).then((committed) => {
                  if (committed) setCommitMessage('')
                })}
              >
                <GitCommitHorizontal size={12} />提交 {snapshot.stagedCount} 个文件
              </button>
            </div>
          )}
          {gitResult && <div className="git-action-result">{gitResult}</div>}
          {gitError && snapshot && <div className="git-action-error">{gitError}</div>}
        </section>

        <section className="review-detail">
          {selected ? (
            <>
              <div className="review-detail-head" title={selected.path}>
                <span className="review-detail-name">{selected.path}</span>
                {!selected.conflicted && (
                  <div className="git-file-actions">
                    {scope === 'unstaged' ? (
                      <>
                        <button type="button" disabled={gitBusy} onClick={() => onStage([selected.path])}><Save size={11} />暂存文件</button>
                        <button type="button" className="danger" disabled={gitBusy} onClick={() => setPendingDiscard({ paths: [selected.path] })}><RotateCcw size={11} />撤销文件</button>
                      </>
                    ) : (
                      <button type="button" disabled={gitBusy} onClick={() => onUnstage([selected.path])}><Minus size={11} />取消暂存</button>
                    )}
                  </div>
                )}
              </div>

              {selected.conflicted ? (
                <div className="git-conflict-editor">
                  {diffLoading && !conflict ? <Loader2 size={16} className="spin" /> : (
                    <>
                      <div className="git-conflict-actions">
                        <button type="button" disabled={gitBusy} onClick={() => onResolveConflict(selected.path, 'ours')}>使用阶段 2（当前）</button>
                        <button type="button" disabled={gitBusy} onClick={() => onResolveConflict(selected.path, 'theirs')}>使用阶段 3（传入）</button>
                      </div>
                      <p>变基期间“当前/传入”的语义可能与分支直觉相反；按钮按 Git 索引阶段标识。</p>
                      {conflict?.binary ? (
                        <div className="git-diff-binary">二进制冲突只能选择索引阶段 2 或 3。</div>
                      ) : (
                        <>
                          <textarea value={conflictDraft} disabled={gitBusy} onChange={(event) => setConflictDraft(event.target.value)} />
                          <button type="button" className="git-conflict-save" disabled={gitBusy} onClick={() => onResolveConflict(selected.path, 'content', conflictDraft)}>
                            <Save size={12} />保存结果并标记已解决
                          </button>
                        </>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <div className="review-detail-body">
                  <div className="git-diff-toolbar">
                    <div className="git-scope-tabs">
                      {selected.unstaged && <button type="button" className={scope === 'unstaged' ? 'active' : ''} onClick={() => onScopeChange('unstaged')}>未暂存</button>}
                      {selected.staged && <button type="button" className={scope === 'staged' ? 'active' : ''} onClick={() => onScopeChange('staged')}>已暂存</button>}
                    </div>
                    {scope === 'unstaged' && diff?.selectable && (
                      <div className="git-line-action-tabs">
                        <button type="button" className={lineAction === 'stage' ? 'active' : ''} onClick={() => setLineAction('stage')}>选择后暂存</button>
                        <button type="button" className={lineAction === 'discard' ? 'active danger' : ''} onClick={() => setLineAction('discard')}>选择后撤销</button>
                      </div>
                    )}
                    {selectedLineIds.size > 0 && (
                      <button
                        type="button"
                        className={applyAction === 'discard' ? 'git-apply-lines danger' : 'git-apply-lines'}
                        disabled={gitBusy}
                        onClick={() => applySelection({ path: selected.path, action: applyAction, lineIds: [...selectedLineIds] })}
                      >应用 {selectedLineIds.size} 行</button>
                    )}
                    {selectedStats && <span className="tool-stats"><span className="stat-add">+{selectedStats.additions}</span><span className="stat-del">−{selectedStats.deletions}</span></span>}
                  </div>
                  {diffLoading ? <div className="review-empty-detail"><Loader2 size={18} className="spin" /><span>读取差异…</span></div>
                    : diff ? (
                      <GitDiffView
                        diff={diff}
                        action={applyAction}
                        selectedLineIds={selectedLineIds}
                        disabled={gitBusy}
                        onToggleLine={(lineId) => setSelectedLineIds((current) => {
                          const next = new Set(current)
                          if (next.has(lineId)) next.delete(lineId)
                          else next.add(lineId)
                          return next
                        })}
                        onApplyHunk={(hunkId) => applySelection({ path: selected.path, action: applyAction, hunkId })}
                      />
                    ) : <div className="review-empty-detail"><FileDiff size={20} /><span>没有可显示的文本差异</span></div>}
                </div>
              )}
            </>
          ) : (
            <div className="review-empty-detail"><FileDiff size={22} /><strong>选择 Git 文件查看差异</strong><span>支持文件、hunk 和行级暂存或撤销。</span></div>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={pendingDiscard !== null}
        title="撤销所选工作区修改？"
        message="这会永久替换所选未暂存内容。"
        detail="未跟踪文件会被删除；已暂存内容不会被同时撤销。"
        confirmLabel="撤销修改"
        busy={gitBusy}
        onCancel={() => setPendingDiscard(null)}
        onConfirm={() => {
          const pending = pendingDiscard
          if (!pending) return
          if (pending.paths) onDiscard(pending.paths)
          else if (pending.selection) onApplySelection(pending.selection)
          setPendingDiscard(null)
        }}
      />
      <ConfirmDialog
        open={abortConfirmOpen}
        title={`中止 Git ${snapshot ? operationLabel(snapshot.operation) : ''}？`}
        message="这会运行 Git 的原生 abort 操作并恢复操作开始前的状态。"
        confirmLabel="中止操作"
        busy={gitBusy}
        onCancel={() => setAbortConfirmOpen(false)}
        onConfirm={() => {
          onAbortOperation()
          setAbortConfirmOpen(false)
        }}
      />
    </aside>
  )
}
