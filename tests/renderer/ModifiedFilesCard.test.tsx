// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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

describe('ModifiedFilesCard', () => {
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
