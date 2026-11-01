// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { GitDiffView } from '../../src/renderer/src/features/review/GitDiffView'
import type { GitDiffHunk, GitFileDiff } from '../../src/shared/types'

function hunk(id: string, count: number, first: number): GitDiffHunk {
  return {
    id, header: `@@ ${id} @@`, oldStart: first, oldLines: count, newStart: first, newLines: count,
    lines: Array.from({ length: count }, (_, index) => ({
      id: `${id}-${index}`, kind: 'add', newLine: first + index, text: `line ${first + index}`
    }))
  }
}

function makeDiff(hunks: GitDiffHunk[]): GitFileDiff {
  return {
    snapshotId: 'snapshot', path: 'file.ts', scope: 'unstaged', binary: false,
    additions: hunks.reduce((sum, entry) => sum + entry.lines.length, 0), deletions: 0,
    selectable: true, rawPatch: '', hunks
  }
}

describe('GitDiffView pagination', () => {
  it('bounds mounted rows across hunks, preserves selected IDs and applies the full original hunk', () => {
    const diff = makeDiff([hunk('small', 10, 1), hunk('large', 240, 11), hunk('tail', 5, 251)])
    const apply = vi.fn()
    function View(): ReactElement {
      const [selected, setSelected] = useState(new Set<string>())
      return <GitDiffView diff={diff} action="stage" selectedLineIds={selected} disabled={false}
        onToggleLine={(id) => setSelected((previous) => new Set([...previous, id]))} onApplyHunk={apply} />
    }
    const { container } = render(<div className="review-detail-body"><View /></div>)
    const scroll = container.firstElementChild as HTMLElement
    expect(container.querySelectorAll('tbody tr')).toHaveLength(120)
    expect(screen.getByText('第 1 / 3 页 · 共 255 行')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: '选择新增行 1' }))
    scroll.scrollTop = 200
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(scroll.scrollTop).toBe(0)
    expect(container.querySelectorAll('tbody tr')).toHaveLength(120)
    expect(screen.getByText(/续页 · 显示 111–230 \/ 240 行/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: '选择新增行 121' }))
    fireEvent.click(screen.getByRole('button', { name: '暂存 hunk（完整 hunk）' }))
    expect(apply).toHaveBeenCalledWith('large')
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(container.querySelectorAll('tbody tr')).toHaveLength(15)
    expect(screen.getByRole('checkbox', { name: '选择新增行 255' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '上一页' }))
    expect(screen.getByRole('checkbox', { name: '选择新增行 121' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: '上一页' }))
    expect(screen.getByRole('checkbox', { name: '选择新增行 1' })).toBeChecked()
  })

  it('resets for a new diff object and retains unrelated row and reveal DOM on selection', () => {
    const diff = makeDiff([hunk('h', 130, 1)])
    const toggle = vi.fn()
    const apply = vi.fn()
    const props = { diff, action: 'stage' as const, selectedLineIds: new Set<string>(), disabled: false, onToggleLine: toggle, onApplyHunk: apply }
    const { rerender } = render(<GitDiffView {...props} />)
    const row = screen.getByRole('checkbox', { name: '选择新增行 2' }).closest('tr')!
    const text = row.querySelector('.git-diff-code')!.firstChild
    rerender(<GitDiffView {...props} selectedLineIds={new Set(['h-0'])} />)
    expect(screen.getByRole('checkbox', { name: '选择新增行 2' }).closest('tr')).toBe(row)
    expect(row.querySelector('.git-diff-code')!.firstChild).toBe(text)
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    rerender(<GitDiffView {...props} diff={{ ...diff, snapshotId: 'next' }} />)
    expect(screen.getByText('第 1 / 2 页 · 共 130 行')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '选择新增行 1' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '暂存 hunk（完整 hunk）' }))
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith('h')
  })

  it('preserves binary, metadata and disabled selection behavior', () => {
    const diff = makeDiff([hunk('h', 1, 1)])
    const props = { action: 'unstage' as const, selectedLineIds: new Set<string>(), disabled: true, onToggleLine: vi.fn(), onApplyHunk: vi.fn() }
    const { rerender } = render(<GitDiffView {...props} diff={{ ...diff, binary: true }} />)
    expect(screen.getByText(/二进制文件/)).toBeInTheDocument()
    rerender(<GitDiffView {...props} diff={{ ...diff, hunks: [] }} />)
    expect(screen.getByText(/元数据变化/)).toBeInTheDocument()
    rerender(<GitDiffView {...props} diff={diff} />)
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(screen.getByRole('button', { name: '取消暂存 hunk' })).toBeDisabled()
    rerender(<GitDiffView {...props} diff={{ ...diff, selectable: false }} />)
    expect(within(screen.getByText('@@ h @@').closest('section')!).queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })
})
