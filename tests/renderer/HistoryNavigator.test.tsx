// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HistoryNavigator } from '../../src/renderer/src/components/HistoryNavigator'
import type { SessionHistoryIndex } from '../../src/shared/types'

const index: SessionHistoryIndex = {
  sessionPath: '/tmp/session.jsonl',
  totalEntries: 4,
  landmarks: [
    { entryId: 'one', entryIndex: 0, ordinal: 1, snippet: 'first', timestamp: '2026-01-01T00:00:00Z' },
    { entryId: 'two', entryIndex: 2, ordinal: 2, snippet: 'second', timestamp: '2026-01-01T00:01:00Z' }
  ]
}

describe('HistoryNavigator', () => {
  it('accepts a dock compensation offset without changing its history geometry', () => {
    const { rerender } = render(
      <HistoryNavigator
        index={index}
        busy={false}
        verticalOffset={58}
        onJump={vi.fn()}
      />
    )
    const navigator = screen.getByLabelText('会话历史快速导航')
    expect(navigator.style.getPropertyValue('--history-navigator-task-offset')).toBe('58px')
    expect(screen.getAllByRole('button')).toHaveLength(2)

    rerender(
      <HistoryNavigator
        index={index}
        busy={false}
        verticalOffset={14}
        onJump={vi.fn()}
      />
    )
    expect(navigator.style.getPropertyValue('--history-navigator-task-offset')).toBe('14px')
  })
})
