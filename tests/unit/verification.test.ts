import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandChunk, CommandResult, CommandSpec } from '../../src/main/command-runner'
import { CommandRunner } from '../../src/main/command-runner'
import { VerificationService } from '../../src/main/verification'

const roots: string[] = []
const originalPath = process.env.PATH

afterEach(async () => {
  process.env.PATH = originalPath
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  })))
})

class FakeRunner extends CommandRunner {
  constructor(private readonly exitCodes: number[]) {
    super()
  }

  override async run(
    _id: string,
    _spec: CommandSpec,
    onChunk: (chunk: CommandChunk) => void
  ): Promise<CommandResult> {
    const exitCode = this.exitCodes.shift() ?? 0
    onChunk({ stream: exitCode === 0 ? 'stdout' : 'stderr', text: exitCode === 0 ? 'ok\n' : 'type error\n' })
    return { exitCode, durationMs: 5, cancelled: false, timedOut: false }
  }
}

async function fixture(): Promise<{ root: string; stateFile: string; npmName: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pion-verification-'))
  roots.push(root)
  const bin = join(root, 'bin')
  await mkdir(bin)
  // Windows 按 PATHEXT 查找 npm.CMD/.EXE，POSIX 直接查找无扩展名的 npm
  const npmName = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const npm = join(bin, npmName)
  await writeFile(npm, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n')
  if (process.platform !== 'win32') await chmod(npm, 0o755)
  // PATH 必须用平台各自的分隔符拼接（POSIX 是 ':'，Windows 是 ';'）
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`
  await writeFile(join(root, 'package.json'), JSON.stringify({
    scripts: {
      typecheck: 'tsc --noEmit',
      test: 'vitest run',
      build: 'vite build'
    }
  }))
  return { root, stateFile: join(root, 'verification-state.json'), npmName }
}

describe('VerificationService', () => {
  it('discovers exact package scripts in deterministic order', async () => {
    const { root, stateFile, npmName } = await fixture()
    const service = new VerificationService(stateFile, new FakeRunner([]))
    await service.load()
    const plan = await service.discover(root)

    expect(plan.steps.map((step) => step.kind)).toEqual(['typecheck', 'test', 'build'])
    expect(plan.steps[0]).toMatchObject({ args: ['run', 'typecheck'] })
    // Windows 的 PATHEXT 后缀大小写（npm.CMD）与写入的文件名可能不一致，忽略大小写比较
    expect(plan.steps[0].executable.toLowerCase()).toBe(join(root, 'bin', npmName).toLowerCase())
  })

  it('runs steps sequentially and produces bounded repair feedback', async () => {
    const { root, stateFile } = await fixture()
    const service = new VerificationService(stateFile, new FakeRunner([0, 1]))
    await service.load()
    const started = await service.start(root)

    await vi.waitFor(() => {
      expect(service.listRuns(root)[0].state).toBe('failed')
    })
    const run = service.listRuns(root)[0]
    expect(run.id).toBe(started.id)
    expect(run.steps.map((step) => step.state)).toEqual(['passed', 'failed', 'queued'])
    expect(run.repairPrompt).toContain('type error')
    expect(run.repairPrompt).toContain('不要删除、跳过或弱化现有测试')
  })

  it('persists explicit automatic verification policy', async () => {
    const { root, stateFile } = await fixture()
    const service = new VerificationService(stateFile, new FakeRunner([]))
    await service.load()
    const policy = await service.setPolicy(root, {
      autoRun: true,
      autoRepair: true,
      selectedKinds: ['typecheck', 'test']
    })

    expect(policy).toMatchObject({ autoRun: true, autoRepair: true, maxRepairAttempts: 2 })
    const reloaded = new VerificationService(stateFile, new FakeRunner([]))
    await reloaded.load()
    expect(reloaded.getPolicy(root).selectedKinds).toEqual(['typecheck', 'test'])
  })
})
