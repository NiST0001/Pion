// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PionApi } from '../../src/shared/pion-api'
import type { SessionOrganization, SessionOrganizationChange } from '../../src/shared/session-organization'
import { useSessionOrganization } from '../../src/renderer/src/hooks/useSessionOrganization'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
type OrganizationApi = Pick<PionApi, 'getSessionOrganization' | 'updateSessionOrganization'>
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
function snapshot(revision: number, name = '保存的文件夹'): SessionOrganization {
  return { version: 1, revision, folders: [{ id: 'folder', cwd: '/project', name }], sessions: [] }
}
const change: SessionOrganizationChange = { type: 'renameFolder', id: 'folder', name: '新名称' }
function api() {
  return { getSessionOrganization: vi.fn<OrganizationApi['getSessionOrganization']>().mockResolvedValue(snapshot(1)),
    updateSessionOrganization: vi.fn<OrganizationApi['updateSessionOrganization']>().mockResolvedValue(snapshot(2, '新名称')) } satisfies OrganizationApi
}
const flush = async () => { await act(async () => { await Promise.resolve() }) }

describe('useSessionOrganization', () => {
  it('waits for the initial read and holds a save slot until the actual response', async () => {
    const service = api(), read = deferred<SessionOrganization>(), save = deferred<SessionOrganization>()
    service.getSessionOrganization.mockReturnValue(read.promise)
    service.updateSessionOrganization.mockReturnValue(save.promise)
    const { result } = renderHook(() => useSessionOrganization(service))
    await flush()
    expect(result.current).toMatchObject({ ready: false, loading: true, saving: false })
    let refresh!: Promise<void>
    act(() => { refresh = result.current.refresh() })
    await expect(result.current.update(change)).rejects.toThrow('尚未读取完成')
    expect(service.getSessionOrganization).toHaveBeenCalledTimes(1)
    expect(service.updateSessionOrganization).not.toHaveBeenCalled()
    await act(async () => { read.resolve(snapshot(1)); await refresh })
    expect(result.current).toMatchObject({ ready: true, loading: false, organization: snapshot(1) })
    let saving!: Promise<void>
    act(() => { saving = result.current.update(change) })
    expect(result.current.saving).toBe(true)
    expect(result.current.organization).toEqual(snapshot(1))
    await expect(result.current.update(change)).rejects.toThrow('正在保存')
    await flush()
    expect(result.current.saving).toBe(true)
    expect(service.updateSessionOrganization).toHaveBeenCalledExactlyOnceWith(change)
    await act(async () => { save.resolve(snapshot(2, '新名称')); await saving })
    expect(result.current).toMatchObject({ saving: false, error: '', organization: snapshot(2, '新名称') })
  })

  it('keeps a saved revision when an older refresh completes later', async () => {
    const service = api(), read = deferred<SessionOrganization>(), save = deferred<SessionOrganization>()
    const { result } = renderHook(() => useSessionOrganization(service))
    await flush()
    service.getSessionOrganization.mockReturnValueOnce(read.promise)
    service.updateSessionOrganization.mockReturnValueOnce(save.promise)
    let refreshing!: Promise<void>, saving!: Promise<void>
    act(() => { refreshing = result.current.refresh(); saving = result.current.update(change) })
    await flush()
    await act(async () => { save.resolve(snapshot(3, '最新保存')); await saving })
    expect(result.current).toMatchObject({ loading: true, saving: false, organization: snapshot(3, '最新保存') })
    await act(async () => { read.resolve(snapshot(1, '旧读取')); await refreshing })
    expect(result.current).toMatchObject({ loading: false, error: '', organization: snapshot(3, '最新保存') })
  })

  it('rejects old read owners through API A → B → A even if their revision is higher', async () => {
    const a = api(), b = api()
    const oldA = deferred<SessionOrganization>(), oldB = deferred<SessionOrganization>(), currentA = deferred<SessionOrganization>()
    a.getSessionOrganization.mockReturnValueOnce(oldA.promise).mockReturnValueOnce(currentA.promise)
    b.getSessionOrganization.mockReturnValueOnce(oldB.promise)
    const view = renderHook(({ service }: { service: OrganizationApi }) => useSessionOrganization(service), { initialProps: { service: a } })
    await flush()
    view.rerender({ service: b }); await flush()
    view.rerender({ service: a }); await flush()
    expect(view.result.current).toMatchObject({ ready: false, loading: true })
    expect(a.getSessionOrganization).toHaveBeenCalledTimes(2)
    await act(async () => { currentA.resolve(snapshot(4, '当前 A')) })
    await act(async () => { oldA.resolve(snapshot(99, '旧 A')); oldB.reject(new Error('旧 B 读取失败')) })
    expect(view.result.current).toMatchObject({ ready: true, loading: false, error: '', organization: snapshot(4, '当前 A') })
    expect(a.updateSessionOrganization).not.toHaveBeenCalled()
    expect(b.updateSessionOrganization).not.toHaveBeenCalled()
  })

  it('shows read/save failures, preserves the last snapshot and never writes defaults', async () => {
    const service = api()
    service.getSessionOrganization.mockRejectedValueOnce(new Error('初读失败'))
    const { result } = renderHook(() => useSessionOrganization(service))
    await flush()
    expect(result.current).toMatchObject({ ready: false, loading: false, error: '初读失败' })
    await expect(result.current.update(change)).rejects.toThrow('尚未读取完成')
    expect(service.updateSessionOrganization).not.toHaveBeenCalled()
    await act(async () => { await result.current.refresh() })
    expect(result.current.organization).toEqual(snapshot(1))
    service.getSessionOrganization.mockRejectedValueOnce(new Error('刷新失败'))
    await act(async () => { await result.current.refresh() })
    expect(result.current).toMatchObject({ ready: true, loading: false, error: '刷新失败', organization: snapshot(1) })
    expect(service.updateSessionOrganization).not.toHaveBeenCalled()
    service.updateSessionOrganization.mockRejectedValueOnce(new Error('保存失败'))
    await act(async () => { await expect(result.current.update(change)).rejects.toThrow('保存失败') })
    expect(result.current).toMatchObject({ ready: true, saving: false, error: '保存失败', organization: snapshot(1) })
    expect(service.updateSessionOrganization).toHaveBeenCalledExactlyOnceWith(change)
  })

  it('holds an old save across owner changes until it returns and discards its snapshot', async () => {
    const a = api(), b = api(), oldSave = deferred<SessionOrganization>()
    a.updateSessionOrganization.mockReturnValueOnce(oldSave.promise)
    const view = renderHook(({ service }: { service: OrganizationApi }) => useSessionOrganization(service), { initialProps: { service: a } })
    await flush()
    let oldResult!: Promise<unknown>
    act(() => { oldResult = view.result.current.update(change).catch(error => error) })
    view.rerender({ service: b }); await flush()
    expect(view.result.current.saving).toBe(true)
    await expect(view.result.current.update(change)).rejects.toThrow('正在保存')
    expect(b.updateSessionOrganization).not.toHaveBeenCalled()
    a.getSessionOrganization.mockResolvedValueOnce(snapshot(4, '新 A'))
    view.rerender({ service: a }); await flush()
    expect(view.result.current.saving).toBe(true)
    await expect(view.result.current.update(change)).rejects.toThrow('正在保存')
    expect(a.updateSessionOrganization).toHaveBeenCalledTimes(1)
    await act(async () => { oldSave.resolve(snapshot(100, '旧保存')); expect(await oldResult).toEqual(new Error('会话整理所属页面已变化。')) })
    expect(view.result.current).toMatchObject({ saving: false, error: '', organization: snapshot(4, '新 A') })
    a.updateSessionOrganization.mockResolvedValueOnce(snapshot(5, '新名称'))
    await act(async () => { await view.result.current.update(change) })
    expect(view.result.current.organization).toEqual(snapshot(5, '新名称'))
    expect(a.updateSessionOrganization).toHaveBeenCalledTimes(2)
  })
})
