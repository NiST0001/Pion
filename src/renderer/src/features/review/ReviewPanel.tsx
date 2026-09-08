import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  FileDiff,
  FilePenLine,
  FilePlus2,
  Folder,
  FolderOpen,
  GitCommitHorizontal,
  Loader2,
  Minus,
  RotateCcw,
  Save,
  Trash2,
  X
} from 'lucide-react'
import type { FileChange } from '../../agent/types'
import type {
  GitConflictContent,
  GitDiffScope,
  GitFileDiff,
  GitFileStatus,
  GitOperation,
  GitSelectionRequest,
  GitWorkspaceSnapshot,
  RunCheckpointStatus
} from '../../../../shared/types'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { DiffView } from './DiffView'
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
  capturedChange: FileChange | null
  scope: GitDiffScope
  checkpoint: RunCheckpointStatus | null
  agentBusy: boolean
  loading: boolean
  codeEnabled: boolean
  diffLoading: boolean
  gitBusy: boolean
  gitError: string
  gitResult: string
  rollbackBusy: boolean
  rollbackError: string
  width?: number
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
  onResizeStart?: (event: ReactPointerEvent<HTMLDivElement>) => void
}

function capturedChangeDiff(change: FileChange): string {
  if (change.diff?.trim()) return change.diff
  if (change.content === undefined) return ''
  return change.content
    .split('\n')
    .map((line, index) => `+${index + 1} ${line}`)
    .join('\n')
}

function operationLabel(operation: GitOperation): string {
  if (operation === 'merge') return '合并'
  if (operation === 'rebase') return '变基'
  if (operation === 'cherry-pick') return 'Cherry-pick'
  if (operation === 'revert') return 'Revert'
  return ''
}

function fileIcon(file: GitFileStatus): ReactElement {
  if (file.kind === 'added' || file.kind === 'untracked') return <FilePlus2 size={14} />
  if (file.kind === 'deleted') return <Trash2 size={14} />
  if (file.conflicted) return <AlertTriangle size={14} />
  return <FilePenLine size={14} />
}

interface ReviewFileTreeDirectory {
  type: 'directory'
  name: string
  path: string
  fileCount: number
  children: ReviewFileTreeNode[]
}

interface ReviewFileTreeFile {
  type: 'file'
  name: string
  path: string
  file: GitFileStatus
}

type ReviewFileTreeNode = ReviewFileTreeDirectory | ReviewFileTreeFile

interface MutableReviewDirectory {
  name: string
  path: string
  directories: Map<string, MutableReviewDirectory>
  files: GitFileStatus[]
}

function buildFileTree(files: GitFileStatus[]): ReviewFileTreeNode[] {
  const root: MutableReviewDirectory = {
    name: '',
    path: '',
    directories: new Map(),
    files: []
  }

  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean)
    const fileName = parts.pop() ?? file.path
    let directory = root
    for (const name of parts) {
      const path = directory.path ? `${directory.path}/${name}` : name
      let child = directory.directories.get(name)
      if (!child) {
        child = { name, path, directories: new Map(), files: [] }
        directory.directories.set(name, child)
      }
      directory = child
    }
    directory.files.push({ ...file, path: file.path || fileName })
  }

  const materialize = (directory: MutableReviewDirectory): ReviewFileTreeNode[] => {
    const directories: ReviewFileTreeDirectory[] = [...directory.directories.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((child) => {
        const children = materialize(child)
        return {
          type: 'directory',
          name: child.name,
          path: child.path,
          fileCount: children.reduce((count, node) => (
            count + (node.type === 'file' ? 1 : node.fileCount)
          ), 0),
          children
        }
      })
    const leafFiles: ReviewFileTreeFile[] = [...directory.files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({
        type: 'file',
        name: file.path.split('/').at(-1) ?? file.path,
        path: file.path,
        file
      }))
    return [...directories, ...leafFiles]
  }

  return materialize(root)
}

function parentDirectories(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

function FileTreeRows({
  nodes,
  depth,
  scope,
  selectedPath,
  activeScope,
  collapsed,
  onToggleDirectory,
  onSelect
}: {
  nodes: ReviewFileTreeNode[]
  depth: number
  scope: GitDiffScope
  selectedPath: string | null
  activeScope: GitDiffScope
  collapsed: Set<string>
  onToggleDirectory: (path: string) => void
  onSelect: (path: string, scope: GitDiffScope) => void
}): ReactElement {
  const rowStyle = (rowDepth: number) => ({
    '--review-tree-indent': `${rowDepth * 14}px`
  }) as CSSProperties

  return (
    <>
      {nodes.map((node) => {
        if (node.type === 'directory') {
          const isCollapsed = collapsed.has(node.path)
          return (
            <div className="review-tree-branch" role="none" key={`directory:${node.path}`}>
              <button
                type="button"
                role="treeitem"
                className="review-tree-directory"
                style={rowStyle(depth)}
                aria-expanded={!isCollapsed}
                aria-label={`${isCollapsed ? '展开' : '收起'}目录 ${node.path}`}
                title={node.path}
                onClick={() => onToggleDirectory(node.path)}
              >
                {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                {isCollapsed ? <Folder size={13} /> : <FolderOpen size={13} />}
                <span>{node.name}</span>
                <span className="review-tree-count">{node.fileCount}</span>
              </button>
              {!isCollapsed && (
                <div className="review-tree-group" role="group">
                  <FileTreeRows
                    nodes={node.children}
                    depth={depth + 1}
                    scope={scope}
                    selectedPath={selectedPath}
                    activeScope={activeScope}
                    collapsed={collapsed}
                    onToggleDirectory={onToggleDirectory}
                    onSelect={onSelect}
                  />
                </div>
              )}
            </div>
          )
        }

        const { file } = node
        return (
          <button
            type="button"
            role="treeitem"
            key={`${scope}:${file.path}`}
            className={`review-file-item review-tree-file${selectedPath === file.path && (file.conflicted || activeScope === scope) ? ' active' : ''}${file.conflicted ? ' conflicted' : ''}`}
            style={rowStyle(depth)}
            onClick={() => onSelect(file.path, scope)}
            title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
          >
            <span className="review-tree-file-spacer" aria-hidden="true" />
            {fileIcon(file)}
            <span className="review-file-name">{node.name}</span>
            <span className="git-file-code">{scope === 'staged' ? file.indexCode : file.worktreeCode}</span>
          </button>
        )
      })}
    </>
  )
}

function FileTree({
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
  const nodes = useMemo(() => buildFileTree(files), [files])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!selectedPath || activeScope !== scope) return
    const parents = new Set(parentDirectories(selectedPath))
    setCollapsed((current) => {
      const next = new Set([...current].filter((path) => !parents.has(path)))
      return next.size === current.size ? current : next
    })
  }, [activeScope, scope, selectedPath])

  if (files.length === 0) return null
  return (
    <section className="git-file-group">
      <div className="review-section-head"><span>{title}</span><span className="review-count">{files.length}</span></div>
      <div className="review-file-tree" role="tree" aria-label={`${title}文件树`}>
        <FileTreeRows
          nodes={nodes}
          depth={0}
          scope={scope}
          selectedPath={selectedPath}
          activeScope={activeScope}
          collapsed={collapsed}
          onToggleDirectory={(path) => setCollapsed((current) => {
            const next = new Set(current)
            if (next.has(path)) next.delete(path)
            else next.add(path)
            return next
          })}
          onSelect={onSelect}
        />
      </div>
    </section>
  )
}

export function ReviewPanel({
  snapshot,
  diff,
  conflict,
  selectedPath,
  capturedChange,
  scope,
  checkpoint,
  agentBusy,
  loading,
  codeEnabled,
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

  const files = useMemo(() => snapshot?.files ?? [], [snapshot])
  const selected = files.find((file) => file.path === selectedPath) ?? null
  const { staged, unstaged, conflicts } = useMemo(() => ({
    staged: files.filter((file) => file.staged && !file.conflicted),
    unstaged: files.filter((file) => file.unstaged && !file.conflicted),
    conflicts: files.filter((file) => file.conflicted)
  }), [files])

  useEffect(() => {
    // An inline modified-file link may select a path before the staged Git
    // snapshot arrives. Keep that pending selection until the file tree exists.
    if (!snapshot || loading) return
    if (selectedPath && !files.some((file) => file.path === selectedPath)) onSelect(null)
  }, [files, loading, onSelect, selectedPath, snapshot])

  useEffect(() => {
    setSelectedLineIds(new Set())
    if (!selected || !codeEnabled) return
    if (selected.conflicted) readConflictRef.current(selected.path)
    else loadDiffRef.current(selected.path, scope)
  }, [codeEnabled, scope, selected?.path, selected?.conflicted, snapshot?.snapshotId])

  useEffect(() => {
    setConflictDraft(conflict?.working ?? '')
  }, [conflict?.path, conflict?.working])

  useEffect(() => {
    if (scope === 'staged') setLineAction('stage')
  }, [scope])

  const applyAction = scope === 'staged' ? 'unstage' : lineAction
  const selectedStats = useMemo(() => diff ? { additions: diff.additions, deletions: diff.deletions } : null, [diff])
  const capturedDiff = useMemo(() => capturedChange ? capturedChangeDiff(capturedChange) : '', [capturedChange])

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
      {onResizeStart && <div className="review-resizer" role="separator" aria-orientation="vertical" aria-label="调整审查栏宽度" onPointerDown={onResizeStart} />}
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
                    <FileTree key="conflicts" title="冲突" files={conflicts} scope="unstaged" selectedPath={selectedPath} activeScope={scope} onSelect={selectFile} />
                    <FileTree key="staged" title="已暂存" files={staged} scope="staged" selectedPath={selectedPath} activeScope={scope} onSelect={selectFile} />
                    <FileTree key="unstaged" title="修改" files={unstaged} scope="unstaged" selectedPath={selectedPath} activeScope={scope} onSelect={selectFile} />
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

              {!codeEnabled ? (
                <div className="review-empty-detail review-code-deferred">
                  <Loader2 size={18} className="spin" />
                  <strong>文件列表已就绪</strong>
                  <span>正在按顺序准备代码差异…</span>
                </div>
              ) : selected.conflicted ? (
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
                      <div key={`${diff.snapshotId}:${diff.path}:${diff.scope}`} className="review-diff-reveal">
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
                      </div>
                    ) : <div className="review-empty-detail"><FileDiff size={20} /><span>没有可显示的文本差异</span></div>}
                </div>
              )}
            </>
          ) : capturedChange ? (
            <>
              <div className="review-detail-head" title={capturedChange.path}>
                <span className="review-detail-name">{capturedChange.path}</span>
                <span className="review-captured-badge">会话记录</span>
              </div>
              <div className="review-detail-body review-captured-detail">
                <div className="git-diff-toolbar">
                  <span className="review-captured-note">当前 Git 工作区已无该文件的待审查差异，以下为本轮工具记录。</span>
                  <span className="tool-stats"><span className="stat-add">+{capturedChange.additions}</span><span className="stat-del">−{capturedChange.deletions}</span></span>
                </div>
                {capturedDiff
                  ? (
                    <div key={`${capturedChange.path}:${capturedChange.additions}:${capturedChange.deletions}:${capturedDiff.length}`} className="review-diff-reveal">
                      <DiffView diff={capturedDiff} reveal />
                    </div>
                  )
                  : <div className="review-empty-detail"><FileDiff size={20} /><span>该工具记录没有可显示的文本差异</span></div>}
              </div>
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
