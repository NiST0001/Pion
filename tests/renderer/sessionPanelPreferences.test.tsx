// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadPanelExpanded, savePanelExpanded } from '../../src/renderer/src/utils/sessionPanelPreferences'
import { TaskPanel } from '../../src/renderer/src/features/session/TaskPanel'
import { QueuedMessagesCard } from '../../src/renderer/src/features/session/QueuedMessagesCard'

const kinds = ['task', 'queue'] as const
const sessionKey = 'worktree / 会话:?%😀'
const key = (kind: typeof kinds[number], session = sessionKey) => `pion:session-${kind}-panel-state:${encodeURIComponent(session)}`

describe('session panel preferences', () => {
  beforeEach(() => window.localStorage.clear())
  afterEach(() => { vi.unstubAllGlobals(); cleanup(); vi.restoreAllMocks() })

  it.each(kinds)('preserves the missing %s preference default', (kind) => {
    expect(loadPanelExpanded(kind, sessionKey)).toBe(kind === 'queue')
    expect(window.localStorage.length).toBe(0)
  })

  it.each(kinds.flatMap((kind) => [false, true].map((expanded) => ({ kind, expanded }))))(
    'round-trips $kind=$expanded with the existing encoded key', ({ kind, expanded }) => {
      savePanelExpanded(kind, sessionKey, expanded)
      expect(window.localStorage.getItem(key(kind))).toBe(JSON.stringify(expanded))
      expect(loadPanelExpanded(kind, sessionKey)).toBe(expanded)
    })

  it.each(kinds.flatMap((kind) => ['', '{', 'null', '0', '1', '"true"', '[]', '{}'].map((raw) => ({ kind, raw }))))(
    'ignores invalid/nonboolean $kind preference $raw without rewriting it', ({ kind, raw }) => {
      window.localStorage.setItem(key(kind), raw)
      expect(loadPanelExpanded(kind, sessionKey)).toBe(kind === 'queue')
      expect(window.localStorage.getItem(key(kind))).toBe(raw)
    })

  it('keeps namespaces and distinct sessions independent, including literal percent encodings', () => {
    savePanelExpanded('task', 'a/b', true)
    savePanelExpanded('queue', 'a/b', false)
    savePanelExpanded('task', 'a%2Fb', false)
    expect(loadPanelExpanded('task', 'a/b')).toBe(true)
    expect(loadPanelExpanded('queue', 'a/b')).toBe(false)
    expect(loadPanelExpanded('task', 'a%2Fb')).toBe(false)
    expect(loadPanelExpanded('queue', 'a%2Fb')).toBe(true)
    expect(window.localStorage.length).toBe(3)
  })

  it.each(kinds)('keeps %s key encoding errors inside the best-effort boundary', (kind) => {
    const get = vi.spyOn(Storage.prototype, 'getItem')
    const set = vi.spyOn(Storage.prototype, 'setItem')
    expect(loadPanelExpanded(kind, '\uD800')).toBe(kind === 'queue')
    expect(() => savePanelExpanded(kind, '\uD800', true)).not.toThrow()
    expect(get).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it.each(kinds)('tolerates %s storage method failures', (kind) => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('read denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('write denied') })
    expect(loadPanelExpanded(kind, sessionKey)).toBe(kind === 'queue')
    expect(() => savePanelExpanded(kind, sessionKey, true)).not.toThrow()
  })

  it('tolerates localStorage access failures and windowless callers', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('storage denied') })
    expect(loadPanelExpanded('task', sessionKey)).toBe(false)
    expect(loadPanelExpanded('queue', sessionKey)).toBe(true)
    expect(() => savePanelExpanded('task', sessionKey, true)).not.toThrow()
    vi.stubGlobal('window', undefined)
    expect(loadPanelExpanded('task', sessionKey)).toBe(false)
    expect(loadPanelExpanded('queue', sessionKey)).toBe(true)
    expect(() => savePanelExpanded('queue', sessionKey, false)).not.toThrow()
  })

  describe('panel integration', () => {
    function Panels({ session = sessionKey }: { session?: string }) {
      return <>
        <TaskPanel sessionKey={session} agentTodos={[{ id: 1, title: 'Pending task', status: 'pending' }]} />
        <QueuedMessagesCard sessionKey={session} followUp={['Queued message']} />
      </>
    }

    it('restores independent old keys, retains mounted panels while toggling, and persists for remount', () => {
      window.localStorage.setItem(key('task'), 'true')
      window.localStorage.setItem(key('queue'), 'false')
      const { container, unmount } = render(<Panels />)
      const task = container.querySelector('.task-panel-agent')
      const queue = container.querySelector('.queue-panel')
      expect(task).toBeInTheDocument()
      expect(queue).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '收起目标任务' })).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('button', { name: '展开排队消息' })).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(screen.getByRole('button', { name: '收起目标任务' }))
      fireEvent.click(screen.getByRole('button', { name: '展开排队消息' }))
      expect(container.querySelector('.task-panel-agent')).toBe(task)
      expect(container.querySelector('.queue-panel')).toBe(queue)
      expect(window.localStorage.getItem(key('task'))).toBe('false')
      expect(window.localStorage.getItem(key('queue'))).toBe('true')
      unmount()
      render(<Panels />)
      expect(screen.getByRole('button', { name: '展开目标任务' })).toHaveAttribute('aria-expanded', 'false')
      expect(screen.getByRole('button', { name: '收起排队消息' })).toHaveAttribute('aria-expanded', 'true')
    })

    it('retains distinct defaults when stored preferences are damaged', () => {
      window.localStorage.setItem(key('task'), '"true"')
      window.localStorage.setItem(key('queue'), '{')
      render(<Panels />)
      expect(screen.getByRole('button', { name: '展开目标任务' })).toHaveAttribute('aria-expanded', 'false')
      expect(screen.getByRole('button', { name: '收起排队消息' })).toHaveAttribute('aria-expanded', 'true')
    })

    it.each(['encoding', 'storage'])('does not let %s failure stop panel rendering or toggling', (failure) => {
      if (failure === 'storage') {
        vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('unavailable') })
      }
      render(<Panels session={failure === 'encoding' ? '\uD800' : sessionKey} />)
      fireEvent.click(screen.getByRole('button', { name: '展开目标任务' }))
      fireEvent.click(screen.getByRole('button', { name: '收起排队消息' }))
      expect(screen.getByRole('button', { name: '收起目标任务' })).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('button', { name: '展开排队消息' })).toHaveAttribute('aria-expanded', 'false')
    })
  })
})
