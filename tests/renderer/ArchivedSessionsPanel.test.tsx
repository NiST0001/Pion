// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionOrganization } from '../../src/shared/session-organization'
import type { SessionMeta } from '../../src/shared/types'
import { ArchivedSessionsPanel } from '../../src/renderer/src/features/session/ArchivedSessionsPanel'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const cwd = '/project', branchCwd = '/project/worktree', path = '/sessions/shared.jsonl'
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
// Only display fields are consumed here; SDK identity and timing stay absent.
const displayMeta = (fields: Pick<SessionMeta, 'path' | 'projectCwd' | 'name' | 'preview'>): SessionMeta => fields as SessionMeta
function organization(): SessionOrganization {
  return { version: 1, revision: 1, folders: [], sessions: [
    { cwd, path, archived: true, title: '已保存主会话标题' },
    { cwd: branchCwd, path, archived: true, title: '已保存分支标题' },
    { cwd, path: '/sessions/missing.jsonl', archived: true, title: '保留标题' },
    { cwd, path: '/sessions/mismatch.jsonl', archived: true, title: '归属隔离标题' },
    { cwd, path: '/sessions/visible.jsonl', archived: false, title: '普通会话' },
    { cwd, path: '/sessions/unset.jsonl', title: '未归档会话' }
  ] }
}
function props(): ComponentProps<typeof ArchivedSessionsPanel> {
  return { organization: organization(), sessionsByProject: {
    [cwd]: [displayMeta({ path, projectCwd: cwd, name: '真实主会话', preview: '主会话预览' }),
      displayMeta({ path: '/sessions/mismatch.jsonl', projectCwd: branchCwd, name: '错误归属元数据', preview: '' })],
    [branchCwd]: [displayMeta({ path, projectCwd: branchCwd, preview: '真实分支预览' })]
  }, ready: true, loading: false, saving: false, error: '', activePath: undefined,
    runningSessionPaths: new Set(), unreadSessionPaths: new Set(), attentionSessionPaths: new Set(),
    onRefresh: vi.fn().mockResolvedValue(undefined), onSelect: vi.fn().mockResolvedValue(undefined),
    onRestore: vi.fn().mockResolvedValue(undefined), onClose: vi.fn() }
}
const openButton = (owner = cwd, sessionPath = path) => screen.getByTitle(`${owner}\n${sessionPath}`, { normalizer: value => value })

describe('ArchivedSessionsPanel', () => {
  it('projects only archives using exact cwd + path metadata, saved-title fallback and search', () => {
    const callbacks = props()
    render(<ArchivedSessionsPanel {...callbacks} />)
    expect(screen.getByText('4 个归档会话')).toBeInTheDocument()
    expect(screen.getByText('真实主会话')).toBeInTheDocument()
    expect(screen.getByText('真实分支预览')).toBeInTheDocument()
    expect(screen.getByText('保留标题')).toBeInTheDocument()
    expect(screen.getByText('归属隔离标题')).toBeInTheDocument()
    for (const title of ['普通会话', '未归档会话', '错误归属元数据', '已保存主会话标题', '已保存分支标题']) {
      expect(screen.queryByText(title)).not.toBeInTheDocument()
    }
    expect(callbacks.onSelect).not.toHaveBeenCalled()
    expect(callbacks.onRestore).not.toHaveBeenCalled()
    const search = screen.getByRole('searchbox', { name: '搜索归档会话' })
    fireEvent.change(search, { target: { value: '  真实主会话  ' } })
    expect(openButton()).toBeInTheDocument()
    expect(screen.queryByTitle(`${branchCwd}\n${path}`, { normalizer: value => value })).not.toBeInTheDocument()
    fireEvent.change(search, { target: { value: '/PROJECT/WORKTREE' } })
    expect(openButton(branchCwd)).toBeInTheDocument()
    expect(screen.queryByText('真实主会话')).not.toBeInTheDocument()
    fireEvent.change(search, { target: { value: '/sessions/missing.jsonl' } })
    expect(screen.getByText('保留标题')).toBeInTheDocument()
    fireEvent.change(search, { target: { value: '无匹配项' } })
    expect(screen.getByText('没有匹配的归档会话')).toBeInTheDocument()
    expect(screen.queryByText('暂无归档会话')).not.toBeInTheDocument()
  })

  it('opens only on explicit selection, passes the exact owning paths and waits before closing', async () => {
    const callbacks = props(), opening = deferred<void>()
    vi.mocked(callbacks.onSelect).mockReturnValueOnce(opening.promise)
    render(<ArchivedSessionsPanel {...callbacks} />)
    fireEvent.click(openButton(branchCwd))
    fireEvent.click(openButton(branchCwd))
    fireEvent.click(screen.getByRole('button', { name: '恢复会话 真实主会话' }))
    expect(callbacks.onSelect).toHaveBeenCalledExactlyOnceWith(branchCwd, path)
    expect(callbacks.onRestore).not.toHaveBeenCalled()
    expect(callbacks.onClose).not.toHaveBeenCalled()
    expect(openButton()).toBeDisabled()
    expect(screen.getByRole('button', { name: '刷新' })).toBeDisabled()
    await act(async () => { opening.resolve(); await opening.promise })
    expect(callbacks.onClose).toHaveBeenCalledTimes(1)
    expect(openButton()).toBeEnabled()
  })

  it('keeps the panel open when session selection fails or is cancelled', async () => {
    const callbacks = props()
    vi.mocked(callbacks.onSelect).mockRejectedValueOnce(new Error('会话打开失败或已取消，请重试。'))
    render(<ArchivedSessionsPanel {...callbacks} />)
    await act(async () => { fireEvent.click(openButton()) })
    expect(callbacks.onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('会话打开失败或已取消')
    expect(openButton()).toBeEnabled()
  })

  it('keeps a failed restore visible, blocks duplicates while pending, and follows saved snapshots', async () => {
    const callbacks = props(), restoring = deferred<void>()
    vi.mocked(callbacks.onRestore).mockReturnValueOnce(restoring.promise)
    const view = render(<ArchivedSessionsPanel {...callbacks} />)
    const restore = screen.getByRole('button', { name: '恢复会话 真实主会话' })
    fireEvent.click(restore)
    fireEvent.click(restore)
    fireEvent.click(openButton(branchCwd))
    expect(callbacks.onRestore).toHaveBeenCalledExactlyOnceWith(cwd, path)
    expect(callbacks.onSelect).not.toHaveBeenCalled()
    expect(restore).toBeDisabled()
    expect(screen.getByRole('button', { name: '刷新' })).toBeDisabled()
    await act(async () => { restoring.reject(new Error('恢复保存失败')); await restoring.promise.catch(() => {}) })
    expect(screen.getByRole('alert')).toHaveTextContent('恢复保存失败')
    expect(openButton()).toBeInTheDocument()
    expect(restore).toBeEnabled()
    await act(async () => { fireEvent.click(restore) })
    expect(callbacks.onRestore).toHaveBeenCalledTimes(2)
    expect(callbacks.onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(openButton()).toBeInTheDocument()
    view.rerender(<ArchivedSessionsPanel {...callbacks} organization={{ ...callbacks.organization, revision: 2,
      sessions: callbacks.organization.sessions.map(entry => entry.cwd === cwd && entry.path === path ? { ...entry, archived: false } : entry) }} />)
    expect(screen.queryByTitle(`${cwd}\n${path}`, { normalizer: value => value })).not.toBeInTheDocument()
    expect(openButton(branchCwd)).toBeInTheDocument()
  })

  it('distinguishes initial loading/failure from an empty archive and gates saves', async () => {
    const callbacks = props(), empty: SessionOrganization = { version: 1, revision: 0, folders: [], sessions: [] }
    const view = render(<ArchivedSessionsPanel {...callbacks} organization={empty} ready={false} loading />)
    expect(screen.getByText('正在读取归档会话…')).toBeInTheDocument()
    expect(screen.getByText('归档会话待加载')).toBeInTheDocument()
    expect(screen.queryByText('0 个归档会话')).not.toBeInTheDocument()
    expect(screen.queryByText('暂无归档会话')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '刷新' })).toBeDisabled()
    view.rerender(<ArchivedSessionsPanel {...callbacks} organization={empty} ready={false} error="初读失败" />)
    expect(screen.getByRole('alert')).toHaveTextContent('初读失败')
    expect(screen.getByText('归档会话读取失败，请刷新重试。')).toBeInTheDocument()
    expect(screen.queryByText('暂无归档会话')).not.toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新' })) })
    expect(callbacks.onRefresh).toHaveBeenCalledTimes(1)
    expect(callbacks.onRestore).not.toHaveBeenCalled()
    expect(callbacks.onSelect).not.toHaveBeenCalled()
    view.rerender(<ArchivedSessionsPanel {...callbacks} saving />)
    expect(openButton()).toBeDisabled()
    expect(screen.getByRole('button', { name: '恢复会话 真实主会话' })).toBeDisabled()
    fireEvent.click(openButton())
    expect(callbacks.onSelect).not.toHaveBeenCalled()
  })
})
