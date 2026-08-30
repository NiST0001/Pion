import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandChunk, CommandResult, CommandSpec } from '../../src/main/command-runner'
import { CommandRunner } from '../../src/main/command-runner'
import { VerificationService } from '../../src/main/verification'

const roots: string[] = []
const originalPath = process.env.PATH

afterEach(async () => {
  process.env.PATH = originalPath
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
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

async function fixture(): Promise<{ root: string; stateFile: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pion-verification-'))
  roots.push(root)
  const bin = join(root, 'bin')
  await mkdir(bin)
  const npm = join(bin, 'npm')
  await writeFile(npm, '#!/bin/sh\nexit 0\n')
  await chmod(npm, 0o755)
  process.env.PATH = `${bin}:${originalPath ?? ''}`
  await writeFile(join(root, 'package.json'), JSON.stringify({
    scripts: {
      typecheck: 'tsc --noEmit',
      test: 'vitest run',
      build: 'vite build'
    }
  }))
  return { root, stateFile: join(root, 'verification-state.json') }
}

describe('VerificationService', () => {
  it('discovers exact package scripts in deterministic order', async () => {
    const { root, stateFile } = await fixture()
    const service = new VerificationService(stateFile, new FakeRunner([]))
    await service.load()
    const plan = await service.discover(root)

    expect(plan.steps.map((step) => step.kind)).toEqual(['typecheck', 'test', 'build'])
    expect(plan.steps[0]).toMatchObject({ executable: join(root, 'bin/npm'), args: ['run', 'typecheck'] })
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
