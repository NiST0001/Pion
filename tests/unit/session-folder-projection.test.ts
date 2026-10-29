import { describe, expect, it } from 'vitest'
import { orderedSessionOrganizationItems, validateSessionOrganization, type SessionOrganization } from '../../src/shared/session-organization'
import type { SessionMeta } from '../../src/shared/types'
import { indexSessionFolderOrganization, projectSessionFolderTree, sessionFolderMoveOptions } from '../../src/renderer/src/features/session/session-folder-projection'

const cwd = '/project'
const session = (path: string, projectCwd = cwd): SessionMeta => ({ id: path, path, projectCwd,
  timestamp: '2026-01-01', mtime: 1, preview: path, messageCount: 2 })

describe('session folder snapshot projection', () => {
  it('indexes all groups with the existing rank/tie/natural order and exact cwd membership', () => {
    const organization: SessionOrganization = { version: 1, revision: 7, folders: [
      { id: 'a', cwd, name: 'A', order: 1 }, { id: 'child', cwd, name: 'Child', parentId: 'a', order: 0 },
      { id: 'z', cwd, name: 'Z', order: 0 }, { id: 'foreign', cwd: `${cwd}/`, name: 'Foreign' }
    ], sessions: [
      { cwd, path: 'ranked', order: 1 }, { cwd, path: 'nested', folderId: 'a', order: 0 },
      { cwd, path: 'archived', archived: true, order: 0 }, { cwd, path: 'deleted', order: 0 },
      { cwd: `${cwd}/`, path: 'implicit', archived: true }
    ] }
    const sessions = [session('implicit'), session('ranked'), session('nested'), session('archived'), session('foreign-session', `${cwd}/`)]
    const before = structuredClone(organization)
    const index = indexSessionFolderOrganization(organization, cwd)
    const projection = projectSessionFolderTree(index, sessions)
    const paths = sessions.filter((entry) => entry.projectCwd === cwd).map((entry) => entry.path)
    for (const parentId of [undefined, 'a', 'child', 'z']) {
      expect(projection.groups.get(parentId)!.items).toEqual(orderedSessionOrganizationItems(organization, cwd, parentId, paths))
    }
    const root = projection.groups.get(undefined)!
    expect(root.items).toEqual([{ kind: 'folder', id: 'z' }, { kind: 'session', path: 'ranked' },
      { kind: 'folder', id: 'a' }, { kind: 'session', path: 'implicit' }])
    expect(root.automaticItems).toEqual([{ kind: 'session', path: 'implicit' }, { kind: 'session', path: 'ranked' },
      { kind: 'folder', id: 'z' }, { kind: 'folder', id: 'a' }])
    expect(root.sessions).toEqual(sessions.slice(0, 2))
    expect(root.byPath.get('implicit')).toBe(sessions[0])
    expect(projection.sessionsByPath.size).toBe(3)
    expect(projection.folders.has('foreign')).toBe(false)
    expect(projection.options.map((option) => option.label)).toEqual(['根目录', 'A', 'A / Child', 'Z'])
    const refreshed = projectSessionFolderTree(index, sessions.map((entry) => ({ ...entry, preview: 'updated', totalTokens: 100 })))
    expect(refreshed.options).toBe(projection.options)
    expect(refreshed.parents).toBe(projection.parents)
    expect(refreshed.placements).toBe(projection.placements)
    expect([...refreshed.groups].map(([id, group]) => [id, group.items])).toEqual([...projection.groups].map(([id, group]) => [id, group.items]))
    expect(organization).toEqual(before)
  })

  it('retains natural root fallbacks and original ancestry move safety for corrupt ancestors', () => {
    const organization: SessionOrganization = { version: 1, revision: 1, folders: [
      { id: 'valid', cwd, name: 'Valid', order: 7 },
      { id: 'missing', cwd, name: 'Missing', parentId: 'gone', order: 0 },
      { id: 'descendant', cwd, name: 'Descendant', parentId: 'missing', order: 0 },
      { id: 'x', cwd, name: 'X', parentId: 'y' }, { id: 'y', cwd, name: 'Y', parentId: 'x' },
      { id: 'z', cwd, name: 'Z', parentId: 'x' },
      { id: 'cross', cwd, name: 'Cross', parentId: 'foreign' }, { id: 'foreign', cwd: '/other', name: 'Foreign' }
    ], sessions: [
      { cwd, path: 'root', order: 9 }, { cwd, path: 'orphan', folderId: 'gone', order: 0 },
      { cwd, path: 'nested', folderId: 'missing', order: 0 }
    ] }
    const projection = projectSessionFolderTree(indexSessionFolderOrganization(organization, cwd), ['root', 'orphan', 'nested'].map((path) => session(path)))
    expect(projection.groups.get(undefined)!.items).toEqual([
      { kind: 'folder', id: 'valid' }, { kind: 'session', path: 'root' }, { kind: 'session', path: 'orphan' },
      ...['missing', 'descendant', 'x', 'y', 'z', 'cross'].map((id) => ({ kind: 'folder', id }))
    ])
    expect(projection.groups.get('missing')!.items).toEqual([{ kind: 'session', path: 'nested' }])
    expect([...projection.parents.values()]).toEqual(Array(7).fill(undefined))
    expect(sessionFolderMoveOptions(projection, 'valid').map((option) => option.value)).toEqual(['', 'missing', 'descendant', 'cross'])
    expect(sessionFolderMoveOptions(projection, 'missing').map((option) => option.value)).toEqual(['', 'valid', 'cross'])
    // Display fallback leaves the strict persisted schema intact.
    expect(() => validateSessionOrganization(organization)).toThrow()
  })

  it('projects and filters a legal deep chain with explicit stacks, without mounting deep DOM', () => {
    const depth = 12_000
    const folders = Array.from({ length: depth }, (_, index) => ({ id: `f${index}`, cwd, name: 'x',
      ...(index ? { parentId: `f${index - 1}` } : {}) })).reverse()
    const organization = validateSessionOrganization({ version: 1, revision: 0, folders, sessions: [{ cwd, path: 'deep', folderId: `f${depth - 1}` }] })
    const projection = projectSessionFolderTree(indexSessionFolderOrganization(organization, cwd), [session('deep')])
    expect(projection.options).toHaveLength(depth + 1)
    expect(projection.options[1]).toEqual({ value: 'f0', label: 'x' })
    expect(projection.options.at(-1)?.value).toBe(`f${depth - 1}`)
    expect(projection.options.at(-1)?.label.split(' / ')).toHaveLength(depth)
    expect(projection.parents.get(`f${depth - 1}`)).toBe(`f${depth - 2}`)
    expect(projection.groups.get(`f${depth - 1}`)!.items).toEqual([{ kind: 'session', path: 'deep' }])
    expect(sessionFolderMoveOptions(projection, 'f0')).toEqual([{ value: '', label: '根目录' }])
    const leafTargets = sessionFolderMoveOptions(projection, `f${depth - 1}`)
    expect(leafTargets).toHaveLength(depth)
    expect(leafTargets.at(-1)?.value).toBe(`f${depth - 2}`)
  })
})
