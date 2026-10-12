// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModifiedFilesCard } from '../../src/renderer/src/features/review/ModifiedFilesCard'
import type { FileChange } from '../../src/renderer/src/agent/types'

const changes: FileChange[] = [
  {
    path: '/workspace/apps/server/src/lib.rs',
    kind: 'edit',
    diff: '+one',
    additions: 1,
    deletions: 0
  },
  {
    path: '/workspace/apps/server/src/ai/mod.rs',
    kind: 'edit',
    diff: '+two\n-old',
    additions: 1,
    deletions: 1
  }
]

afterEach(cleanup)

const cardProps = { canUndo: true, undoBusy: false, error: '', onUndo: vi.fn(), onReview: vi.fn(), onSelect: vi.fn() }

describe('ModifiedFilesCard', () => {
  it('filters media and binary evidence from rows, counts and totals without changing actions', () => {
    const hidden: FileChange[] = ['photo.PNG', 'clip.mp4', 'music.mp3', 'drawing.svg', 'archive.zip'].map(path => ({
      path, kind: 'edit', additions: 100, deletions: 20
    }))
    hidden.push({ path: 'unknown.data', kind: 'edit', binary: true, additions: 100, deletions: 20 })
    const onUndo = vi.fn(), onReview = vi.fn()
    const view = render(<ModifiedFilesCard {...cardProps} changes={[...changes, ...hidden]} workspace onUndo={onUndo} onReview={onReview} />)
    expect(view.container.querySelector('strong')).toHaveTextContent('工作区已编辑 2 个文件')
    expect(view.container.querySelector('.modified-files-total')).toHaveTextContent('+2−1')
    expect(view.container.querySelectorAll('.modified-files-row')).toHaveLength(2)
    for (const item of hidden) expect(view.queryByTitle(`查看 ${item.path} 的变更`)).toBeNull()
    expect(view.queryByText(/再显示/)).toBeNull()
    fireEvent.click(view.getByRole('button', { name: '撤销本轮' }))
    fireEvent.click(view.getByRole('button', { name: '打开文件与审查栏' }))
    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(onReview).toHaveBeenCalledTimes(1)
  })

  it('keeps text and extensionless files, and hides an all-media card', () => {
    const items: FileChange[] = ['README', '.gitignore', 'notes.custom'].map(path => ({ path, kind: 'write', additions: 1, deletions: 0 }))
    const view = render(<ModifiedFilesCard {...cardProps} changes={items} />)
    expect(view.container.querySelectorAll('.modified-files-row')).toHaveLength(3)
    view.rerender(<ModifiedFilesCard {...cardProps} changes={[{ path: 'C:\\media\\CLIP.MOV', kind: 'write', additions: 0, deletions: 0 }]} />)
    expect(view.container.querySelector('.modified-files-card')).toBeNull()
  })

  it('opens review from both the header action and an individual file', () => {
    const onReview = vi.fn()
    const onSelect = vi.fn()
    render(
      <ModifiedFilesCard
        changes={changes}
        cwd="/workspace"
        canUndo={false}
        undoBusy={false}
        error=""
        onUndo={vi.fn()}
        onReview={onReview}
        onSelect={onSelect}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '打开文件与审查栏' }))
    expect(onReview).toHaveBeenCalledTimes(1)

    const row = screen.getByTitle('查看 /workspace/apps/server/src/ai/mod.rs 的变更')
    fireEvent.pointerUp(row, { button: 0, pointerType: 'mouse' })
    fireEvent.click(row, { detail: 1 })
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(changes[1])
  })
})
