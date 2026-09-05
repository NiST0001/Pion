// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ReviewPanel } from '../../src/renderer/src/features/review/ReviewPanel'

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
})
