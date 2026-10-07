import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  IMAGE_GENERATION_TOOL_NAME, resolveCodexImageRequestQuality, resolveCodexImageRequestSize,
  validateImageReferencePaths
} from '../../src/shared/image-generation'
import type { ToolPermissionRules } from '../../src/shared/types'

const testUserData = { dir: '' }
vi.mock('electron', () => ({
  app: {
    getPath: () => testUserData.dir,
    on: () => undefined
  }
}))

const {
  ToolPermissionStore, toolPermissionExtensionSource, TOOL_PERMISSION_MARKER, RUN_CHECKPOINT_MARKER
} = await import('../../src/main/tool-permissions')
const { parseToolPermissionMetadata } = await import('../../src/main/agent/tool-permission-request')

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

  it.each(['network', 'write', 'read'] as const)('does not let a stale project grant overwrite an inherited %s deny', async (category) => {
    const inherited: ToolPermissionRules = { read: 'allow', write: 'ask', shell: 'allow', network: 'ask', external: 'ask', [category]: 'deny' }
    const store = await storeWith({ [join(sep, 'repo')]: inherited })
    const child = join(sep, 'repo', 'app')
    const policy = await store.allowProjectCategories(child, ['network', 'write', 'read'])
    expect(policy.rules).toEqual(inherited)
    expect((await new ToolPermissionStore().getPolicy(child)).rules).toEqual(inherited)
  })

  it('preserves unrelated inherited rules when granting project categories', async () => {
    const inherited: ToolPermissionRules = { read: 'deny', write: 'ask', shell: 'deny', network: 'ask', external: 'deny' }
    const store = await storeWith({ [join(sep, 'repo')]: inherited })
    const policy = await store.allowProjectCategories(join(sep, 'repo', 'app'), ['network', 'write'])
    expect(policy.rules).toEqual({ ...inherited, write: 'allow', network: 'allow' })
  })

  it('defaults in-project write/shell to allow', async () => {
    const store = await storeWith({})
    const policy = await store.getPolicy(join(sep, 'nowhere', 'fresh-project'))
    expect(policy.rules.write).toBe('allow')
    expect(policy.rules.shell).toBe('allow')
    expect(policy.rules.network).toBe('ask')
  })
})

type GateEvent = { toolName: string; toolCallId: string; parentToolCallId?: string; input: Record<string | symbol, unknown> }
type GateResult = { block: true; reason: string } | undefined
type DialogSelect = (title: string, choices: string[], options: {
  timeout: number; signal?: AbortSignal
}) => Promise<string | undefined>
type GateContext = {
  cwd: string; hasUI: boolean; signal?: AbortSignal
  ui: { select: DialogSelect }
  sessionManager: { getSessionFile(): string | undefined }
}
type GateHandler = (event: GateEvent, ctx: GateContext) => Promise<GateResult>
type PermissionMetadata = {
  toolName: string; category: string; policyCategories: string[]
  summary: string; detail: string; risks: string[]; canRemember: boolean
  cwd: string; sessionPath?: string; subagent?: boolean
}

const PROJECT = resolve(sep, 'repo', 'app')
const SESSION = resolve(sep, 'sessions', 'image.jsonl')
const CONFIG = resolve(sep, 'pion-user-data', 'pion-tool-permissions.json')
const SUBAGENT_ABORT = Symbol.for('pion.subagent.abort')

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

// Evaluate the actual materialized extension, including shared-name interpolation.
// Policy/filesystem/UI are mocked; no SDK, network or image file is involved.
function extensionRuntime(projects: Record<string, unknown>, canonicalPaths: Record<string, string> = {}) {
  const source = toolPermissionExtensionSource()
    .replace(/^import \{ (.+) \} from "(node:.+)";$/gm, 'const { $1 } = require("$2");')
    .replace('export default function (pi)', 'function install(pi)')
  const readFileSync = vi.fn((path: string) => {
    if (path !== CONFIG) throw new Error(`unexpected read: ${path}`)
    return JSON.stringify({ projects })
  })
  const realpath = vi.fn((path: string) => canonicalPaths[path] ?? path)
  const handlers = new Map<string, GateHandler>()
  const tools: { name: string; sourceInfo: { source: string }; annotations?: { readOnlyHint: boolean } }[] = []
  const pi = {
    getAllTools: () => tools,
    on: (name: string, handler: GateHandler) => { handlers.set(name, handler) },
    registerCommand: vi.fn()
  }
  const api = new Function('require', 'process', `${source}; return {
    install, classify, projectRootOf, readPolicy, DEFAULTS, CHECKPOINT_READ_ONLY, PION_INTERNAL_TOOLS,
    validateImageReferencePaths, imageSizeLabel, imageQualityLabel
  };`)(
    (id: string) => {
      if (id === 'node:fs') return {
        readFileSync,
        realpathSync: { native: realpath }
      }
      if (id === 'node:path') return { basename, dirname, resolve, sep }
      throw new Error(`unexpected require: ${id}`)
    },
    { env: { PION_TOOL_PERMISSION_CONFIG: CONFIG } }
  ) as {
    install(api: typeof pi): void
    classify(event: GateEvent, ctx: GateContext): Omit<PermissionMetadata, 'cwd' | 'sessionPath' | 'subagent' | 'canRemember'>
    projectRootOf(cwd: string): string
    readPolicy(cwd: string): ToolPermissionRules
    validateImageReferencePaths(value: unknown): string[]
    imageSizeLabel(value: unknown): string
    imageQualityLabel(value: unknown): string
    DEFAULTS: ToolPermissionRules
    CHECKPOINT_READ_ONLY: Set<string>
    PION_INTERNAL_TOOLS: Set<string>
  }
  api.install(pi)
  const select = vi.fn<DialogSelect>(async (title) => title === RUN_CHECKPOINT_MARKER ? 'ready' : 'allow-once')
  const ctx: GateContext = {
    cwd: PROJECT, hasUI: true, ui: { select }, sessionManager: { getSessionFile: () => SESSION }
  }
  return { api, gate: handlers.get('tool_call')!, select, ctx, readFileSync, realpath, tools }
}

function imageRuntime(updates: Partial<ToolPermissionRules> = {}, canonicalPaths: Record<string, string> = {}) {
  // Denying unrelated categories makes an accidental external classification fail.
  const rules: ToolPermissionRules = {
    read: 'deny', write: 'allow', shell: 'deny', network: 'allow', external: 'deny', ...updates
  }
  const h = extensionRuntime({ [PROJECT]: rules }, canonicalPaths)
  const event: GateEvent = {
    toolName: IMAGE_GENERATION_TOOL_NAME, toolCallId: 'image-call',
    input: { prompt: 'A mock landscape', path: 'art/landscape.png' }
  }
  const execute = vi.fn(async () => undefined)
  const run = async (call = event) => {
    const result = await h.gate(call, h.ctx)
    if (!result?.block) await execute()
    return result
  }
  const permissions = () => h.select.mock.calls
    .filter(([title]) => title.startsWith(TOOL_PERMISSION_MARKER))
    .map(([title]) => JSON.parse(title.slice(TOOL_PERMISSION_MARKER.length)) as PermissionMetadata)
  return { ...h, rules, event, execute, run, permissions }
}

function delegate(h: ReturnType<typeof imageRuntime>, signal: AbortSignal) {
  // Children retain their existing coding-tool subset; do not give them the image tool.
  h.event.toolName = 'write'
  h.event.toolCallId = 'subagent-write-call'
  h.event.input = { path: 'src/child.ts', content: '// mock child write' }
  h.rules.write = 'ask'
  Object.defineProperty(h.event.input, SUBAGENT_ABORT, { value: signal })
}

describe('extension gate source', () => {
  it('maps worktree paths back to the base project and resolves its policy', () => {
    const { api } = extensionRuntime({
      [PROJECT]: { read: 'allow', write: 'allow', shell: 'allow', network: 'deny', external: 'ask' }
    })
    const worktree = join(sep, 'repo', '.pion-worktrees', 'app', 'feature-x')
    expect(api.projectRootOf(worktree)).toBe(PROJECT)
    expect(api.readPolicy(worktree)).toMatchObject({ shell: 'allow', network: 'deny' })
    expect(api.DEFAULTS.shell).toBe('allow')
  })
})

describe('native and legacy orchestration permission boundary', () => {
  const all = ['read', 'write', 'shell', 'network', 'external'] as const
  const allowed: ToolPermissionRules = { read: 'allow', write: 'allow', shell: 'allow', network: 'allow', external: 'allow' }
  const call = (toolName: string): GateEvent => ({
    toolName, toolCallId: 'codemode-parent/1', parentToolCallId: 'codemode-parent',
    input: { code: 'PRIVATE_SCRIPT', path: 'PRIVATE_PATH', args: { secret: 'PRIVATE_ARG' }, credentials: 'PRIVATE_CREDENTIAL' }
  })

  it.each(['codemode', 'mcp', 'mcpScript', 'mcp__server__read', 'mcp__server__delete', 'mcp__unknown__anything'])('gates all five categories for %s without trusting annotations or names', (name) => {
    const h = extensionRuntime({ [PROJECT]: allowed })
    h.tools.push({ name, sourceInfo: { source: 'builtin' }, annotations: { readOnlyHint: true } })
    expect(h.api.classify(call(name), h.ctx).policyCategories).toEqual(all)
    const metadata = JSON.stringify(h.api.classify(call(name), h.ctx))
    for (const privateValue of ['PRIVATE_SCRIPT', 'PRIVATE_PATH', 'PRIVATE_ARG', 'PRIVATE_CREDENTIAL']) expect(metadata).not.toContain(privateValue)
  })

  it.each(all)('blocks %s deny before checkpoint for outer codemode and nested MCP/legacy calls', async (category) => {
    const h = extensionRuntime({ [PROJECT]: { ...allowed, [category]: 'deny' } })
    for (const name of ['codemode', 'mcp__server__read', 'mcp', 'mcpScript']) {
      expect(await h.gate(call(name), h.ctx)).toMatchObject({ block: true })
    }
    expect(h.select).not.toHaveBeenCalled()
  })

  it('requires fee disclosure even for all-allow codemode, without echoing script/args/credentials', async () => {
    const h = extensionRuntime({ [PROJECT]: allowed })
    expect(await h.gate(call('codemode'), h.ctx)).toBeUndefined()
    expect(h.select.mock.calls[0][0]).toBe(RUN_CHECKPOINT_MARKER)
    const metadata = JSON.parse(h.select.mock.calls[1][0].slice(TOOL_PERMISSION_MARKER.length)) as PermissionMetadata
    expect(metadata.policyCategories).toEqual(all)
    expect(metadata.canRemember).toBe(false)
    expect(metadata.detail).toContain('付费 classifier/image')
    expect(metadata.detail).toContain('模型调用没有内层工具授权')
    expect(metadata.detail).toContain('不是 Pion Codex 生图的回退')
    for (const secret of ['PRIVATE_SCRIPT', 'PRIVATE_ARG', 'PRIVATE_PATH', 'PRIVATE_CREDENTIAL']) expect(JSON.stringify(metadata)).not.toContain(secret)
    expect(h.select.mock.calls[1][1]).toEqual(['allow-once', 'deny'])
  })

  it.each(all.flatMap((category) => ['codemode', 'mcp__server__read'].map((name) => ({ category, name }))))('gives a waiting $category deny priority over a late $name allow', async ({ category, name }) => {
    const rules: ToolPermissionRules = { ...allowed, external: 'ask' }
    const h = extensionRuntime({ [PROJECT]: rules })
    const opened = deferred<void>()
    const response = deferred<string | undefined>()
    h.select.mockImplementation((title) => {
      if (title === RUN_CHECKPOINT_MARKER) return Promise.resolve('ready')
      opened.resolve()
      return response.promise
    })
    const pending = h.gate(call(name), h.ctx)
    await opened.promise
    rules[category] = 'deny'
    response.resolve(name === 'codemode' ? 'allow-once' : 'allow-session')
    expect(await pending).toMatchObject({ block: true })
    rules[category] = 'allow'
    rules.external = 'ask'
    h.select.mockImplementation(async (title) => title === RUN_CHECKPOINT_MARKER ? 'ready' : 'deny')
    expect(await h.gate(call(name), h.ctx)).toMatchObject({ block: true })
  })

  it('does not reuse a legacy/MCP session grant to bypass outer codemode fees or nested write denies', async () => {
    const rules: ToolPermissionRules = { ...allowed, external: 'ask' }
    const h = extensionRuntime({ [PROJECT]: rules })
    h.select.mockImplementation(async (title) => title === RUN_CHECKPOINT_MARKER ? 'ready' : 'allow-session')
    expect(await h.gate(call('mcpScript'), h.ctx)).toBeUndefined()
    expect(await h.gate(call('mcp__server__read'), h.ctx)).toBeUndefined()
    h.select.mockImplementation(async (title) => title === RUN_CHECKPOINT_MARKER ? 'ready' : 'deny')
    expect(await h.gate(call('codemode'), h.ctx)).toMatchObject({ block: true })
    rules.write = 'deny'
    expect(await h.gate({ ...call('write'), input: { path: 'src/nested.ts', content: 'PRIVATE_ARG' } }, h.ctx)).toMatchObject({ block: true })
    expect(await h.gate(call('mcp__server__read'), h.ctx)).toMatchObject({ block: true })
  })

  it('holds a nested MCP call at the write checkpoint and rechecks a new deny before authorization', async () => {
    const rules = { ...allowed }
    const h = extensionRuntime({ [PROJECT]: rules })
    const checkpoint = deferred<string | undefined>()
    h.select.mockImplementationOnce(() => checkpoint.promise)
    const pending = h.gate(call('mcp__server__read'), h.ctx)
    expect(h.select.mock.calls[0][0]).toBe(RUN_CHECKPOINT_MARKER)
    rules.write = 'deny'
    checkpoint.resolve('ready')
    expect(await pending).toMatchObject({ block: true })
    expect(h.select).toHaveBeenCalledTimes(1)
  })

  it.each(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])('only gives builtin %s the resource-specific policy', (name) => {
    const h = extensionRuntime({ [PROJECT]: allowed })
    h.tools.push({ name, sourceInfo: { source: 'extension' }, annotations: { readOnlyHint: true } })
    expect(h.api.classify(call(name), h.ctx).policyCategories).toEqual(['external'])
    h.tools[0].sourceInfo.source = 'builtin'
    expect(h.api.classify(call(name), h.ctx).policyCategories).toEqual(['network', 'read', 'external'])
    expect(JSON.stringify(h.api.classify(call(name), h.ctx))).not.toContain('PRIVATE_ARG')
  })

  it('native discovery does not create a write checkpoint or inherit discovered tool side effects', async () => {
    const h = extensionRuntime({ [PROJECT]: { ...allowed, write: 'deny', shell: 'deny', network: 'deny' } })
    h.tools.push({ name: 'tool_search', sourceInfo: { source: 'builtin' } })
    expect(await h.gate(call('tool_search'), h.ctx)).toBeUndefined()
    expect(h.select).not.toHaveBeenCalled()
  })

  it('codemode cannot call paid models without a permission UI even when every policy allows it', async () => {
    const h = extensionRuntime({ [PROJECT]: allowed })
    h.ctx.hasUI = false
    expect(await h.gate(call('codemode'), h.ctx)).toMatchObject({ block: true })
    expect(h.select).not.toHaveBeenCalled()
  })

  it('native schema discovery does not claim write/shell/network execution and generic tools retain their scope', () => {
    const h = extensionRuntime({ [PROJECT]: allowed })
    h.tools.push({ name: 'tool_search', sourceInfo: { source: 'builtin' } })
    expect(h.api.classify(call('tool_search'), h.ctx).policyCategories).toEqual(['read', 'external'])
    expect(h.api.classify(call('tool_search'), h.ctx).detail).toContain('不执行发现的工具')
    expect(h.api.classify(call('unrelated_plugin'), h.ctx).policyCategories).toEqual(['external'])
    expect(h.api.classify(call('web_search'), h.ctx).policyCategories).toEqual(['network'])
  })
})

describe('image generation permission boundary', () => {
  it('classifies the native image tool as network + write and emits only short side-effect metadata', async () => {
    const h = imageRuntime({ network: 'ask' })
    h.event.input = {
      path: 'art/landscape.png', prompt: 'PRIVATE_PROMPT'.repeat(1000),
      b64_json: 'PRIVATE_BASE64'.repeat(1000), credentials: { accessToken: 'PRIVATE_TOKEN' }
    }
    expect(await h.run()).toBeUndefined()
    const metadata = h.permissions()[0]
    expect(metadata).toMatchObject({
      toolName: IMAGE_GENERATION_TOOL_NAME, category: 'network', policyCategories: ['network', 'write'],
      cwd: PROJECT, sessionPath: SESSION, risks: [], canRemember: true, subagent: false
    })
    expect(metadata.summary).toContain('生成图片')
    expect(metadata.detail).toContain(`目标路径：${resolve(PROJECT, 'art/landscape.png')}`)
    expect(metadata.detail).toContain('使用 Codex 图片额度')
    expect(metadata.detail).toContain('额外账号用量')
    expect(metadata.summary).toContain('Codex 自动（官方别名）')
    expect(metadata.detail).toContain('官方请求别名不是实际版本报告')
    const serialized = JSON.stringify(metadata)
    expect(serialized.length).toBeLessThan(1500)
    for (const secret of ['PRIVATE_PROMPT', 'PRIVATE_BASE64', 'PRIVATE_TOKEN']) {
      expect(serialized).not.toContain(secret)
    }
    expect(metadata).not.toHaveProperty('input')
    // Even malformed pathless calls must not fall back to serializing raw inputs.
    expect(JSON.stringify(h.api.classify({ ...h.event, input: { prompt: 'PRIVATE_PROMPT' } }, h.ctx)))
      .not.toContain('PRIVATE_PROMPT')
  })

  it.each([
    ['gpt-image-2.5-flare', 'Images 2.5 Flare（实验性）'],
    ['gpt-image-2.5-sunburst', 'Images 2.5 Sunburst（实验性）']
  ])('shows %s and compatibility uncertainty in the permission request', async (model, label) => {
    const h = imageRuntime({ network: 'ask' })
    h.event.input.model = model
    await h.run()
    const metadata = h.permissions()[0]
    expect(metadata.summary).toContain(label)
    expect(metadata.detail).toContain(label)
    expect(metadata.detail).toContain('订阅兼容性及账号权益未验证')
    expect(metadata.detail).toContain('不自动降级')
    expect(metadata.policyCategories).toEqual(['network', 'write'])
  })

  it('never copies an unknown model parameter into permission metadata', () => {
    const h = imageRuntime()
    h.event.input.model = 'PRIVATE_TOKEN'.repeat(1000)
    const metadata = h.api.classify(h.event, h.ctx)
    expect(metadata.summary).toContain('不支持的请求型号')
    expect(metadata.detail).toContain('不会自动改用默认型号')
    expect(JSON.stringify(metadata)).not.toContain('PRIVATE_TOKEN')
    expect(JSON.stringify(metadata).length).toBeLessThan(1500)
  })

  it.each(['write', 'network'] as const)('blocks when %s is denied, even if the other category is allowed', async (category) => {
    const h = imageRuntime({ [category]: 'deny' })
    expect(await h.run()).toMatchObject({ block: true, reason: 'Pion 项目权限策略已拒绝此工具调用' })
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.permissions()).toEqual([])
  })

  it('allows only the network + write combination, without external approval or a read-only exemption', async () => {
    const h = imageRuntime()
    expect(h.api.CHECKPOINT_READ_ONLY.has(IMAGE_GENERATION_TOOL_NAME)).toBe(false)
    expect(h.api.PION_INTERNAL_TOOLS.has(IMAGE_GENERATION_TOOL_NAME)).toBe(false)
    expect(await h.run()).toBeUndefined()
    expect(h.execute).toHaveBeenCalledTimes(1)
    expect(h.select).toHaveBeenCalledExactlyOnceWith(RUN_CHECKPOINT_MARKER, ['ready'], {
      timeout: 30_000, signal: undefined
    })
  })

  it('shows an image destination literally, without removing a leading @ from the filename', async () => {
    const h = imageRuntime({ network: 'ask' })
    h.event.input.path = '@.git/image.png'
    await h.run()
    expect(h.permissions()[0]).toMatchObject({ risks: [], canRemember: true })
    expect(h.permissions()[0].detail).toContain(resolve(PROJECT, '@.git/image.png'))
    // Existing built-in file-tool @ reference handling remains unchanged.
    expect(h.api.classify({ ...h.event, toolName: 'write' }, h.ctx)).toMatchObject({
      detail: resolve(PROJECT, '.git/image.png'), risks: ['sensitive-path']
    })
  })

  it('matches only the exact native image tool name, not a similarly named external tool', async () => {
    const h = imageRuntime()
    const other = { ...h.event, toolName: `${IMAGE_GENERATION_TOOL_NAME}_extra` }
    expect(h.api.classify(other, h.ctx).policyCategories).toEqual(['external'])
    expect(await h.run(other)).toMatchObject({ block: true })
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('waits for the write checkpoint before the image executor can run', async () => {
    const h = imageRuntime()
    const checkpoint = deferred<string | undefined>()
    h.select.mockImplementationOnce(() => checkpoint.promise)
    const pending = h.run()
    expect(h.select).toHaveBeenCalledTimes(1)
    expect(h.select.mock.calls[0][0]).toBe(RUN_CHECKPOINT_MARKER)
    expect(h.execute).not.toHaveBeenCalled()
    checkpoint.resolve('ready')
    expect(await pending).toBeUndefined()
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it.each(['write', 'network'] as const)('requires approval when %s is ask', async (category) => {
    const h = imageRuntime({ [category]: 'ask' })
    expect(await h.run()).toBeUndefined()
    expect(h.permissions()).toHaveLength(1)
    expect(h.permissions()[0].policyCategories).toEqual(['network', 'write'])
    expect(h.select.mock.calls[1][1]).toEqual(['allow-once', 'allow-session', 'allow-project', 'deny'])
    expect(h.select.mock.calls[1][2]).toEqual({ timeout: 120_000, signal: undefined })
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it.each(['allow-once', 'allow-session', 'allow-project'])('accepts explicit %s for an ordinary destination when both categories are ask', async (choice) => {
    const h = imageRuntime({ write: 'ask', network: 'ask' })
    h.select.mockImplementation(async (title) => title === RUN_CHECKPOINT_MARKER ? 'ready' : choice)
    expect(await h.run()).toBeUndefined()
    expect(h.permissions()[0].policyCategories).toEqual(['network', 'write'])
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it.each(['write', 'network'] as const)('does not authorize %s ask without UI', async (category) => {
    const h = imageRuntime({ [category]: 'ask' })
    h.ctx.hasUI = false
    expect(await h.run()).toMatchObject({ block: true, reason: '工具调用需要授权，但当前没有可用界面' })
    expect(h.select).not.toHaveBeenCalled()
    expect(h.execute).not.toHaveBeenCalled()
  })

  it.each([
    ['deny', 'deny'], ['cancel/timeout', undefined], ['unrecognized answer', 'ready']
  ])('never treats %s as approval', async (_label, choice) => {
    const h = imageRuntime({ write: 'ask', network: 'ask' })
    h.select.mockImplementation(async (title) => title === RUN_CHECKPOINT_MARKER ? 'ready' : choice)
    expect(await h.run()).toMatchObject({ block: true, reason: '工具调用未获用户授权' })
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('fails closed when the permission dialog rejects', async () => {
    const h = imageRuntime({ network: 'ask' })
    h.select.mockImplementation(async (title) => {
      if (title === RUN_CHECKPOINT_MARKER) return 'ready'
      throw new Error('UI timed out')
    })
    expect(await h.run()).toMatchObject({ block: true, reason: '工具调用未获用户授权' })
    expect(h.execute).not.toHaveBeenCalled()
  })

  it.each(['write', 'network'] as const)('keeps %s deny authoritative after session approval', async (category) => {
    const h = imageRuntime({ network: 'ask' })
    h.select.mockImplementation(async (title) => title === RUN_CHECKPOINT_MARKER ? 'ready' : 'allow-session')
    await h.run()
    await h.run()
    expect(h.permissions()).toHaveLength(1)
    expect(h.execute).toHaveBeenCalledTimes(2)
    h.rules[category] = 'deny'
    expect(await h.run()).toMatchObject({ block: true })
    expect(h.execute).toHaveBeenCalledTimes(2)
  })

  it.each(['write', 'network'] as const)('rechecks %s deny after a pending positive dialog and does not remember approval', async (category) => {
    const h = imageRuntime({ network: 'ask', write: 'ask' })
    const opened = deferred<void>()
    const response = deferred<string | undefined>()
    h.select.mockImplementation((title) => {
      if (title === RUN_CHECKPOINT_MARKER) return Promise.resolve('ready')
      opened.resolve()
      return response.promise
    })
    const pending = h.run()
    await opened.promise
    h.rules[category] = 'deny'
    response.resolve('allow-session')
    expect(await pending).toEqual({ block: true, reason: 'Pion 项目权限策略已拒绝此工具调用' })
    expect(h.execute).not.toHaveBeenCalled()
    h.rules[category] = 'ask'
    h.select.mockImplementation(async (title) => title === RUN_CHECKPOINT_MARKER ? 'ready' : 'deny')
    expect(await h.run()).toMatchObject({ block: true })
    expect(h.permissions()).toHaveLength(2)
  })

  it.each([
    { path: '../outside/image.png', risk: 'outside-workspace' },
    { path: '.git/image.png', risk: 'sensitive-path' }
  ])('forces non-rememberable confirmation for $risk, even with both categories allowed', async ({ path, risk }) => {
    const h = imageRuntime()
    h.event.input.path = path
    h.select.mockImplementation(async (title) => title === RUN_CHECKPOINT_MARKER ? 'ready' : 'deny')
    expect(await h.run()).toMatchObject({ block: true })
    expect(h.permissions()[0]).toMatchObject({ risks: [risk], canRemember: false })
    expect(h.select.mock.calls[1][1]).toEqual(['allow-once', 'deny'])
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('blocks a risky destination without UI even when both categories are allowed', async () => {
    const h = imageRuntime()
    h.event.input.path = '../outside/image.png'
    h.ctx.hasUI = false
    expect(await h.run()).toMatchObject({ block: true, reason: '工具调用需要授权，但当前没有可用界面' })
    expect(h.select).not.toHaveBeenCalled()
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('does not accept an unavailable remember choice for a risky destination', async () => {
    const h = imageRuntime()
    h.event.input.path = '.git/image.png'
    h.select.mockImplementation(async (title) => title === RUN_CHECKPOINT_MARKER ? 'ready' : 'allow-project')
    expect(await h.run()).toMatchObject({ block: true })
    expect(h.execute).not.toHaveBeenCalled()
  })
})

describe('image reference permission boundary', () => {
  it.each([undefined, []].map((references) => ({ references })))('keeps text-only calls independent of read deny (%j)', async ({ references }) => {
    const h = imageRuntime({ read: 'deny', network: 'ask' })
    h.event.input.referenced_image_paths = references
    expect(await h.run()).toBeUndefined()
    expect(h.permissions()[0].policyCategories).toEqual(['network', 'write'])
    expect(h.permissions()[0].detail).toContain('输入：文字（无参考图片）')
    expect(h.permissions()[0].detail).toContain('请求尺寸：auto；请求质量：auto')
    expect(h.permissions()[0].summary).toContain('生成图片')
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it('requires network + write + read for editing and retains the write checkpoint', async () => {
    const h = imageRuntime({ read: 'allow' })
    h.event.input.referenced_image_paths = ['art/source.png', 'art/original.jpeg']
    expect(h.api.classify(h.event, h.ctx).policyCategories).toEqual(['network', 'write', 'read'])
    const checkpoint = deferred<string | undefined>()
    h.select.mockImplementationOnce(() => checkpoint.promise)
    const pending = h.run()
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.select.mock.calls[0][0]).toBe(RUN_CHECKPOINT_MARKER)
    checkpoint.resolve('ready')
    expect(await pending).toBeUndefined()
    expect(h.permissions()).toEqual([])
    expect(h.execute).toHaveBeenCalledTimes(1)
    expect(h.readFileSync.mock.calls.every(([path]) => path === CONFIG)).toBe(true)
  })

  it.each(['network', 'write', 'read'] as const)('blocks reference editing when only %s is denied', async (category) => {
    const h = imageRuntime({ read: 'allow', network: 'allow', write: 'allow', [category]: 'deny' })
    h.event.input.referenced_image_paths = ['art/source.jpg']
    expect(await h.run()).toEqual({ block: true, reason: 'Pion 项目权限策略已拒绝此工具调用' })
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.permissions()).toEqual([])
  })

  it.each(['allow-once', 'allow-session', 'allow-project'])('asks for read alone and accepts explicit %s', async (choice) => {
    const h = imageRuntime({ read: 'ask' })
    h.event.input = {
      path: 'art/edited.png', prompt: 'PRIVATE_PROMPT', referenced_image_paths: ['art/source.png', 'art/original.jpg'],
      model: 'gpt-image-2.5-sunburst', size: '1024x1536', quality: 'high'
    }
    h.select.mockImplementation(async (title) => title === RUN_CHECKPOINT_MARKER ? 'ready' : choice)
    expect(await h.run()).toBeUndefined()
    const metadata = h.permissions()[0]
    expect(metadata).toMatchObject({ policyCategories: ['network', 'write', 'read'], risks: [], canRemember: true })
    expect(metadata.summary).toContain('编辑图片')
    expect(metadata.detail).toContain(`目标路径：${resolve(PROJECT, 'art/edited.png')}（输出·写入 PNG 新文件）`)
    expect(metadata.detail).toContain('参考输入 1（读取·项目相对）：art/source.png')
    expect(metadata.detail).toContain('参考输入 2（读取·项目相对）：art/original.jpg')
    expect(metadata.detail).toContain('gpt-image-2.5-sunburst')
    expect(metadata.detail).toContain('订阅兼容性及账号权益未验证')
    expect(metadata.detail).toContain('请求尺寸：1024x1536；请求质量：high')
    expect(metadata.detail).toContain('尺寸/质量不保证服务接受或精确输出')
    expect(metadata.detail).toContain('上传完整参考/原图文件（包含文件内 metadata）')
    expect(metadata.detail).toContain('失败或取消也可能消耗额度')
    expect(metadata.detail).toContain('不自动重试或降级，无 API-key/付费 API 回退')
    expect(JSON.stringify(metadata)).not.toContain('PRIVATE_PROMPT')
    expect(h.select.mock.calls[1][1]).toEqual(['allow-once', 'allow-session', 'allow-project', 'deny'])
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it('does not run references requiring read ask without UI', async () => {
    const h = imageRuntime({ read: 'ask' })
    h.event.input.referenced_image_paths = ['art/source.png']
    h.ctx.hasUI = false
    expect(await h.run()).toMatchObject({ block: true, reason: '工具调用需要授权，但当前没有可用界面' })
    expect(h.select).not.toHaveBeenCalled()
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('does not reuse a text-only session grant for reference reads', async () => {
    const h = imageRuntime({ network: 'ask', read: 'ask' })
    h.select.mockImplementation(async (title) => title === RUN_CHECKPOINT_MARKER ? 'ready' : 'allow-session')
    expect(await h.run()).toBeUndefined()
    h.event.input.referenced_image_paths = ['art/source.png']
    h.select.mockImplementation(async (title) => title === RUN_CHECKPOINT_MARKER ? 'ready' : 'deny')
    expect(await h.run()).toMatchObject({ block: true })
    expect(h.permissions()).toHaveLength(2)
    expect(h.permissions()[1].policyCategories).toEqual(['network', 'write', 'read'])
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it.each(['allow-once', 'allow-session', 'allow-project'])('rechecks pending read deny before accepting or remembering %s', async (choice) => {
    const h = imageRuntime({ read: 'ask' })
    h.event.input.referenced_image_paths = ['art/source.png']
    const opened = deferred<void>()
    const response = deferred<string | undefined>()
    h.select.mockImplementation((title) => {
      if (title === RUN_CHECKPOINT_MARKER) return Promise.resolve('ready')
      opened.resolve()
      return response.promise
    })
    const pending = h.run()
    await opened.promise
    h.rules.read = 'deny'
    response.resolve(choice)
    expect(await pending).toEqual({ block: true, reason: 'Pion 项目权限策略已拒绝此工具调用' })
    expect(h.execute).not.toHaveBeenCalled()
    h.rules.read = 'ask'
    h.select.mockImplementation(async (title) => title === RUN_CHECKPOINT_MARKER ? 'ready' : 'deny')
    expect(await h.run()).toMatchObject({ block: true })
    expect(h.permissions()).toHaveLength(2)
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('keeps read deny authoritative after a reference session grant without blocking text-only generation', async () => {
    const h = imageRuntime({ read: 'ask' })
    h.event.input.referenced_image_paths = ['art/source.png']
    h.select.mockImplementation(async (title) => title === RUN_CHECKPOINT_MARKER ? 'ready' : 'allow-session')
    await h.run()
    await h.run()
    expect(h.permissions()).toHaveLength(1)
    h.rules.read = 'deny'
    expect(await h.run()).toMatchObject({ block: true })
    expect(h.execute).toHaveBeenCalledTimes(2)
    delete h.event.input.referenced_image_paths
    expect(await h.run()).toBeUndefined()
    expect(h.execute).toHaveBeenCalledTimes(3)
  })

  it.each([
    { second: '.ssh/source.jpg', risk: 'sensitive-path' },
    { second: '../outside/source.png', risk: 'outside-workspace' }
  ])('does not miss a $risk reference in the second slot', async ({ second, risk }) => {
    const h = imageRuntime({ read: 'allow' })
    h.event.input.referenced_image_paths = ['art/safe.png', second]
    h.select.mockImplementation(async (title) => title === RUN_CHECKPOINT_MARKER ? 'ready' : 'deny')
    expect(await h.run()).toMatchObject({ block: true })
    expect(h.permissions()[0]).toMatchObject({ policyCategories: ['network', 'write', 'read'], risks: [risk], canRemember: false })
    expect(h.select.mock.calls[1][1]).toEqual(['allow-once', 'deny'])
    expect(h.realpath).toHaveBeenCalledWith(resolve(PROJECT, second))
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('canonicalizes every reference and deduplicates combined output/read risks without reading image bytes', async () => {
    const second = resolve(PROJECT, 'art/second.png')
    const third = resolve(PROJECT, 'art/third.jpg')
    const h = imageRuntime({ read: 'allow' }, {
      [second]: resolve(sep, 'outside', '.ssh', 'source.png'),
      [third]: resolve(sep, 'outside', '.git', 'source.jpg')
    })
    h.event.input.path = '.git/output.png'
    h.event.input.referenced_image_paths = ['art/safe.png', 'art/second.png', 'art/third.jpg']
    h.select.mockImplementation(async (title) => title === RUN_CHECKPOINT_MARKER ? 'ready' : 'allow-once')
    expect(await h.run()).toBeUndefined()
    expect(h.permissions()[0]).toMatchObject({ risks: ['sensitive-path', 'outside-workspace'], canRemember: false })
    for (const path of ['art/safe.png', 'art/second.png', 'art/third.jpg']) {
      expect(h.realpath).toHaveBeenCalledWith(resolve(PROJECT, path))
    }
    expect(h.readFileSync.mock.calls.every(([path]) => path === CONFIG)).toBe(true)
    expect(h.readFileSync).toHaveBeenCalled()
  })

  it('treats leading @ as literal for input images as well as the output', async () => {
    const h = imageRuntime({ read: 'ask' })
    h.event.input.path = '@.git/output.png'
    h.event.input.referenced_image_paths = ['@.git/source.png', '@art/original.jpg']
    await h.run()
    expect(h.permissions()[0]).toMatchObject({ risks: [], canRemember: true })
    expect(h.permissions()[0].detail).toContain('@.git/source.png')
    expect(h.realpath).toHaveBeenCalledWith(resolve(PROJECT, '@.git/source.png'))
    expect(h.realpath).not.toHaveBeenCalledWith(resolve(PROJECT, '.git/source.png'))
  })

  it('retains worktree policy inheritance without promising a wider image-reader root', async () => {
    const h = imageRuntime({ read: 'ask' })
    const worktree = join(sep, 'repo', '.pion-worktrees', 'app', 'feature-x')
    h.ctx.cwd = worktree
    h.event.input.referenced_image_paths = ['art/source.png']
    expect(await h.run()).toBeUndefined()
    expect(h.permissions()[0].policyCategories).toEqual(['network', 'write', 'read'])
    expect(h.permissions()[0].cwd).toBe(worktree)
    expect(h.permissions()[0].detail).toContain('读取仍仅限当前项目实际目录')
  })

  it.each([
    null, 'PRIVATE_BASE64', { payload: 'PRIVATE_BASE64' }, [null], [42],
    ['PRIVATE_BASE64'], ['art/safe.png', '../PRIVATE_BASE64.png'],
    ['a'.repeat(513) + '.png'], Array.from({ length: 6 }, () => 'art/source.png'),
    Array.from({ length: 5 }, () => `${'a'.repeat(200)}/${'b'.repeat(130)}.png`)
  ].map((references) => ({ references })))('fails closed on malformed reference parameters without echoing them (%j)', async ({ references }) => {
    const h = imageRuntime({ network: 'ask', read: 'deny' })
    h.event.input.referenced_image_paths = references
    const metadata = h.api.classify(h.event, h.ctx)
    expect(metadata.policyCategories).toEqual(['network', 'write', 'read'])
    expect(metadata.detail).toContain('参考输入：参数无效，执行将拒绝')
    expect(JSON.stringify(metadata)).not.toContain('PRIVATE_BASE64')
    expect(await h.run()).toMatchObject({ block: true })
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.permissions()).toEqual([])
  })

  it('never traverses oversized arrays, iterates custom image payloads or serializes unknown fields', () => {
    const h = imageRuntime()
    const touch = vi.fn(() => { throw new Error('must not visit image payload') })
    const references = new Proxy(new Array(1_000_000), {
      get: (target, key, receiver) => key === 'length' ? Reflect.get(target, key, receiver) : touch()
    })
    const unknown = { toJSON: touch, toString: touch, [Symbol.iterator]: touch, payload: 'PRIVATE_TOKEN' }
    h.event.input = {
      referenced_image_paths: references, prompt: 'PRIVATE_PROMPT'.repeat(1000),
      images: unknown, credentials: unknown, mask: unknown, model: 'PRIVATE_MODEL'.repeat(1000),
      size: unknown, quality: 'PRIVATE_QUALITY'.repeat(1000), path: 'PRIVATE_PATH'.repeat(1000),
      b64_json: 'PRIVATE_BASE64'.repeat(1000)
    }
    const metadata = h.api.classify(h.event, h.ctx)
    expect(metadata.policyCategories).toEqual(['network', 'write', 'read'])
    expect(metadata.detail).toContain('参数无效，执行将拒绝')
    expect(touch).not.toHaveBeenCalled()
    const serialized = JSON.stringify(metadata)
    for (const secret of ['PRIVATE_TOKEN', 'PRIVATE_PROMPT', 'PRIVATE_MODEL', 'PRIVATE_QUALITY', 'PRIVATE_BASE64', 'PRIVATE_PATH']) {
      expect(serialized).not.toContain(secret)
    }
    expect(metadata.detail.length).toBeLessThan(1000)
    expect(h.readFileSync).not.toHaveBeenCalled()
    expect(h.realpath.mock.calls.length).toBeLessThan(10)
    // Even a short array with an unbounded custom iterator uses indexed bounds.
    const short = ['art/source.png']
    Object.defineProperty(short, Symbol.iterator, { value: touch })
    h.event.input.referenced_image_paths = short
    expect(h.api.classify(h.event, h.ctx).detail).toContain('art/source.png')
    expect(touch).not.toHaveBeenCalled()
  })

  it('does not serialize prompt, image bytes, credentials or invalid settings in a pathless malformed reference dialog', async () => {
    const h = imageRuntime({ network: 'ask', read: 'ask' })
    h.event.input = {
      referenced_image_paths: { b64_json: 'PRIVATE_BASE64' }, prompt: 'PRIVATE_PROMPT', images: ['PRIVATE_BASE64'],
      credentials: { accessToken: 'PRIVATE_TOKEN' }, model: 'PRIVATE_MODEL', size: 'PRIVATE_SIZE', quality: 'PRIVATE_QUALITY'
    }
    h.select.mockImplementation(async (title) => title === RUN_CHECKPOINT_MARKER ? 'ready' : 'deny')
    expect(await h.run()).toMatchObject({ block: true })
    const metadata = h.permissions()[0]
    expect(metadata.policyCategories).toEqual(['network', 'write', 'read'])
    expect(metadata.detail).toContain('参考输入：参数无效，执行将拒绝')
    for (const secret of ['PRIVATE_BASE64', 'PRIVATE_PROMPT', 'PRIVATE_TOKEN', 'PRIVATE_MODEL', 'PRIVATE_SIZE', 'PRIVATE_QUALITY']) {
      expect(JSON.stringify(metadata)).not.toContain(secret)
    }
    expect(h.execute).not.toHaveBeenCalled()
  })

  it.each([
    { cwd: PROJECT }, { cwd: resolve(sep, ...Array.from({ length: 16 }, () => 'c'.repeat(200))) }
  ])('shows the complete maximum-budget reference list and output below the real parser clamp (%j)', async ({ cwd }) => {
    const h = imageRuntime({ read: 'ask' })
    h.ctx.cwd = cwd
    const references = Array.from({ length: 5 }, (_, index) => `${'r'.repeat(150)}/${index}${'s'.repeat(164)}.png`)
    const output = `${Array.from({ length: 4 }, () => 'o'.repeat(200)).join('/')}/${'n'.repeat(216)}.png`
    expect(references.reduce((sum, path) => sum + path.length, 0)).toBe(1600)
    expect(output.length).toBe(1024)
    expect(validateImageReferencePaths(references)).toEqual(references)
    h.event.input = { path: output, referenced_image_paths: references, model: 'gpt-image-2.5-flare', size: '4096x3840', quality: 'high' }
    await h.run()
    const metadata = h.permissions()[0]
    expect(metadata.detail.length).toBeLessThanOrEqual(4000)
    expect(metadata.detail).toContain(output)
    for (const [index, reference] of references.entries()) {
      expect(metadata.detail).toContain(`参考输入 ${index + 1}（读取·项目相对）：${reference}`)
    }
    expect(metadata.detail).not.toContain('…')
    if (resolve(cwd, output).length > 1200) expect(metadata.detail).not.toContain(cwd)
    else expect(metadata.detail).toContain(resolve(cwd, output))
    const title = h.select.mock.calls.find(([value]) => value.startsWith(TOOL_PERMISSION_MARKER))![0]
    expect(parseToolPermissionMetadata(title)?.detail).toBe(metadata.detail)
    expect(metadata.detail).toContain('无 API-key/付费 API 回退')
  })
})

// The generated gate is standalone JS: verify parity with pure shared admission
// instead of accidentally relying on an application path in the CLI extension.
describe('standalone image permission helpers', () => {
  it('imports only node filesystem/path modules', () => {
    expect(toolPermissionExtensionSource().match(/^import .+;$/gm)).toEqual([
      'import { readFileSync, realpathSync } from "node:fs";',
      'import { basename, dirname, resolve, sep } from "node:path";'
    ])
  })

  it.each([
    undefined, [], ['art/source.png', './art/original.JPEG', '@art/source.jpg'],
    ['.ssh/source.png'], ['../outside.png'], ['/absolute.png'], ['C:/absolute.jpg'], ['a\\b.png'],
    ['nul.png'], ['art/con.jpg'], ['a./source.png'], ['a//source.png'], ['\ud800.png'],
    [`${'é'.repeat(128)}.png`], ['https://example.org/a.png'], ['art/source.gif'], [null],
    Array.from({ length: 6 }, () => 'source.png'),
    Array.from({ length: 5 }, () => `${'a'.repeat(200)}/${'b'.repeat(130)}.png`)
  ].map((value) => ({ value })))('matches shared reference-path validation for %j', ({ value }) => {
    const { api } = extensionRuntime({})
    let expected: string[]
    try { expected = validateImageReferencePaths(value) } catch {
      expect(() => api.validateImageReferencePaths(value)).toThrow()
      return
    }
    expect(api.validateImageReferencePaths(value)).toEqual(expected)
  })

  it.each([NaN, -1, 1.5, Infinity])('rejects anomalous array lengths %s consistently and keeps read deny authoritative', async (length) => {
    const references = new Proxy(['art/source.png'], { get: (target, property, receiver) =>
      property === 'length' ? length : Reflect.get(target, property, receiver) })
    const h = imageRuntime({ read: 'deny' })
    expect(() => validateImageReferencePaths(references)).toThrow()
    expect(() => h.api.validateImageReferencePaths(references)).toThrow()
    h.event.input.referenced_image_paths = references
    expect(h.api.classify(h.event, h.ctx).policyCategories).toEqual(['network', 'write', 'read'])
    expect(await h.run()).toMatchObject({ block: true })
    expect(h.execute).not.toHaveBeenCalled()
  })

  it.each([undefined, 'auto', '16x16', '1024x1536', '4096x3840', '4096x4096', '4097x1024', '1000x1000', '1024X1024', '16x64', 'PRIVATE_SIZE', null])('matches shared size admission without echoing invalid values (%j)', (value) => {
    const { api } = extensionRuntime({})
    let expected: string
    try { expected = resolveCodexImageRequestSize(value) } catch { expected = '参数无效，执行将拒绝' }
    expect(api.imageSizeLabel(value)).toBe(expected)
  })

  it.each([undefined, 'auto', 'low', 'medium', 'high', 'HIGH', 'PRIVATE_QUALITY', null])('matches shared quality admission without echoing invalid values (%j)', (value) => {
    const { api } = extensionRuntime({})
    let expected: string
    try { expected = resolveCodexImageRequestQuality(value) } catch { expected = '参数无效，执行将拒绝' }
    expect(api.imageQualityLabel(value)).toBe(expected)
  })
})

describe('tool permission cancellation', () => {
  it.each([
    { owner: 'main', stage: 'checkpoint' }, { owner: 'main', stage: 'permission' },
    { owner: 'subagent', stage: 'checkpoint' }, { owner: 'subagent', stage: 'permission' }
  ])('cancels $owner waiting for $stage without executing or accepting a late allow', async ({ owner, stage }) => {
    const h = imageRuntime({ network: 'ask' })
    const main = new AbortController()
    const child = new AbortController()
    h.ctx.signal = main.signal
    if (owner === 'subagent') delegate(h, child.signal)
    const controller = owner === 'subagent' ? child : main
    const opened = deferred<void>()
    const response = deferred<string | undefined>()
    h.select.mockImplementation((title, _choices, options) => {
      expect(options.signal).toBe(controller.signal)
      if (stage === 'permission' && title === RUN_CHECKPOINT_MARKER) return Promise.resolve('ready')
      options.signal!.addEventListener('abort', () => response.resolve(undefined), { once: true })
      opened.resolve()
      return response.promise
    })
    const pending = h.run()
    await opened.promise
    controller.abort()
    expect(await pending).toEqual({ block: true, reason: owner === 'subagent' ? '子代理已中止' : '工具调用已中止' })
    response.resolve('allow-session') // a late client response cannot revive the cancelled operation
    expect(h.execute).not.toHaveBeenCalled()
  })

  it.each(['main', 'subagent'] as const)('checks %s abort again after a late positive UI response and does not remember it', async (owner) => {
    const h = imageRuntime({ network: 'ask' })
    const main = new AbortController()
    const child = new AbortController()
    h.ctx.signal = main.signal
    if (owner === 'subagent') delegate(h, child.signal)
    const controller = owner === 'subagent' ? child : main
    const opened = deferred<void>()
    const response = deferred<string | undefined>()
    h.select.mockImplementation((title) => {
      if (title === RUN_CHECKPOINT_MARKER) return Promise.resolve('ready')
      opened.resolve()
      return response.promise // deliberately emulate a UI that races with cancellation
    })
    const pending = h.run()
    await opened.promise
    controller.abort()
    response.resolve('allow-session')
    expect(await pending).toMatchObject({ block: true })
    expect(h.execute).not.toHaveBeenCalled()
    h.ctx.signal = new AbortController().signal
    h.event.input = owner === 'subagent'
      ? { path: 'src/next.ts', content: '// mock child write' }
      : { prompt: 'Another mock landscape', path: 'art/next.png' }
    h.select.mockImplementation(async (title) => title === RUN_CHECKPOINT_MARKER ? 'ready' : 'deny')
    expect(await h.run()).toMatchObject({ block: true })
    expect(h.permissions()).toHaveLength(2)
    expect(h.execute).not.toHaveBeenCalled()
  })

  it.each(['main', 'subagent'] as const)('blocks an already aborted %s signal before checkpoint or permission UI', async (owner) => {
    const h = imageRuntime()
    const main = new AbortController()
    const child = new AbortController()
    h.ctx.signal = main.signal
    if (owner === 'subagent') delegate(h, child.signal)
    const controller = owner === 'subagent' ? child : main
    controller.abort()
    expect(await h.run()).toEqual({ block: true, reason: owner === 'subagent' ? '子代理已中止' : '工具调用已中止' })
    expect(h.select).not.toHaveBeenCalled()
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('prefers the child symbol signal over an aborted parent context and preserves child metadata', async () => {
    const h = imageRuntime({ network: 'ask' })
    const main = new AbortController()
    main.abort()
    h.ctx.signal = main.signal
    const child = new AbortController()
    delegate(h, child.signal)
    expect(await h.run()).toBeUndefined()
    for (const [, , options] of h.select.mock.calls) expect(options.signal).toBe(child.signal)
    expect(h.permissions()[0]).toMatchObject({ subagent: true, cwd: PROJECT, sessionPath: SESSION })
    expect(h.execute).toHaveBeenCalledTimes(1)
    child.abort()
    expect(await h.run()).toEqual({ block: true, reason: '子代理已中止' })
    expect(h.execute).toHaveBeenCalledTimes(1)
  })
})
