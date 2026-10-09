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

  it('shows selected but unaccepted history as unloaded even without a read diagnostic', () => {
    const onReloadHistory = vi.fn()
    const props = { ...emptyTimelineProps(), historySelected: true, timelineReady: false, onReloadHistory, starting: true }
    const view = render(<ChatTimeline {...props} />)
    expect(view.getByRole('heading', { name: '会话历史未加载完成' })).toBeInTheDocument()
    expect(view.queryByText('Pion 已就绪')).not.toBeInTheDocument()
    expect(view.queryByText('正在启动 agent…')).not.toBeInTheDocument()
    expect(view.getByText(/请重新加载会话历史/)).toBeInTheDocument()
    expect(onReloadHistory).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: '重新加载' }))
    expect(onReloadHistory).toHaveBeenCalledTimes(1)
    view.rerender(<ChatTimeline {...props} timelineLoading />)
    expect(view.getByRole('heading', { name: '正在加载会话…' })).toBeInTheDocument()
    expect(view.queryByRole('button', { name: '重新加载' })).not.toBeInTheDocument()
    expect(onReloadHistory).toHaveBeenCalledTimes(1)
  })

  it('keeps an accepted empty selected branch ready without requesting a reload', () => {
    const onReloadHistory = vi.fn()
    const view = render(<ChatTimeline {...emptyTimelineProps()} historySelected timelineReady onReloadHistory={onReloadHistory} />)
    expect(view.getByRole('heading', { name: 'Pion 已就绪' })).toBeInTheDocument()
    expect(view.queryByRole('button', { name: '重新加载' })).not.toBeInTheDocument()
    expect(onReloadHistory).not.toHaveBeenCalled()
  })

  it('does not call an unselected new conversation unloaded merely because history has not been accepted', () => {
    const view = render(<ChatTimeline {...emptyTimelineProps()} timelineReady={false} />)
    expect(view.getByRole('heading', { name: 'Pion 已就绪' })).toBeInTheDocument()
    expect(view.queryByRole('button', { name: '重新加载' })).not.toBeInTheDocument()
  })

  it('retains legacy readiness when a caller selects history without supplying the acceptance flag', () => {
    const view = render(<ChatTimeline {...emptyTimelineProps()} historySelected />)
    expect(view.getByRole('heading', { name: 'Pion 已就绪' })).toBeInTheDocument()
  })

  it('keeps the existing working indicator instead of an unloaded empty state while busy', () => {
    const onReloadHistory = vi.fn()
    const view = render(<ChatTimeline {...emptyTimelineProps()} busy agentActivity historySelected timelineReady={false}
      workingStatus={{ label: '思考中...' }} onReloadHistory={onReloadHistory} />)
    expect(view.getByRole('status')).toHaveTextContent('思考中...')
    expect(view.queryByRole('heading')).not.toBeInTheDocument()
    expect(view.queryByRole('button', { name: '重新加载' })).not.toBeInTheDocument()
    expect(onReloadHistory).not.toHaveBeenCalled()
  })

  it('keeps partial live rows and activity visible even when a history read was not accepted', () => {
    const props = emptyTimelineProps()
    props.timeline = [{ kind: 'user', id: 2, text: '当前消息', live: true }]
    const view = render(<ChatTimeline {...props} busy agentActivity historySelected timelineReady={false}
      timelineError="会话历史未载入，请重新加载。" workingStatus={{ label: '组织回复中...' }} />)
    expect(view.getByText('当前消息')).toBeInTheDocument()
    expect(view.getByRole('status')).toHaveTextContent('组织回复中...')
    expect(view.queryByText('会话历史未加载完成')).not.toBeInTheDocument()
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
    const view = render(<ChatTimeline {...props} historySelected timelineReady={false} timelineError="读取失败" />)
    expect(view.getByText('保留消息')).toBeInTheDocument()
    expect(view.queryByText('会话历史未加载完成')).not.toBeInTheDocument()
  })
})
