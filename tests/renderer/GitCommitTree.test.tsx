// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitCommitTree } from '../../src/renderer/src/features/git-commit-tree/GitCommitTree'
import { layoutCommitGraph } from '../../src/renderer/src/features/git-commit-tree/commitGraph'
import type { GitCommitTreeCommit, GitCommitTreePage } from '../../src/shared/git-commit-tree'
import type { PionApi } from '../../src/shared/pion-api'
import type { GitSnapshotUpdate } from '../../src/shared/types'

const hashA = 'a'.repeat(40)
const hashB = 'b'.repeat(40)
const hashC = 'c'.repeat(40)
const hashD = 'd'.repeat(40)
const hashE = 'e'.repeat(40)
const commits: GitCommitTreeCommit[] = [
  { hash: hashA, parents: [hashB, hashC], subject: '合并功能分支', author: '林', authoredAt: '2026-06-01T09:00:00Z' },
  { hash: hashB, parents: [hashD], subject: '更新主分支', author: '周', authoredAt: '2026-06-01T08:00:00Z' },
  { hash: hashC, parents: [hashD], subject: '完成功能', author: '陈', authoredAt: '2026-06-01T07:00:00Z' },
  { hash: hashD, parents: [], subject: '初始提交', author: '林', authoredAt: '2026-06-01T06:00:00Z' }
]
function page(overrides: Partial<GitCommitTreePage> = {}): GitCommitTreePage {
  return {
    root: '/repo/a', revision: 'revision-a', head: hashA, currentBranch: 'main', commits: commits.slice(0, 2),
    refs: [
      { kind: 'branch', name: 'main', fullName: 'refs/heads/main', hash: hashA },
      { kind: 'branch', name: 'feature', fullName: 'refs/heads/feature', hash: hashC },
      { kind: 'remote', name: 'origin/main', fullName: 'refs/remotes/origin/main', hash: hashA },
      { kind: 'tag', name: 'v1', fullName: 'refs/tags/v1', hash: hashB }
    ],
    nextCursor: { revision: 'revision-a', offset: 200 }, ...overrides
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((finish, fail) => { resolve = finish; reject = fail })
  return { promise, resolve, reject }
}
function snapshotUpdate(root: string): GitSnapshotUpdate {
  return { snapshot: {
    snapshotId: `snapshot:${root}`, root, head: hashA, branch: 'main', ahead: 0, behind: 0,
    operation: 'none', files: [], stagedCount: 0, unstagedCount: 0, conflictCount: 0, capturedAt: 0
  } }
}
function fakeApi(value = page()) {
  const listeners = new Set<(update: GitSnapshotUpdate) => void>()
  const subscriptions: ((update: GitSnapshotUpdate) => void)[] = []
  const api = {
    getGitCommitTree: vi.fn<PionApi['getGitCommitTree']>(async () => value),
    onGitSnapshot: vi.fn<PionApi['onGitSnapshot']>((listener) => {
      listeners.add(listener)
      subscriptions.push(listener)
      return () => { listeners.delete(listener) }
    })
  } satisfies Pick<PionApi, 'getGitCommitTree' | 'onGitSnapshot'>
  vi.stubGlobal('pion', api)
  return { api, subscriptions, listeners, push: (root: string) => act(() => { for (const listener of listeners) listener(snapshotUpdate(root)) }) }
}
async function flush(): Promise<void> { await act(async () => undefined) }
const firstRow = () => screen.getByRole('button', { name: /^查看提交 aaaaaaaa/ })
const older = () => screen.getByRole('button', { name: '加载更早的 200 条' })
const refresh = () => fireEvent.click(screen.getByRole('button', { name: '刷新' }))

// Memory-only IPC and pure graph fixtures: no Git command, Agent or Electron.
describe('GitCommitTree', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('keeps the topological prefix and cross-page lanes stable, including a merge into an existing lane', () => {
    const firstPage = layoutCommitGraph(commits.slice(0, 2))
    const all = layoutCommitGraph(commits)
    expect(all.rows.slice(0, 2)).toEqual(firstPage.rows)
    expect(all.rows.map((row) => row.lane)).toEqual([0, 0, 1, 0])
    expect(all.rows[0].paths).toHaveLength(2)
    expect(all.rows[1].paths).toContainEqual({ color: 1, d: 'M 30 0 V 48' })
    expect(all.rows[2].paths).toContainEqual({ color: 1, d: 'M 30 0 V 24' })
    expect(all.rows[2].paths).toContainEqual({ color: 0, d: 'M 30 24 C 30 36, 14 36, 14 48' })
    expect(all.rows[3].paths).toEqual([{ color: 0, d: 'M 14 0 V 24' }])
  })

  it('loads only when visible with a cwd, shows refs/details, and preserves rows/selection through paging, hiding and failed refresh', async () => {
    const { api, listeners } = fakeApi()
    const { rerender, container } = render(<GitCommitTree visible />)
    expect(api.getGitCommitTree).not.toHaveBeenCalled()
    rerender(<GitCommitTree cwd="/repo/a" visible={false} />)
    expect(api.onGitSnapshot).not.toHaveBeenCalled()
    rerender(<GitCommitTree cwd="/repo/a" visible />)
    await flush()
    expect(api.getGitCommitTree).toHaveBeenCalledWith('/repo/a', undefined)
    const row = firstRow()
    expect(within(row).getByText('HEAD')).toBeInTheDocument()
    expect(within(row).getByText('本地 · main')).toBeInTheDocument()
    expect(within(row).getByText('远程 · origin/main')).toBeInTheDocument()
    const refs = screen.getByRole('complementary', { name: '分支与标签' })
    expect(within(refs).getByText('当前 HEAD')).toBeInTheDocument()
    expect(within(refs).getByRole('button', { name: /feature/ })).toBeDisabled()
    expect(screen.getByText('标签 · v1')).toBeInTheDocument()
    row.focus()
    fireEvent.keyDown(row, { key: 'ArrowDown' })
    expect(screen.getByRole('button', { name: /^查看提交 bbbbbbbb/ })).toHaveFocus()
    fireEvent.click(row)
    const detail = screen.getByRole('region', { name: '提交详情' })
    expect(within(detail).getByText(hashA)).toBeInTheDocument()
    expect(within(detail).getByText(hashB)).toBeInTheDocument()
    expect(within(detail).getByText(hashC)).toBeInTheDocument()
    expect(within(detail).getByText('林')).toBeInTheDocument()
    expect(within(detail).getByText(/2026/)).toBeInTheDocument()
    const history = container.querySelector('.git-commit-tree-history') as HTMLElement
    history.scrollTop = 51
    api.getGitCommitTree.mockResolvedValueOnce(page({ commits: commits.slice(2), nextCursor: null }))
    fireEvent.click(older())
    await flush()
    expect(api.getGitCommitTree).toHaveBeenLastCalledWith('/repo/a', { revision: 'revision-a', offset: 200 })
    expect(firstRow()).toBe(row)
    expect(row).toHaveAttribute('aria-pressed', 'true')
    expect(history.scrollTop).toBe(51)
    expect(screen.getByText('已显示全部本地可达提交。')).toBeInTheDocument()
    expect(within(refs).getByRole('button', { name: /feature/ })).toBeEnabled()
    rerender(<GitCommitTree cwd="/repo/a" visible={false} />)
    expect(container.querySelector(`[data-commit-hash="${hashA}"]`)).toBe(row)
    expect(listeners.size).toBe(0)
    rerender(<GitCommitTree cwd="/repo/a" visible />)
    await flush()
    expect(api.getGitCommitTree).toHaveBeenCalledTimes(2)
    expect(firstRow()).toBe(row)
    expect(row).toHaveAttribute('aria-pressed', 'true')
    api.getGitCommitTree.mockRejectedValueOnce(new Error('private failure detail'))
    refresh()
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('读取提交记录失败')
    expect(firstRow()).toBe(row)
    expect(within(detail).getByText(hashA)).toBeInTheDocument()
    expect(screen.queryByText('此仓库暂无提交。')).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('private failure detail')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await flush()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(firstRow()).toBe(row)
  })

  it('retries failed pagination and marks matching snapshot roots stale without reloading or accepting an in-flight old page', async () => {
    const { api, push } = fakeApi()
    render(<GitCommitTree cwd="/repo/a/subdir" visible />)
    await flush()
    const row = firstRow()
    api.getGitCommitTree.mockRejectedValueOnce(new Error('page failed'))
    fireEvent.click(older())
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('加载更早提交失败')
    expect(firstRow()).toBe(row)
    expect(older()).toBeEnabled()
    expect(screen.queryByText(/当前视图已过期/)).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('page failed')
    const pending = deferred<GitCommitTreePage>()
    api.getGitCommitTree.mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(api.getGitCommitTree).toHaveBeenLastCalledWith('/repo/a/subdir', { revision: 'revision-a', offset: 200 })
    push('/repo/other')
    expect(screen.queryByText(/当前视图已过期/)).not.toBeInTheDocument()
    push('/repo/a')
    expect(api.getGitCommitTree).toHaveBeenCalledTimes(3)
    expect(screen.getByText(/当前视图已过期/)).toBeInTheDocument()
    expect(older()).toBeDisabled()
    await act(async () => { pending.resolve(page({ commits: commits.slice(2), nextCursor: null })) })
    expect(screen.queryByRole('button', { name: /^查看提交 cccccccc/ })).not.toBeInTheDocument()
    expect(firstRow()).toBe(row)
    expect(screen.getByText(/仍有更早历史/)).toBeInTheDocument()
    api.getGitCommitTree.mockResolvedValueOnce(page({ revision: 'revision-b', commits, nextCursor: null }))
    refresh()
    await flush()
    expect(screen.queryByText(/当前视图已过期/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^查看提交 cccccccc/ })).toBeInTheDocument()
  })

  it('requires a fresh page after backend cursor invalidation while retaining data and hiding Git stderr', async () => {
    const { api } = fakeApi()
    const { container } = render(<GitCommitTree cwd="/repo/a" visible />)
    await flush()
    const row = firstRow()
    fireEvent.click(row)
    const history = container.querySelector('.git-commit-tree-history') as HTMLElement
    history.scrollTop = 51
    api.getGitCommitTree.mockRejectedValueOnce(new Error('private Git stderr · 请刷新 · private repository path'))
    fireEvent.click(older())
    await flush()
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('提交历史已变化，请刷新后继续加载。')
    expect(screen.getByText(/当前视图已过期/)).toBeInTheDocument()
    expect(older()).toBeDisabled()
    expect(firstRow()).toBe(row)
    expect(row).toHaveAttribute('aria-pressed', 'true')
    expect(history.scrollTop).toBe(51)
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('private Git stderr')
    expect(document.body).not.toHaveTextContent('private repository path')
    await flush()
    expect(api.getGitCommitTree).toHaveBeenCalledTimes(2)
    api.getGitCommitTree.mockResolvedValueOnce(page({ revision: 'revision-b', nextCursor: null }))
    fireEvent.click(within(alert).getByRole('button', { name: '刷新' }))
    await flush()
    expect(api.getGitCommitTree).toHaveBeenLastCalledWith('/repo/a', undefined)
    expect(api.getGitCommitTree).toHaveBeenCalledTimes(3)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(/当前视图已过期/)).not.toBeInTheDocument()
    expect(firstRow()).toBe(row)
    expect(row).toHaveAttribute('aria-pressed', 'true')
  })

  it('holds actual reads until settlement across close/reopen and A → B → A, without publishing retired results', async () => {
    const { api, subscriptions } = fakeApi()
    const oldA = deferred<GitCommitTreePage>()
    const secondA = deferred<GitCommitTreePage>()
    const pendingB = deferred<GitCommitTreePage>()
    api.getGitCommitTree.mockReturnValueOnce(oldA.promise).mockReturnValueOnce(secondA.promise).mockReturnValueOnce(pendingB.promise)
    const { rerender } = render(<GitCommitTree cwd="/repo/a" visible />)
    rerender(<GitCommitTree cwd="/repo/a" visible={false} />)
    rerender(<GitCommitTree cwd="/repo/a" visible />)
    expect(api.getGitCommitTree).toHaveBeenCalledTimes(1)
    expect(screen.getByText('等待上一次读取结束…')).toBeInTheDocument()
    await act(async () => { oldA.resolve(page({ commits: [{ ...commits[0], subject: '关闭前旧结果' }] })) })
    expect(api.getGitCommitTree).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('关闭前旧结果')).not.toBeInTheDocument()
    rerender(<GitCommitTree cwd="/repo/b" visible />)
    expect(api.getGitCommitTree).toHaveBeenCalledTimes(3)
    rerender(<GitCommitTree cwd="/repo/a" visible />)
    expect(api.getGitCommitTree).toHaveBeenCalledTimes(3)
    act(() => subscriptions[0](snapshotUpdate('/repo/a')))
    expect(screen.queryByText(/当前视图已过期/)).not.toBeInTheDocument()
    await act(async () => { secondA.resolve(page({ commits: [{ ...commits[0], subject: '切换前旧结果' }] })) })
    expect(api.getGitCommitTree).toHaveBeenCalledTimes(4)
    await flush()
    expect(firstRow()).toBeInTheDocument()
    await act(async () => { pendingB.resolve(page({ root: '/repo/b', commits: [{ ...commits[0], subject: '其他项目结果' }] })) })
    expect(document.body).not.toHaveTextContent('切换前旧结果')
    expect(document.body).not.toHaveTextContent('其他项目结果')
    expect(screen.queryByText(/当前视图已过期/)).not.toBeInTheDocument()
  })

  it('retires old API results and clears selection/data on API or project changes, while distinguishing empty history from errors', async () => {
    const old = fakeApi()
    const { rerender } = render(<GitCommitTree cwd="/repo/a" visible />)
    await flush()
    fireEvent.click(firstRow())
    const pending = deferred<GitCommitTreePage>()
    old.api.getGitCommitTree.mockReturnValueOnce(pending.promise)
    refresh()
    const replacement = fakeApi(page({ head: hashE, currentBranch: 'new-main', commits: [{ ...commits[3], hash: hashE, subject: '新接口结果' }], refs: [], nextCursor: null }))
    rerender(<GitCommitTree cwd="/repo/a" visible />)
    await flush()
    expect(replacement.api.getGitCommitTree).toHaveBeenCalledTimes(1)
    expect(screen.getByText('新接口结果')).toBeInTheDocument()
    expect(screen.getByText(/选择一条提交查看完整信息/)).toBeInTheDocument()
    await act(async () => { pending.resolve(page({ commits: [{ ...commits[0], subject: '旧接口迟到结果' }] })) })
    expect(screen.queryByText('旧接口迟到结果')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^查看提交 aaaaaaaa/ })).not.toBeInTheDocument()
    replacement.api.getGitCommitTree.mockRejectedValueOnce(new Error('not a repository'))
    rerender(<GitCommitTree cwd="/repo/b" visible />)
    await flush()
    expect(screen.queryByText('新接口结果')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('读取提交记录失败')
    expect(screen.queryByText('此仓库暂无提交。')).not.toBeInTheDocument()
    replacement.api.getGitCommitTree.mockResolvedValueOnce(page({ root: '/repo/b', head: null, currentBranch: null, commits: [], refs: [], nextCursor: null }))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await flush()
    expect(screen.getByText('此仓库暂无提交。')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
