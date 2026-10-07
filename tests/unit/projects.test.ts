import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { runInNewContext } from 'node:vm'

const mocks = vi.hoisted(() => ({
  userData: '',
  git: vi.fn<(cwd: string, args: string[]) => Promise<string>>()
}))
vi.mock('electron', () => ({ app: { getPath: () => mocks.userData } }))
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  // execFile's real promisify contract returns an object, not just stdout.
  const execFile = Object.assign(vi.fn(), {
    [promisify.custom]: async (_file: string, args: string[]) => ({
      stdout: await mocks.git(args[1], args.slice(2)), stderr: ''
    })
  })
  return { execFile }
})
import { ProjectStore } from '../../src/main/projects'
import { canonicalProjectCwd } from '../../src/main/git'
import type { ProjectMeta } from '../../src/shared/types'

let temporary: string
let root: string
let branch: string
let ordinary: string
let registered: Set<string>
const meta = (cwd: string, name = basename(cwd), addedAt = 1, lastUsedAt = 2): ProjectMeta => ({ cwd, name, addedAt, lastUsedAt })
const disk = () => readFileSync(join(mocks.userData, 'projects.json'), 'utf8')
const seed = (projects: ProjectMeta[]) => writeFileSync(join(mocks.userData, 'projects.json'), JSON.stringify({ projects }))

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), 'pion-projects-'))
  mocks.userData = join(temporary, 'user-data')
  root = join(temporary, 'main-repository')
  // External worktree, unrelated to Pion's directory naming convention.
  branch = join(temporary, 'elsewhere', 'feature')
  ordinary = join(temporary, '.pion-worktrees', 'ordinary')
  for (const path of [mocks.userData, root, branch, ordinary]) mkdirSync(path, { recursive: true })
  registered = new Set([root, branch])
  mocks.git.mockReset()
  mocks.git.mockImplementation(async (cwd, args) => {
    if (!registered.has(cwd)) throw new Error('not a repository')
    if (args[0] === 'rev-parse') return cwd
    if (args[0] === 'worktree') return `worktree ${root}\nHEAD aabbcc\nbranch refs/heads/main\n\nworktree ${branch}\nHEAD ddeeff\nbranch refs/heads/feature\n\n`
    throw new Error('unexpected Git command')
  })
})
afterEach(() => rmSync(temporary, { recursive: true, force: true }))

describe('canonical project registration', () => {
  it('registers main once while preserving worktree cwd as an execution concern', async () => {
    const store = new ProjectStore()
    await store.touchCanonical(branch)
    await store.touchCanonical(root)
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]).toMatchObject({ cwd: root, name: basename(root) })
    expect(await canonicalProjectCwd(branch)).toBe(root)
    expect(await store.listGrouped()).toEqual(store.list())
  })

  it('projects historical duplicates without rewriting metadata and keeps main name/order', async () => {
    seed([meta(branch, 'feature', 5, 40), meta(ordinary), meta(root, 'My custom project', 10, 20)])
    const before = disk()
    const store = new ProjectStore()
    expect(await store.listGrouped()).toEqual([
      meta(ordinary), meta(root, 'My custom project', 5, 40)
    ])
    expect(disk()).toBe(before)
    expect(store.list()).toHaveLength(3)
  })

  it('touching an old worktree-only entry retains its position and leaves its original record intact', async () => {
    const alias = meta(branch, 'feature', 5, 40)
    seed([alias, meta(ordinary)])
    const store = new ProjectStore()
    await store.touchCanonical(branch)
    expect(store.list()).toContainEqual(alias)
    expect(await store.listGrouped()).toEqual([
      expect.objectContaining({ cwd: root, name: basename(root), addedAt: 5 }), meta(ordinary)
    ])
  })

  it('uses main basename when the only historical record is a worktree', async () => {
    seed([meta(branch, 'feature')])
    const before = disk()
    expect(await new ProjectStore().listGrouped()).toEqual([meta(root)])
    expect(disk()).toBe(before)
  })

  it('removes hidden registered aliases only on explicit removal, without removing files', async () => {
    seed([meta(branch), meta(root), meta(ordinary)])
    const store = new ProjectStore()
    await store.removeCanonical(root)
    expect(await store.listGrouped()).toEqual([meta(ordinary)])
    expect(JSON.parse(disk()).projects).toEqual([meta(ordinary)])
    expect(readFileSync(join(mocks.userData, 'projects.json'), 'utf8')).toContain(ordinary)
    expect(await canonicalProjectCwd(branch)).toBe(root)
    await store.removeCanonical(ordinary)
    expect(await store.listGrouped()).toEqual([])
  })

  it('explicitly removing a worktree removes its main and hidden list aliases', async () => {
    seed([meta(branch), meta(root), meta(ordinary)])
    const store = new ProjectStore()
    await store.removeCanonical(branch)
    expect(store.list()).toEqual([meta(ordinary)])
  })

  it('keeps a live worktree independent if its registered main directory is missing', async () => {
    rmSync(root, { recursive: true })
    seed([meta(branch)])
    const before = disk()
    expect(await new ProjectStore().listGrouped()).toEqual([meta(branch)])
    expect(disk()).toBe(before)
  })

  it('preserves unavailable/deleted Git records and ordinary names without heuristic folding', async () => {
    seed([meta(root, 'custom'), meta(branch), meta(ordinary)])
    registered.delete(branch)
    rmSync(branch, { recursive: true })
    const before = disk()
    expect(await new ProjectStore().listGrouped()).toEqual([meta(root, 'custom'), meta(branch), meta(ordinary)])
    expect(disk()).toBe(before)
    expect(await canonicalProjectCwd(ordinary)).toBe(ordinary)
    mocks.git.mockRejectedValue(new Error('Git unavailable'))
    expect(await canonicalProjectCwd(root)).toBe(root)
    expect(await new ProjectStore().listGrouped()).toHaveLength(3)
  })

  it('does not fold a subdirectory that Git reports inside a registered worktree', async () => {
    const nested = join(branch, 'src')
    mkdirSync(nested)
    registered.add(nested)
    mocks.git.mockImplementation(async (_cwd, args) => args[0] === 'rev-parse' ? branch : `worktree ${root}\nbranch refs/heads/main\n\nworktree ${branch}\nbranch refs/heads/feature\n`)
    expect(await canonicalProjectCwd(nested)).toBe(nested)
  })

  it('serializes delayed registration, removal and later registration without replaying stale writes', async () => {
    const normal = mocks.git.getMockImplementation()!
    let release!: () => void
    const delayed = new Promise<void>((resolve) => { release = resolve })
    let first = true
    mocks.git.mockImplementation(async (cwd, args) => {
      if (first) { first = false; await delayed }
      return normal(cwd, args)
    })
    const store = new ProjectStore()
    const add = store.touchCanonical(branch)
    const remove = store.removeCanonical(root)
    const later = store.touchCanonical(ordinary)
    const projection = store.listGrouped()
    release()
    await Promise.all([add, remove, later])
    expect(await projection).toEqual([expect.objectContaining({ cwd: ordinary })])
    expect(store.list()).toEqual([expect.objectContaining({ cwd: ordinary })])
  })

  it('retries a projection if a mutation arrives while its Git lookups are delayed', async () => {
    seed([meta(root)])
    const normal = mocks.git.getMockImplementation()!
    let release!: () => void
    let entered!: () => void
    const delayed = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    let first = true
    mocks.git.mockImplementation(async (cwd, args) => {
      if (first) { first = false; entered(); await delayed }
      return normal(cwd, args)
    })
    const store = new ProjectStore()
    const projection = store.listGrouped()
    await started
    await store.touchCanonical(ordinary)
    release()
    expect(await projection).toEqual([meta(root), expect.objectContaining({ cwd: ordinary })])
  })
})

// Evaluate the actual push function in isolation; no Electron application,
// user configuration, backend, or Git process is started by this harness.
function pushHarness() {
  const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf('let projectsPushRevision = 0')
  const end = source.indexOf('\nfunction createWindow()', start)
  const pending: Array<(value: ProjectMeta[]) => void> = []
  const context = {
    projects: { listGrouped: () => new Promise<ProjectMeta[]>((resolve) => pending.push(resolve)) },
    projectsPush: vi.fn(), mainWindowId: 1
  }
  const push = runInNewContext(source.slice(start, end).replace('(): Promise<void>', '()') + '\npushProjects', context) as () => Promise<void>
  return { push, pending, context }
}

describe('project push ordering', () => {
  it.each(['older-first', 'newer-first'])('publishes only the latest requested snapshot (%s)', async (order) => {
    const h = pushHarness()
    const old = h.push()
    const latest = h.push()
    if (order === 'older-first') {
      h.pending[0]([meta(root)])
      await old
      expect(h.context.projectsPush).not.toHaveBeenCalled()
    }
    h.pending[1]([meta(root), meta(ordinary)])
    await latest
    if (order === 'newer-first') {
      h.pending[0]([meta(root)])
      await old
    }
    expect(h.context.projectsPush).toHaveBeenCalledExactlyOnceWith([meta(root), meta(ordinary)])
  })

  it('drops a late snapshot for a replaced or closed owner window', async () => {
    const h = pushHarness()
    const previous = h.context.projectsPush
    const old = h.push()
    h.context.mainWindowId = 2
    h.context.projectsPush = vi.fn()
    h.pending[0]([meta(root)])
    await old
    expect(previous).not.toHaveBeenCalled()
    expect(h.context.projectsPush).not.toHaveBeenCalled()
    const closed = h.push()
    h.context.mainWindowId = 0
    h.pending[1]([meta(root)])
    await closed
    expect(h.context.projectsPush).not.toHaveBeenCalled()
  })
})
