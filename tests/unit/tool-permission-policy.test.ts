import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const testUserData = { dir: '' }
vi.mock('electron', () => ({
  app: {
    getPath: () => testUserData.dir,
    on: () => undefined
  }
}))

const { ToolPermissionStore } = await import('../../src/main/tool-permissions')

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function storeWith(rules: Record<string, unknown>): Promise<InstanceType<typeof ToolPermissionStore>> {
  const root = await mkdtemp(join(tmpdir(), 'pion-perm-'))
  roots.push(root)
  testUserData.dir = root
  const store = new ToolPermissionStore()
  await writeFile(join(root, 'pion-tool-permissions.json'), JSON.stringify({ version: 1, projects: rules }), 'utf8')
  return store
}

describe('tool permission policy resolution', () => {
  it('worktree sessions inherit the base project policy', async () => {
    const store = await storeWith({
      '/repo/app': { read: 'allow', write: 'allow', shell: 'allow', network: 'deny', external: 'ask' }
    })
    const worktree = join(sep, 'repo', '.pion-worktrees', 'app', 'feature-x')
    const policy = await store.getPolicy(worktree)
    expect(policy.rules).toMatchObject({ shell: 'allow', network: 'deny' })
  })

  it('falls back to the longest configured prefix when no exact match exists', async () => {
    const store = await storeWith({
      '/repo': { read: 'allow', write: 'deny', shell: 'deny', network: 'deny', external: 'deny' }
    })
    const policy = await store.getPolicy(join(sep, 'repo', 'nested', 'deeper'))
    expect(policy.rules.shell).toBe('deny')
  })

  it('defaults in-project write/shell to allow', async () => {
    const store = await storeWith({})
    const policy = await store.getPolicy(join(sep, 'nowhere', 'fresh-project'))
    expect(policy.rules.write).toBe('allow')
    expect(policy.rules.shell).toBe('allow')
    expect(policy.rules.network).toBe('ask')
  })
})

describe('extension gate source', () => {
  it('maps worktree paths back to the base project and resolves its policy', () => {
    const source = readFileSync('src/main/tool-permissions.ts', 'utf8')
    const start = source.indexOf('return String.raw`') + 'return String.raw`'.length
    const end = source.indexOf('`;', start)
    const extensionSource = source.slice(start, end)
      .split('\n')
      .filter((line) => {
        const trimmed = line.trimStart()
        return !trimmed.startsWith('export ')
      })
      .map((line) => line.replace(/^\s*import \{ (.+) \} from "(node:.+)";?$/, 'const { $1 } = require("$2");'))
      .join('\n')
      // 去掉 export default 包装函数的收尾大括号
      .replace(/\}\s*$/, '')
    const canonicalProject = join(sep, 'repo', 'app')
    const configFile = join(tmpdir(), 'perm-gate-config.json')
    const config = { projects: { [canonicalProject]: { read: 'allow', write: 'allow', shell: 'allow', network: 'deny', external: 'ask' } } }
    const realpathSync = { native: (p: string) => p }
    // 在 VM 里评估扩展源码中的 projectRootOf + readPolicy
    const evaluated = new Function(
      'require',
      'process',
      'pi',
      `${extensionSource}; return { projectRootOf, readPolicy, DEFAULTS }`
    )
    const api = evaluated(
      (id: string) => {
        if (id === 'node:fs') return { readFileSync: (path: string) => path === configFile ? JSON.stringify(config) : readFileSync(path, 'utf8'), realpathSync }
        if (id === 'node:path') return { basename: (p: string) => p.split(sep).pop(), dirname: (p: string) => p.split(sep).slice(0, -1).join(sep) || sep, resolve: (...parts: string[]) => join(...parts), sep }
        throw new Error(`unexpected require: ${id}`)
      },
      { env: { PION_TOOL_PERMISSION_CONFIG: configFile } },
      { on: () => undefined, registerCommand: () => undefined }
    ) as { projectRootOf: (cwd: string) => string; readPolicy: (cwd: string) => Record<string, string>; DEFAULTS: Record<string, string> }

    const worktree = join(sep, 'repo', '.pion-worktrees', 'app', 'feature-x')
    expect(api.projectRootOf(worktree)).toBe(canonicalProject)
    const policy = api.readPolicy(worktree)
    expect(policy.shell).toBe('allow')
    expect(policy.network).toBe('deny')
    expect(api.DEFAULTS.shell).toBe('allow')
  })
})
