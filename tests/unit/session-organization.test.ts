import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionOrganizationStore } from '../../src/main/session-organization'
import {
  applySessionOrganizationChange as apply,
  sessionPlacementKey,
  validateSessionOrganization,
  validateSessionOrganizationChange,
  type SessionOrganization
} from '../../src/shared/session-organization'

vi.mock('electron', () => ({ app: { getPath: () => '/unused' } }))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const empty = (): SessionOrganization => ({ version: 1, revision: 0, folders: [], sessions: [] })
const create = (id: string, parentId?: string, cwd = '/project') => ({ type: 'createFolder', id, cwd, name: id, ...(parentId ? { parentId } : {}) })
async function fixture(): Promise<{ root: string; path: string; store: SessionOrganizationStore }> {
  const root = await mkdtemp(join(tmpdir(), 'pion-organization-'))
  roots.push(root)
  const path = join(root, 'pion-session-organization.json')
  return { root, path, store: new SessionOrganizationStore(() => path) }
}

describe('session organization graph', () => {
  it('promotes only direct children and placements on deletion, retaining archive and titles', () => {
    let state = apply(empty(), create('parent'))
    state = apply(state, create('middle', 'parent'))
    state = apply(state, create('child', 'middle'))
    state = apply(state, create('grandchild', 'child'))
    state = apply(state, { type: 'setSession', cwd: '/project', path: 'opaque-session', folderId: 'middle', archived: true, title: 'kept' })
    const next = apply(state, { type: 'deleteFolder', id: 'middle' })
    expect(next.folders.find((item) => item.id === 'child')?.parentId).toBe('parent')
    expect(next.folders.find((item) => item.id === 'grandchild')?.parentId).toBe('child')
    expect(next.sessions).toEqual([{ cwd: '/project', path: 'opaque-session', folderId: 'parent', archived: true, title: 'kept' }])
    const rootDeleted = apply(next, { type: 'deleteFolder', id: 'parent' })
    expect(rootDeleted.sessions[0]).toEqual({ cwd: '/project', path: 'opaque-session', archived: true, title: 'kept' })
    expect(rootDeleted.folders[0]).not.toHaveProperty('parentId')
    expect(state.sessions[0].folderId).toBe('middle')
    expect(state.folders).toHaveLength(4)
  })

  it('merges partial session patches and keeps exact cwd/path identities', () => {
    let state = apply(empty(), create('folder'))
    state = apply(state, { type: 'setSession', cwd: '/project', path: '/same', folderId: 'folder', archived: true, title: 'title' })
    state = apply(state, { type: 'setSession', cwd: '/project', path: '/same', archived: false })
    expect(state.sessions[0]).toMatchObject({ folderId: 'folder', archived: false, title: 'title' })
    state = apply(state, { type: 'setSession', cwd: '/project', path: '/same', folderId: null })
    expect(state.sessions[0]).not.toHaveProperty('folderId')
    expect(state.sessions[0]).toMatchObject({ archived: false, title: 'title' })
    state = apply(state, { type: 'setSession', cwd: '/project/', path: '/same', archived: true })
    expect(state.sessions).toHaveLength(2)
    expect(sessionPlacementKey('/project', '/same')).toBe(JSON.stringify(['/project', '/same']))
    expect(sessionPlacementKey('a,b', 'c')).not.toBe(sessionPlacementKey('a', 'b,c'))
  })

  it('renames, collapses and moves folders while rejecting cycles and cross-cwd parents', () => {
    let state = apply(empty(), create('root'))
    state = apply(state, create('child', 'root'))
    state = apply(state, create('other', undefined, '/other'))
    for (const change of [create('root'), create('missing', 'unknown'), create('cross', 'other'), { type: 'moveFolder', id: 'root', parentId: 'child' }, { type: 'moveFolder', id: 'child', parentId: 'other' }]) {
      expect(() => apply(state, change)).toThrow()
    }
    expect(() => apply(state, { type: 'setSession', cwd: '/other', path: 'opaque', folderId: 'root' })).toThrow()
    for (const change of [
      { type: 'renameFolder', id: 'absent', name: 'name' },
      { type: 'moveFolder', id: 'absent' },
      { type: 'deleteFolder', id: 'absent' },
      { type: 'setFolderCollapsed', id: 'absent', collapsed: false }
    ]) expect(() => apply(state, change)).toThrow()
    state = apply(state, { type: 'renameFolder', id: 'child', name: 'renamed' })
    state = apply(state, { type: 'setFolderCollapsed', id: 'child', collapsed: true })
    state = apply(state, { type: 'moveFolder', id: 'child' })
    expect(state.folders[1]).toEqual({ id: 'child', cwd: '/project', name: 'renamed', collapsed: true })
  })

  it('rejects malformed primitive fields, unknown fields, accessors and exotic objects', () => {
    const changes = [null, [], 'setSession', Object.create({ type: 'deleteFolder', id: 'x' }),
      { type: 'deleteFolder', id: 'x', extra: true }, { type: 'deleteFolder', id: 1 },
      { type: 'createFolder', id: 'id', cwd: '/project', name: ' ' },
      { type: 'setSession', cwd: '/project', path: 'path', archived: 'false' },
      { type: 'setSession', cwd: '/project', path: 'path', archived: null },
      { type: 'setSession', cwd: '/project', path: 'path', archived: undefined },
      { type: 'setSession', cwd: '/project', path: 'path', folderId: '' },
      { type: 'setSession', cwd: '/project', path: 'path', title: {} },
      { type: 'setFolderCollapsed', id: 'x', collapsed: 0 },
      { type: 'moveFolder', id: 'id', parentId: null },
      { type: 'deleteFolder', id: 'x', [Symbol('extra')]: 1 }]
    const getter = vi.fn(() => 'deleteFolder')
    changes.push(Object.defineProperty({ id: 'x' }, 'type', { enumerable: true, get: getter }))
    for (const change of changes) expect(() => validateSessionOrganizationChange(change)).toThrow()
    expect(getter).not.toHaveBeenCalled()
  })

  it('rejects corrupt persisted graphs and revisions without normalizing their identity', () => {
    const folder = { id: 'a', cwd: '/project', name: 'a' }
    const session = { cwd: '/project', path: 'opaque' }
    for (const state of [
      { ...empty(), version: 2 }, { ...empty(), revision: -1 }, { ...empty(), revision: 0.5 },
      { ...empty(), revision: Number.POSITIVE_INFINITY }, { ...empty(), unknown: true },
      { ...empty(), folders: [folder, folder] }, { ...empty(), sessions: [session, session] },
      { ...empty(), folders: [{ ...folder, parentId: 'a' }] },
      { ...empty(), folders: [{ ...folder, parentId: 'missing' }] },
      { ...empty(), sessions: [{ ...session, folderId: 'missing' }] },
      { ...empty(), sessions: [{ ...session, archived: 'true' }] },
      { ...empty(), folders: Array(1) }
    ]) expect(() => validateSessionOrganization(state)).toThrow()
    expect(() => apply({ ...empty(), revision: Number.MAX_SAFE_INTEGER }, create('x'))).toThrow()
  })
})

describe('session organization persistence', () => {
  it('drains admitted operations during shutdown and rejects new filesystem work', async () => {
    const { path, store } = await fixture()
    const admitted = store.update(create('root'))
    const closing = store.shutdown()
    await expect(store.get()).rejects.toThrow('正在退出')
    await expect(store.update(create('late'))).rejects.toThrow('正在退出')
    await admitted
    await closing
    expect((await new SessionOrganizationStore(() => path).get()).folders.map(entry => entry.id)).toEqual(['root'])
  })

  it('serializes concurrent read-modify-write patches and restores all revisions', async () => {
    const { path, store } = await fixture()
    expect(await store.get()).toEqual(empty())
    const snapshots = await Promise.all([
      store.update(create('root')),
      store.update(create('child', 'root')),
      store.update({ type: 'setSession', cwd: '/project', path: '/external/opaque', folderId: 'child', archived: true })
    ])
    expect(snapshots.map((state) => state.revision)).toEqual([1, 2, 3])
    const restored = await new SessionOrganizationStore(() => path).get()
    expect(restored).toEqual(snapshots[2])
    expect(restored.folders).toHaveLength(2)
    snapshots[2].folders[0].name = 'caller mutation'
    expect((await store.get()).folders[0].name).toBe('root')
    expect(JSON.parse(await readFile(path, 'utf8')).sessions[0].path).toBe('/external/opaque')
  })

  it('preserves corrupted bytes and propagates non-ENOENT failures on get and update', async () => {
    const { root, path, store } = await fixture()
    for (const bytes of ['{broken', JSON.stringify({ ...empty(), version: 2 })]) {
      await writeFile(path, bytes)
      await expect(store.get()).rejects.toThrow()
      await expect(store.update(create('root'))).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toBe(bytes)
      expect(await readdir(root)).toEqual(['pion-session-organization.json'])
    }
    const directoryTarget = new SessionOrganizationStore(() => root)
    await expect(directoryTarget.get()).rejects.toThrow()
    await expect(directoryTarget.update(create('root'))).rejects.toThrow()
  })

  it('rejects stale owners before publication, cleans staging and retains earlier data', async () => {
    const { root, path, store } = await fixture()
    const saved = await store.update(create('root'))
    let checks = 0
    // Start, after-read, before-open, and finally immediately before rename.
    await expect(store.update(create('stale'), () => { if (++checks === 4) throw new Error('stale owner') })).rejects.toThrow('stale owner')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(saved)
    expect(await readdir(root)).toEqual(['pion-session-organization.json'])
    await expect(store.update(create('next'))).resolves.toMatchObject({ revision: 2 })
  })

  it('captures a queued patch and leaves session file bytes untouched', async () => {
    const { root, store } = await fixture()
    const sessionPath = join(root, 'session.jsonl')
    await writeFile(sessionPath, 'original session bytes')
    const patch = { type: 'setSession', cwd: '/project', path: sessionPath, archived: true }
    const update = store.update(patch)
    patch.archived = false
    expect((await update).sessions[0].archived).toBe(true)
    expect(await readFile(sessionPath, 'utf8')).toBe('original session bytes')
  })
})
