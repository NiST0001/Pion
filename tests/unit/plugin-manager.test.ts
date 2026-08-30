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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
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

async function installFakeBun(fixture: Awaited<ReturnType<typeof createPackageFixture>>): Promise<void> {
  const bunPath = join(fixture.binDir, 'bun')
  await writeFile(bunPath, '#!/bin/sh\nprintf "%s\\n" "$@" > "$PION_FAKE_PM_LOG"\n')
  await chmod(bunPath, 0o755)
  process.env.PI_CODING_AGENT_DIR = fixture.agentDir
  process.env.PATH = fixture.binDir
  process.env.PION_FAKE_PM_LOG = fixture.logPath
}

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
    await installFakeBun(fixture)
    const settings = SettingsManager.inMemory({ packages: ['npm:pi-subagents'] })
    vi.spyOn(settings, 'drainErrors').mockReturnValue([{
      scope: 'global',
      error: new Error('read-only settings store')
    }])
    const manager = new PluginManager({
      createSettingsManager: () => settings,
      findExecutable: (command) => command === 'bun' ? join(fixture.binDir, 'bun') : null
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
