// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatTimeline } from '../../src/renderer/src/features/chat/ChatTimeline'
import type { ChatTimelineProps } from '../../src/renderer/src/features/chat/ChatTimeline'

function emptyTimelineProps(): ChatTimelineProps {
  return {
    scrollRef: createRef<HTMLDivElement>(),
    onScroll: vi.fn(),
    timeline: [],
    timelineLoading: false,
    busy: false,
    starting: false,
    cwd: '/project',
    hasSessions: true,
    canFork: false,
    onFork: vi.fn(),
    agentActivity: false,
    workingStatus: { label: '' },
    latestRunChanges: [],
    runCheckpoint: null,
    rollbackBusy: false,
    rollbackError: '',
    onUndo: vi.fn(),
    onReview: vi.fn(),
    onSelectChange: vi.fn()
  }
}

describe('ChatTimeline empty history state', () => {
  afterEach(cleanup)

  it('keeps a successful empty branch or new conversation ready despite other sessions', () => {
    const view = render(<ChatTimeline {...emptyTimelineProps()} />)
    expect(view.getByRole('heading', { name: 'Pion 已就绪' })).toBeInTheDocument()
    expect(view.queryByRole('button', { name: '重新加载' })).not.toBeInTheDocument()
  })

  it('does not disguise a history failure as readiness or backend startup', () => {
    const view = render(<ChatTimeline {...emptyTimelineProps()} starting timelineError="读取失败" />)
    expect(view.getByRole('heading', { name: '会话历史未加载完成' })).toBeInTheDocument()
    expect(view.queryByText('Pion 已就绪')).not.toBeInTheDocument()
    expect(view.getByText(/请重新选择该会话/)).toBeInTheDocument()
  })

  it('reloads only after an explicit click and hides the action while reading', () => {
    const onReloadHistory = vi.fn()
    const props = { ...emptyTimelineProps(), timelineError: '读取失败', onReloadHistory }
    const view = render(<ChatTimeline {...props} />)
    expect(onReloadHistory).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: '重新加载' }))
    expect(onReloadHistory).toHaveBeenCalledTimes(1)
    view.rerender(<ChatTimeline {...props} timelineLoading />)
    expect(view.getByRole('heading', { name: '正在加载会话…' })).toBeInTheDocument()
    expect(view.queryByRole('button', { name: '重新加载' })).not.toBeInTheDocument()
    expect(onReloadHistory).toHaveBeenCalledTimes(1)
  })

  it('does not replace visible cached or live messages after a history read fails', () => {
    const props = emptyTimelineProps()
    props.timeline = [{ kind: 'user', id: 1, text: '保留消息', historical: true }]
    const view = render(<ChatTimeline {...props} timelineError="读取失败" />)
    expect(view.getByText('保留消息')).toBeInTheDocument()
    expect(view.queryByText('会话历史未加载完成')).not.toBeInTheDocument()
  })
})
