import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FilePenLine,
  FilePlus2,
  Folder,
  FolderOpen,
  Trash2
} from 'lucide-react'
import type { GitDiffScope, GitFileStatus } from '../../../../shared/types'
import { buildFileTree, parentDirectories } from './reviewFileTreeModel'
import type { ReviewFileTreeNode } from './reviewFileTreeModel'

function fileIcon(file: GitFileStatus): ReactElement {
  if (file.kind === 'added' || file.kind === 'untracked') return <FilePlus2 size={14} />
  if (file.kind === 'deleted') return <Trash2 size={14} />
  if (file.conflicted) return <AlertTriangle size={14} />
  return <FilePenLine size={14} />
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
            {file.additions !== undefined && file.deletions !== undefined && (
              <span
                className="tool-stats review-file-stats"
                title="工作区变更行数：已暂存 + 未暂存，包含未跟踪文件；与会话工作区卡片一致"
              >
                <span className="stat-add">+{file.additions}</span>
                <span className="stat-del">−{file.deletions}</span>
              </span>
            )}
            <span className="git-file-code">{scope === 'staged' ? file.indexCode : file.worktreeCode}</span>
          </button>
        )
      })}
    </>
  )
}

export function ReviewFileTree({
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
