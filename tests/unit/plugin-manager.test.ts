import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsManager } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginManager } from '../../src/main/plugin-manager'

const originalAgentDir = process.env.PI_CODING_AGENT_DIR
const originalPath = process.env.PATH
const originalLog = process.env.PION_FAKE_PM_LOG
const roots: string[] = []

afterEach(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  if (originalLog === undefined) delete process.env.PION_FAKE_PM_LOG
  else process.env.PION_FAKE_PM_LOG = originalLog
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  })))
})

async function createPackageFixture(): Promise<{
  root: string
  agentDir: string
  binDir: string
  logPath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'pion-plugin-manager-'))
  roots.push(root)
  const agentDir = join(root, 'agent')
  const binDir = join(root, 'bin')
  const logPath = join(root, 'package-manager.log')
  await mkdir(join(agentDir, 'npm'), { recursive: true })
  await mkdir(binDir, { recursive: true })
  await writeFile(join(agentDir, 'npm', 'package.json'), JSON.stringify({
    private: true,
    dependencies: { 'pi-subagents': '1.0.0' }
  }))
  const settings = SettingsManager.create(homedir(), agentDir)
  settings.setPackages(['npm:pi-subagents'])
  await settings.flush()
  return { root, agentDir, binDir, logPath }
}

async function installFakeBun(fixture: Awaited<ReturnType<typeof createPackageFixture>>): Promise<string> {
  // POSIX 用可执行的 sh 脚本；Windows 用 .cmd 垫片转发到 node 脚本
  // （PATH 里没有 node 也能跑，垫片中写死了绝对路径）
  if (process.platform === 'win32') {
    const script = join(fixture.binDir, 'fake-bun.mjs')
    await writeFile(script, [
      "import { writeFileSync } from 'node:fs'",
      "const file = process.env.PION_FAKE_PM_LOG",
      "if (file) writeFileSync(file, process.argv.slice(2).join('\\n') + '\\n')",
      ''
    ].join('\n'))
    const bunPath = join(fixture.binDir, 'bun.cmd')
    await writeFile(bunPath, `@${JSON.stringify(process.execPath)} "${script}" %*\r\n`)
    const command = bunPath
    process.env.PI_CODING_AGENT_DIR = fixture.agentDir
    process.env.PATH = fixture.binDir
    process.env.PION_FAKE_PM_LOG = fixture.logPath
    return command
  }
  const bunPath = join(fixture.binDir, 'bun')
  await writeFile(bunPath, '#!/bin/sh\nprintf "%s\\n" "$@" > "$PION_FAKE_PM_LOG"\n')
  await chmod(bunPath, 0o755)
  process.env.PI_CODING_AGENT_DIR = fixture.agentDir
  process.env.PATH = fixture.binDir
  process.env.PION_FAKE_PM_LOG = fixture.logPath
  return bunPath
}

const catalogHtml = `<article data-package-card="true" data-package-name="pi-example"
  data-package-path="/packages/pi-example" data-package-types="extension" data-package-downloads="42">
  <p class="packages-desc">Example &amp; tools</p><code>pi install npm:pi-example</code>
</article>`

describe('PluginManager catalog', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('shares the pending body read and caches only the complete catalog', async () => {
    let finish!: () => void
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => {
          controller.enqueue(new TextEncoder().encode(catalogHtml))
          controller.close()
        }
      }
    })
    const fetchMock = vi.fn().mockResolvedValue(new Response(body))
    vi.stubGlobal('fetch', fetchMock)
    const manager = new PluginManager()
    const first = manager.getCatalog()
    expect(manager.getCatalog()).toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    finish()
    const items = await first
    expect(items).toEqual([{
      name: 'pi-example',
      description: 'Example & tools',
      type: 'extension',
      source: 'npm:pi-example',
      packageUrl: 'https://pi.dev/packages/pi-example',
      downloads: 42
    }])
    expect(await manager.getCatalog()).toBe(items)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(['declared', 'streamed'])('bounds %s response bytes and cancels the body', async (kind) => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (kind === 'streamed') {
          controller.enqueue(new Uint8Array(4 * 1024 * 1024))
          controller.enqueue(new Uint8Array(1))
        }
      },
      cancel
    })
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, {
      // A small declared length must still be checked against actual bytes.
      headers: { 'content-length': kind === 'declared' ? String(4 * 1024 * 1024 + 1) : '1' }
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(new PluginManager().getCatalog()).rejects.toThrow('插件目录响应超过 4 MiB')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    catalogHtml.replace('/packages/pi-example', 'javascript:alert(1)'),
    catalogHtml.replace('data-package-name="pi-example"', 'data-package-name=""'),
    catalogHtml.replace('Example &amp; tools', 'x'.repeat(8_193))
  ])('preserves the previous catalog on invalid cards and permits a later retry', async (invalidHtml) => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(catalogHtml))
      .mockResolvedValueOnce(new Response(invalidHtml))
      .mockResolvedValueOnce(new Response(catalogHtml))
    vi.stubGlobal('fetch', fetchMock)
    const manager = new PluginManager()
    const items = await manager.getCatalog()
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)

    await expect(manager.getCatalog()).rejects.toThrow('插件目录包含无效')
    expect(manager).toMatchObject({ catalogCache: { items } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await manager.getCatalog()).toEqual(items)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('aborts a stalled body at 20 seconds, retaining pending until the read settles', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const body = new ReadableStream<Uint8Array>({
      start(controller) { finish = () => controller.error(new Error('body closed')) }
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(body))
      .mockResolvedValueOnce(new Response(catalogHtml))
    vi.stubGlobal('fetch', fetchMock)
    const manager = new PluginManager()
    const pending = manager.getCatalog()
    const rejected = expect(pending).rejects.toThrow('插件目录请求超时（20 秒）')

    await vi.advanceTimersByTimeAsync(20_000)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    // This source has not acknowledged cancellation yet.
    expect(manager.getCatalog()).toBe(pending)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    finish()
    await rejected
    expect(await manager.getCatalog()).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('PluginManager package-manager fallback', () => {
  it('uses bun without persisting a replacement npmCommand', async () => {
    const fixture = await createPackageFixture()
    await installFakeBun(fixture)

    const result = await new PluginManager().uninstall('npm:pi-subagents')

    expect(result.output).toContain('已使用 bun 卸载 npm:pi-subagents')
    const args = await readFile(fixture.logPath, 'utf8')
    expect(args).toContain('uninstall\npi-subagents\n--cwd\n')
    const settings = SettingsManager.create(homedir(), fixture.agentDir)
    expect(settings.getPackages()).toEqual([])
    expect(settings.getNpmCommand()).toBeUndefined()
  })

  it('rejects an uninstall source that is not configured', async () => {
    const fixture = await createPackageFixture()
    await installFakeBun(fixture)
    const settings = SettingsManager.create(homedir(), fixture.agentDir)
    settings.setPackages([])
    await settings.flush()

    await expect(new PluginManager().uninstall('npm:pi-subagents')).rejects.toThrow(
      'No matching package found for npm:pi-subagents'
    )
  })

  it('surfaces settings persistence failures', async () => {
    const fixture = await createPackageFixture()
    const bunCommand = await installFakeBun(fixture)
    const settings = SettingsManager.inMemory({ packages: ['npm:pi-subagents'] })
    vi.spyOn(settings, 'drainErrors').mockReturnValue([{
      scope: 'global',
      error: new Error('read-only settings store')
    }])
    const manager = new PluginManager({
      createSettingsManager: () => settings,
      findExecutable: (command) => command === 'bun' ? bunCommand : null
    })

    await expect(manager.uninstall('npm:pi-subagents')).rejects.toThrow(
      '无法保存 Pi 插件设置：global: read-only settings store'
    )
  })

  it('returns an actionable error when no package manager exists', async () => {
    const fixture = await createPackageFixture()
    process.env.PI_CODING_AGENT_DIR = fixture.agentDir
    process.env.PATH = fixture.binDir

    await expect(new PluginManager().uninstall('npm:pi-subagents')).rejects.toThrow(
      '未找到 npm、bun 或 pnpm'
    )
  })
})
