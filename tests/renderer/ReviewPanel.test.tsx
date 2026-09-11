// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ReviewPanel } from '../../src/renderer/src/features/review/ReviewPanel'
import type { GitFileStatus, GitWorkspaceSnapshot } from '../../src/shared/types'

function file(path: string, overrides: Partial<GitFileStatus> = {}): GitFileStatus {
  return {
    path,
    kind: 'modified',
    indexCode: ' ',
    worktreeCode: 'M',
    staged: false,
    unstaged: true,
    conflicted: false,
    binary: false,
    ...overrides
  }
}

function snapshot(files: GitFileStatus[], snapshotId = 'workspace-snapshot'): GitWorkspaceSnapshot {
  return {
    snapshotId,
    root: '/workspace',
    head: 'abc123',
    branch: 'main',
    ahead: 0,
    behind: 0,
    operation: 'none',
    files,
    stagedCount: files.filter((entry) => entry.staged).length,
    unstagedCount: files.filter((entry) => entry.unstaged).length,
    conflictCount: files.filter((entry) => entry.conflicted).length,
    capturedAt: Date.now()
  }
}

function panelProps(files: GitFileStatus[]): ComponentProps<typeof ReviewPanel> {
  return {
    snapshot: snapshot(files),
    diff: null,
    conflict: null,
    selectedPath: null,
    capturedChange: null,
    scope: 'unstaged',
    checkpoint: null,
    agentBusy: false,
    loading: false,
    codeEnabled: true,
    diffLoading: false,
    gitBusy: false,
    gitError: '',
    gitResult: '',
    rollbackBusy: false,
    rollbackError: '',
    onSelect: vi.fn(),
    onScopeChange: vi.fn(),
    onLoadDiff: vi.fn(),
    onStage: vi.fn(),
    onUnstage: vi.fn(),
    onDiscard: vi.fn(),
    onApplySelection: vi.fn(),
    onCommit: vi.fn(async () => false),
    onReadConflict: vi.fn(),
    onResolveConflict: vi.fn(),
    onContinueOperation: vi.fn(),
    onAbortOperation: vi.fn(),
    onRollback: vi.fn(),
    onClose: vi.fn()
  }
}

function fileRow(tree: HTMLElement, name: string): HTMLElement {
  const row = within(tree).getByText(name, { selector: '.review-file-name' }).closest<HTMLElement>('[role="treeitem"]')
  expect(row).not.toBeNull()
  return row!
}

function expectFileStats(row: HTMLElement, additions: number, deletions: number): HTMLElement {
  const stats = row.querySelector<HTMLElement>('.tool-stats.review-file-stats')
  expect(stats).toBeInTheDocument()
  expect(within(stats!).getByText(`+${additions}`)).toHaveClass('stat-add')
  expect(within(stats!).getByText(`−${deletions}`)).toHaveClass('stat-del')
  return stats!
}

describe('ReviewPanel', () => {
  it('shows the captured tool diff when the live Git workspace is already clean', () => {
    const { container } = render(
      <ReviewPanel
        snapshot={{
          snapshotId: 'clean-snapshot',
          root: '/workspace',
          head: 'abc123',
          branch: 'main',
          ahead: 0,
          behind: 0,
          operation: 'none',
          files: [],
          stagedCount: 0,
          unstagedCount: 0,
          conflictCount: 0,
          capturedAt: Date.now()
        }}
        diff={null}
        conflict={null}
        selectedPath={null}
        capturedChange={{
          path: '/workspace/src/example.ts',
          kind: 'write',
          content: 'export const answer = 42',
          additions: 1,
          deletions: 0
        }}
        scope="unstaged"
        checkpoint={null}
        agentBusy={false}
        loading={false}
        codeEnabled
        diffLoading={false}
        gitBusy={false}
        gitError=""
        gitResult=""
        rollbackBusy={false}
        rollbackError=""
        width={520}
        onSelect={vi.fn()}
        onScopeChange={vi.fn()}
        onLoadDiff={vi.fn()}
        onStage={vi.fn()}
        onUnstage={vi.fn()}
        onDiscard={vi.fn()}
        onApplySelection={vi.fn()}
        onCommit={vi.fn(async () => false)}
        onReadConflict={vi.fn()}
        onResolveConflict={vi.fn()}
        onContinueOperation={vi.fn()}
        onAbortOperation={vi.fn()}
        onRollback={vi.fn()}
        onClose={vi.fn()}
        onResizeStart={vi.fn()}
      />
    )

    expect(screen.getByText('工作区干净')).toBeInTheDocument()
    expect(screen.getByText('/workspace/src/example.ts')).toBeInTheDocument()
    expect(screen.getByText('会话记录')).toBeInTheDocument()
    expect(container.querySelector('.diff-text')).toHaveTextContent('export const answer = 42')
    expect(container.querySelector('.review-diff-reveal')).toBeInTheDocument()
  })

  it('shows counts and status codes for modified, added, deleted and untracked files before diff loading', () => {
    const props = panelProps([
      file('src/modified.ts', { additions: 12, deletions: 4 }),
      file('src/added.ts', {
        kind: 'added', indexCode: 'A', worktreeCode: ' ', staged: true, unstaged: false,
        additions: 7, deletions: 0
      }),
      file('src/deleted.ts', { kind: 'deleted', worktreeCode: 'D', additions: 0, deletions: 8 }),
      file('notes.txt', { kind: 'untracked', indexCode: '?', worktreeCode: '?', additions: 5, deletions: 0 })
    ])
    render(<ReviewPanel {...props} selectedPath="src/modified.ts" codeEnabled={false} />)

    const stagedTree = screen.getByRole('tree', { name: '已暂存文件树' })
    const unstagedTree = screen.getByRole('tree', { name: '修改文件树' })
    const rows = [
      { row: fileRow(unstagedTree, 'modified.ts'), additions: 12, deletions: 4, code: 'M' },
      { row: fileRow(stagedTree, 'added.ts'), additions: 7, deletions: 0, code: 'A' },
      { row: fileRow(unstagedTree, 'deleted.ts'), additions: 0, deletions: 8, code: 'D' },
      { row: fileRow(unstagedTree, 'notes.txt'), additions: 5, deletions: 0, code: '?' }
    ]
    for (const { row, additions, deletions, code } of rows) {
      expectFileStats(row, additions, deletions)
      expect(within(row).getByText(code, { selector: '.git-file-code' })).toBeInTheDocument()
    }
    expect(props.onLoadDiff).not.toHaveBeenCalled()
  })

  it('uses the same workspace totals in both groups rather than the loaded scope diff counts', () => {
    const props = panelProps([
      file('src/shared.ts', {
        kind: 'added', indexCode: 'A', staged: true, additions: 17, deletions: 9
      })
    ])
    render(
      <ReviewPanel
        {...props}
        selectedPath="src/shared.ts"
        scope="staged"
        diff={{
          snapshotId: 'workspace-snapshot',
          path: 'src/shared.ts',
          scope: 'staged',
          binary: false,
          additions: 12,
          deletions: 0,
          hunks: [],
          selectable: false,
          rawPatch: ''
        }}
      />
    )

    for (const [treeName, code] of [['已暂存文件树', 'A'], ['修改文件树', 'M']] as const) {
      const row = fileRow(screen.getByRole('tree', { name: treeName }), 'shared.ts')
      const stats = expectFileStats(row, 17, 9)
      expect(stats).toHaveAttribute('title', expect.stringContaining('已暂存 + 未暂存'))
      expect(within(row).getByText(code, { selector: '.git-file-code' })).toBeInTheDocument()
      expect(within(row).queryByText('+12')).not.toBeInTheDocument()
      expect(within(row).queryByText('−0')).not.toBeInTheDocument()
    }
  })

  it('preserves real zero counts, hides incomplete counts, and refreshes them with the snapshot', () => {
    const props = panelProps([
      file('zero.ts', { additions: 0, deletions: 0 }),
      file('missing.ts'),
      file('add-only.ts', { additions: 8 }),
      file('delete-only.ts', { deletions: 5 })
    ])
    const { rerender } = render(<ReviewPanel {...props} />)
    const tree = screen.getByRole('tree', { name: '修改文件树' })

    expectFileStats(fileRow(tree, 'zero.ts'), 0, 0)
    for (const name of ['missing.ts', 'add-only.ts', 'delete-only.ts']) {
      const row = fileRow(tree, name)
      expect(row.querySelector('.review-file-stats, .stat-add, .stat-del')).not.toBeInTheDocument()
      expect(within(row).getByText('M', { selector: '.git-file-code' })).toBeInTheDocument()
    }

    rerender(
      <ReviewPanel
        {...props}
        snapshot={snapshot([
          file('zero.ts', { additions: 9, deletions: 4 }),
          file('missing.ts', { additions: 6, deletions: 2 }),
          file('add-only.ts', { additions: 8, deletions: 0 }),
          file('delete-only.ts', { additions: 0, deletions: 5 })
        ], 'updated-snapshot')}
      />
    )
    const updatedTree = screen.getByRole('tree', { name: '修改文件树' })
    expectFileStats(fileRow(updatedTree, 'zero.ts'), 9, 4)
    expectFileStats(fileRow(updatedTree, 'missing.ts'), 6, 2)
    expectFileStats(fileRow(updatedTree, 'add-only.ts'), 8, 0)
    expectFileStats(fileRow(updatedTree, 'delete-only.ts'), 0, 5)

    rerender(<ReviewPanel {...props} snapshot={snapshot([file('zero.ts')], 'missing-counts-snapshot')} />)
    const missingRow = fileRow(screen.getByRole('tree', { name: '修改文件树' }), 'zero.ts')
    expect(missingRow.querySelector('.review-file-stats, .stat-add, .stat-del')).not.toBeInTheDocument()
    expect(props.onLoadDiff).not.toHaveBeenCalled()
  })

  it('keeps nested directories independently collapsible and selects the full path and scope from counts', () => {
    const props = panelProps([
      file('src/features/editor.ts', { indexCode: 'M', staged: true, additions: 7, deletions: 3 }),
      file('src/sibling.ts', { indexCode: 'M', staged: true, additions: 2, deletions: 1 })
    ])
    render(<ReviewPanel {...props} />)
    const stagedTree = screen.getByRole('tree', { name: '已暂存文件树' })
    const unstagedTree = screen.getByRole('tree', { name: '修改文件树' })

    fireEvent.click(within(stagedTree).getByRole('treeitem', { name: '收起目录 src/features' }))
    expect(within(stagedTree).getByRole('treeitem', { name: '展开目录 src/features' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(stagedTree).queryByText('editor.ts', { selector: '.review-file-name' })).not.toBeInTheDocument()
    expectFileStats(fileRow(stagedTree, 'sibling.ts'), 2, 1)
    expectFileStats(fileRow(unstagedTree, 'editor.ts'), 7, 3)

    fireEvent.click(within(stagedTree).getByRole('treeitem', { name: '收起目录 src' }))
    expect(within(stagedTree).queryByText('sibling.ts', { selector: '.review-file-name' })).not.toBeInTheDocument()
    fireEvent.click(within(stagedTree).getByRole('treeitem', { name: '展开目录 src' }))
    expect(within(stagedTree).queryByText('editor.ts', { selector: '.review-file-name' })).not.toBeInTheDocument()
    expectFileStats(fileRow(stagedTree, 'sibling.ts'), 2, 1)
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onScopeChange).not.toHaveBeenCalled()

    fireEvent.click(within(fileRow(unstagedTree, 'editor.ts')).getByText('+7', { selector: '.stat-add' }))
    expect(props.onSelect).toHaveBeenLastCalledWith('src/features/editor.ts')
    expect(props.onScopeChange).toHaveBeenLastCalledWith('unstaged')

    fireEvent.click(within(stagedTree).getByRole('treeitem', { name: '展开目录 src/features' }))
    expect(within(stagedTree).getByRole('treeitem', { name: '收起目录 src/features' })).toHaveAttribute('aria-expanded', 'true')
    const stagedRow = fileRow(stagedTree, 'editor.ts')
    expectFileStats(stagedRow, 7, 3)
    fireEvent.click(within(stagedRow).getByText('−3', { selector: '.stat-del' }))
    expect(props.onSelect).toHaveBeenLastCalledWith('src/features/editor.ts')
    expect(props.onScopeChange).toHaveBeenLastCalledWith('staged')
    expect(props.onSelect).toHaveBeenCalledTimes(2)
    expect(props.onScopeChange).toHaveBeenCalledTimes(2)
  })

  it('retains collapsed directories and the commit draft when an unrelated snapshot changes', () => {
    const files = [
      file('src/features/editor.ts', { indexCode: 'M', staged: true, additions: 7, deletions: 3 }),
      file('src/sibling.ts', { indexCode: 'M', staged: true, additions: 2, deletions: 1 })
    ]
    const props = { ...panelProps(files), selectedPath: 'src/features/editor.ts', scope: 'staged' as const }
    const { rerender } = render(<ReviewPanel {...props} />)
    const stagedTree = screen.getByRole('tree', { name: '已暂存文件树' })
    const unstagedTree = screen.getByRole('tree', { name: '修改文件树' })
    const commitDraft = screen.getByPlaceholderText('提交说明')

    fireEvent.click(within(stagedTree).getByRole('treeitem', { name: '收起目录 src/features' }))
    fireEvent.click(within(unstagedTree).getByRole('treeitem', { name: '收起目录 src' }))
    fireEvent.change(commitDraft, { target: { value: '保留未提交的说明' } })

    rerender(
      <ReviewPanel
        {...props}
        snapshot={snapshot([
          ...files.map((entry) => ({ ...entry })),
          file('notes.txt', { kind: 'untracked', indexCode: '?', worktreeCode: '?' })
        ], 'unrelated-file-update')}
      />
    )

    expect(screen.getByRole('tree', { name: '已暂存文件树' })).toBe(stagedTree)
    expect(screen.getByRole('tree', { name: '修改文件树' })).toBe(unstagedTree)
    expect(within(stagedTree).getByRole('treeitem', { name: '展开目录 src/features' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(stagedTree).queryByText('editor.ts', { selector: '.review-file-name' })).not.toBeInTheDocument()
    expectFileStats(fileRow(stagedTree, 'sibling.ts'), 2, 1)
    expect(within(unstagedTree).getByRole('treeitem', { name: '展开目录 src' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(unstagedTree).queryByText('sibling.ts', { selector: '.review-file-name' })).not.toBeInTheDocument()
    expect(fileRow(unstagedTree, 'notes.txt')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('提交说明')).toBe(commitDraft)
    expect(commitDraft).toHaveValue('保留未提交的说明')
    expect(props.onCommit).not.toHaveBeenCalled()
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onScopeChange).not.toHaveBeenCalled()
  })

  it('expands only the selected path ancestors in the active group for external selections', () => {
    const props = panelProps([
      file('src/features/editor.ts', {
        oldPath: 'legacy/editor.ts', kind: 'renamed', indexCode: 'R', staged: true,
        additions: 7, deletions: 3
      }),
      file('src/other/sibling.ts', { indexCode: 'M', staged: true })
    ])
    const { rerender } = render(<ReviewPanel {...props} />)
    const stagedTree = screen.getByRole('tree', { name: '已暂存文件树' })
    const unstagedTree = screen.getByRole('tree', { name: '修改文件树' })

    for (const tree of [stagedTree, unstagedTree]) {
      fireEvent.click(within(tree).getByRole('treeitem', { name: '收起目录 src/features' }))
      fireEvent.click(within(tree).getByRole('treeitem', { name: '收起目录 src/other' }))
      fireEvent.click(within(tree).getByRole('treeitem', { name: '收起目录 src' }))
    }

    rerender(<ReviewPanel {...props} selectedPath="src/features/editor.ts" scope="staged" />)

    expect(within(stagedTree).getByRole('treeitem', { name: '收起目录 src' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(stagedTree).getByRole('treeitem', { name: '收起目录 src/features' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(stagedTree).getByRole('treeitem', { name: '展开目录 src/other' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(unstagedTree).getByRole('treeitem', { name: '展开目录 src' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(unstagedTree).queryByText('editor.ts', { selector: '.review-file-name' })).not.toBeInTheDocument()
    const stagedRow = fileRow(stagedTree, 'editor.ts')
    expect(stagedRow).toHaveClass('active')
    expect(stagedRow).toHaveAttribute('title', 'legacy/editor.ts → src/features/editor.ts')
    expect(within(stagedRow).getByText('R', { selector: '.git-file-code' })).toBeInTheDocument()
    expectFileStats(stagedRow, 7, 3)
    expect(props.onLoadDiff).toHaveBeenLastCalledWith('src/features/editor.ts', 'staged')

    rerender(<ReviewPanel {...props} selectedPath="src/features/editor.ts" scope="unstaged" />)

    expect(within(unstagedTree).getByRole('treeitem', { name: '收起目录 src' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(unstagedTree).getByRole('treeitem', { name: '收起目录 src/features' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(unstagedTree).getByRole('treeitem', { name: '展开目录 src/other' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(stagedTree).getByRole('treeitem', { name: '展开目录 src/other' })).toHaveAttribute('aria-expanded', 'false')
    expect(stagedRow).not.toHaveClass('active')
    const unstagedRow = fileRow(unstagedTree, 'editor.ts')
    expect(unstagedRow).toHaveClass('active')
    expect(unstagedRow).toHaveAttribute('title', 'legacy/editor.ts → src/features/editor.ts')
    expect(within(unstagedRow).getByText('M', { selector: '.git-file-code' })).toBeInTheDocument()
    expect(props.onLoadDiff).toHaveBeenLastCalledWith('src/features/editor.ts', 'unstaged')
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onScopeChange).not.toHaveBeenCalled()
  })

  it('keeps conflict, staged and unstaged tree state separate when the conflict group is temporarily empty', () => {
    const conflictedFile = file('src/conflict.ts', {
      kind: 'conflicted', indexCode: 'U', worktreeCode: 'U', conflicted: true,
      additions: 4, deletions: 2
    })
    const sharedFile = file('src/features/editor.ts', { indexCode: 'M', staged: true })
    const props = panelProps([conflictedFile, sharedFile])
    const { rerender } = render(<ReviewPanel {...props} />)
    const conflictTree = screen.getByRole('tree', { name: '冲突文件树' })
    const stagedTree = screen.getByRole('tree', { name: '已暂存文件树' })
    const unstagedTree = screen.getByRole('tree', { name: '修改文件树' })
    expect(screen.getAllByRole('tree')).toEqual([conflictTree, stagedTree, unstagedTree])

    fireEvent.click(within(conflictTree).getByRole('treeitem', { name: '收起目录 src' }))
    fireEvent.click(within(stagedTree).getByRole('treeitem', { name: '收起目录 src/features' }))
    expect(fileRow(unstagedTree, 'editor.ts')).toBeInTheDocument()

    rerender(<ReviewPanel {...props} snapshot={snapshot([sharedFile], 'without-conflicts')} />)

    expect(screen.queryByRole('tree', { name: '冲突文件树' })).not.toBeInTheDocument()
    expect(screen.getByRole('tree', { name: '已暂存文件树' })).toBe(stagedTree)
    expect(screen.getByRole('tree', { name: '修改文件树' })).toBe(unstagedTree)
    expect(within(stagedTree).getByRole('treeitem', { name: '展开目录 src/features' })).toHaveAttribute('aria-expanded', 'false')
    expect(fileRow(unstagedTree, 'editor.ts')).toBeInTheDocument()

    rerender(<ReviewPanel {...props} snapshot={snapshot([conflictedFile, sharedFile], 'conflicts-return')} />)

    const restoredConflictTree = screen.getByRole('tree', { name: '冲突文件树' })
    expect(screen.getAllByRole('tree')).toEqual([restoredConflictTree, stagedTree, unstagedTree])
    expect(within(restoredConflictTree).getByRole('treeitem', { name: '展开目录 src' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(restoredConflictTree).queryByText('conflict.ts', { selector: '.review-file-name' })).not.toBeInTheDocument()
    expect(within(stagedTree).getByRole('treeitem', { name: '展开目录 src/features' })).toHaveAttribute('aria-expanded', 'false')
    expect(fileRow(unstagedTree, 'editor.ts')).toBeInTheDocument()

    fireEvent.click(within(restoredConflictTree).getByRole('treeitem', { name: '展开目录 src' }))
    const conflictRow = fileRow(restoredConflictTree, 'conflict.ts')
    expect(conflictRow).toHaveClass('conflicted')
    expect(within(conflictRow).getByText('U', { selector: '.git-file-code' })).toBeInTheDocument()
    expectFileStats(conflictRow, 4, 2)
    fireEvent.click(conflictRow)
    expect(props.onSelect).toHaveBeenLastCalledWith('src/conflict.ts')
    expect(props.onScopeChange).toHaveBeenLastCalledWith('unstaged')

    rerender(<ReviewPanel {...props} selectedPath="src/conflict.ts" scope="staged" />)

    expect(conflictRow).toHaveClass('active', 'conflicted')
    expect(props.onReadConflict).toHaveBeenLastCalledWith('src/conflict.ts')
  })
})
