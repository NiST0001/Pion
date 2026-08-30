import type { BrowserWindow } from 'electron'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { IPC_EVENTS } from '../shared/ipc'
import type {
  RunOperation,
  StartVerificationOptions,
  VerificationCommand,
  VerificationKind,
  VerificationLogUpdate,
  VerificationPlan,
  VerificationPolicy,
  VerificationRun,
  VerificationSnapshotUpdate,
  VerificationStepResult
} from '../shared/operations'
import { CommandRunner } from './command-runner'

interface VerificationFile {
  version: 1
  policies: Record<string, VerificationPolicy>
  runs: VerificationRun[]
}

const RUN_CHANNEL = IPC_EVENTS.VerificationRuns
const LOG_CHANNEL = IPC_EVENTS.VerificationLog
const KINDS: VerificationKind[] = ['typecheck', 'lint', 'test', 'build']
const MAX_RUNS = 60
const MAX_STEP_OUTPUT = 16_000
const DEFAULT_POLICY = {
  autoRun: false,
  autoRepair: false,
  maxRepairAttempts: 2,
  selectedKinds: [...KINDS]
} satisfies Omit<VerificationPolicy, 'cwd'>

function cloneRun(run: VerificationRun): VerificationRun {
  return structuredClone(run)
}

function cleanOutput(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
}

function stepTimeout(kind: VerificationKind): number {
  return kind === 'test' || kind === 'build' ? 10 * 60_000 : 5 * 60_000
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function findExecutable(names: string[]): Promise<string | null> {
  const paths = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const suffixes = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : ['']
  for (const name of names) {
    if (name.includes('/') || name.includes('\\')) {
      try {
        await access(name, fsConstants.X_OK)
        return name
      } catch {
        continue
      }
    }
    for (const directory of paths) {
      for (const suffix of suffixes) {
        const candidate = join(directory, process.platform === 'win32' ? `${name}${suffix}` : name)
        try {
          await access(candidate, fsConstants.X_OK)
          return candidate
        } catch {
          // Try the next PATH entry.
        }
      }
    }
  }
  return null
}

function normalizePolicy(cwd: string, value?: Partial<VerificationPolicy>): VerificationPolicy {
  const selectedKinds = Array.isArray(value?.selectedKinds)
    ? value.selectedKinds.filter((kind): kind is VerificationKind => KINDS.includes(kind as VerificationKind))
    : [...KINDS]
  return {
    cwd: resolve(cwd),
    autoRun: value?.autoRun === true,
    autoRepair: value?.autoRepair === true,
    maxRepairAttempts: Math.max(0, Math.min(3, Math.round(value?.maxRepairAttempts ?? 2))),
    selectedKinds: selectedKinds.length > 0 ? selectedKinds : [...KINDS]
  }
}

function normalizeRun(value: unknown): VerificationRun | null {
  if (!value || typeof value !== 'object') return null
  const run = value as Partial<VerificationRun>
  if (typeof run.id !== 'string' || typeof run.cwd !== 'string' || typeof run.createdAt !== 'number') {
    return null
  }
  const state = run.state === 'queued' || run.state === 'running' ? 'interrupted' : run.state
  if (!state || !Array.isArray(run.steps)) return null
  return {
    id: run.id,
    cwd: resolve(run.cwd),
    sessionPath: run.sessionPath ? resolve(run.sessionPath) : undefined,
    sourceRunId: run.sourceRunId,
    state,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: state === 'interrupted' ? Date.now() : run.finishedAt,
    currentStepId: state === 'interrupted' ? undefined : run.currentStepId,
    steps: run.steps.map((step) => ({
      ...step,
      state: step.state === 'running' ? 'infrastructure-error' : step.state,
      outputTail: typeof step.outputTail === 'string' ? step.outputTail : '',
      outputTruncated: step.outputTruncated === true
    })),
    selectedKinds: Array.isArray(run.selectedKinds) ? run.selectedKinds : [],
    repairAttempt: typeof run.repairAttempt === 'number' ? run.repairAttempt : 0,
    repairPrompt: run.repairPrompt,
    error: state === 'interrupted'
      ? 'Pion 在验证完成前退出；可以重新运行验证。'
      : run.error,
    revision: typeof run.revision === 'number' ? run.revision + (state === 'interrupted' ? 1 : 0) : 0
  }
}

export class VerificationService {
  private readonly runner: CommandRunner
  private readonly runs = new Map<string, VerificationRun>()
  private readonly policies = new Map<string, VerificationPolicy>()
  private readonly activeByCwd = new Map<string, string>()
  private readonly planCache = new Map<string, VerificationPlan>()
  private readonly autoRepairAgentAttempts = new Map<string, number>()
  private autoRepairHandler?: (run: VerificationRun, prompt: string) => Promise<RunOperation | null>
  private win: BrowserWindow | null = null
  private loaded = false
  private logSequence = 0
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(readonly filePath: string, runner = new CommandRunner()) {
    this.filePath = resolve(filePath)
    this.runner = runner
  }

  bind(win: BrowserWindow): void {
    this.win = win
  }

  unbind(win: BrowserWindow): void {
    if (this.win === win) this.win = null
  }

  setAutoRepairHandler(
    handler: (run: VerificationRun, prompt: string) => Promise<RunOperation | null>
  ): void {
    this.autoRepairHandler = handler
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<VerificationFile>
      for (const [cwd, policy] of Object.entries(parsed.policies ?? {})) {
        this.policies.set(resolve(cwd), normalizePolicy(cwd, policy))
      }
      for (const value of parsed.runs ?? []) {
        const run = normalizeRun(value)
        if (run) this.runs.set(run.id, run)
      }
      await this.flush()
    } catch {
      // Missing or malformed state starts empty.
    }
  }

  async discover(cwd: string, force = false): Promise<VerificationPlan> {
    const root = resolve(cwd)
    const cached = this.planCache.get(root)
    if (!force && cached && Date.now() - cached.discoveredAt < 30_000) return structuredClone(cached)

    const steps: VerificationCommand[] = []
    const warnings: string[] = []
    let packageManager: string | undefined
    const packageFile = join(root, 'package.json')
    if (await exists(packageFile)) {
      try {
        const manifest = JSON.parse(await readFile(packageFile, 'utf8')) as {
          scripts?: Record<string, unknown>
          packageManager?: string
        }
        const requested = manifest.packageManager?.split('@')[0]
        const preferred = requested
          ? [requested]
          : await exists(join(root, 'pnpm-lock.yaml'))
            ? ['pnpm', 'npm', 'yarn', 'bun']
            : await exists(join(root, 'yarn.lock'))
              ? ['yarn', 'npm', 'pnpm', 'bun']
              : await exists(join(root, 'bun.lockb')) || await exists(join(root, 'bun.lock'))
                ? ['bun', 'npm', 'pnpm', 'yarn']
                : ['npm', 'pnpm', 'yarn', 'bun']
        const executable = await findExecutable(preferred)
        if (executable) {
          packageManager = preferred.find((name) => executable.endsWith(name) || executable.endsWith(`${name}.cmd`))
            ?? requested
            ?? 'package-manager'
          for (const kind of KINDS) {
            if (typeof manifest.scripts?.[kind] !== 'string') continue
            steps.push({
              id: `package:${kind}`,
              kind,
              label: kind,
              executable,
              args: ['run', kind],
              cwd: root,
              source: `package.json#scripts.${kind}`,
              timeoutMs: stepTimeout(kind)
            })
          }
        } else {
          warnings.push('发现 package.json，但 PATH 中没有可用的 npm / pnpm / yarn / bun。')
        }
      } catch (error) {
        warnings.push(`无法读取 package.json：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (await exists(join(root, 'go.mod'))) {
      const go = await findExecutable(['go'])
      if (go) {
        if (!steps.some((step) => step.kind === 'lint')) steps.push({
          id: 'go:vet', kind: 'lint', label: 'go vet', executable: go,
          args: ['vet', './...'], cwd: root, source: 'go.mod', timeoutMs: stepTimeout('lint')
        })
        if (!steps.some((step) => step.kind === 'test')) steps.push({
          id: 'go:test', kind: 'test', label: 'go test', executable: go,
          args: ['test', './...'], cwd: root, source: 'go.mod', timeoutMs: stepTimeout('test')
        })
        if (!steps.some((step) => step.kind === 'build')) steps.push({
          id: 'go:build', kind: 'build', label: 'go build', executable: go,
          args: ['build', './...'], cwd: root, source: 'go.mod', timeoutMs: stepTimeout('build')
        })
      }
    }

    if (await exists(join(root, 'Cargo.toml'))) {
      const cargo = await findExecutable(['cargo'])
      if (cargo) {
        if (!steps.some((step) => step.kind === 'typecheck')) steps.push({
          id: 'cargo:check', kind: 'typecheck', label: 'cargo check', executable: cargo,
          args: ['check', '--all-targets'], cwd: root, source: 'Cargo.toml', timeoutMs: stepTimeout('typecheck')
        })
        if (!steps.some((step) => step.kind === 'test')) steps.push({
          id: 'cargo:test', kind: 'test', label: 'cargo test', executable: cargo,
          args: ['test'], cwd: root, source: 'Cargo.toml', timeoutMs: stepTimeout('test')
        })
        if (!steps.some((step) => step.kind === 'build')) steps.push({
          id: 'cargo:build', kind: 'build', label: 'cargo build', executable: cargo,
          args: ['build'], cwd: root, source: 'Cargo.toml', timeoutMs: stepTimeout('build')
        })
      }
    }

    steps.sort((left, right) => KINDS.indexOf(left.kind) - KINDS.indexOf(right.kind))
    const plan = { cwd: root, discoveredAt: Date.now(), packageManager, steps, warnings }
    this.planCache.set(root, plan)
    return structuredClone(plan)
  }

  getPolicy(cwd: string): VerificationPolicy {
    const root = resolve(cwd)
    return structuredClone(this.policies.get(root) ?? normalizePolicy(root, DEFAULT_POLICY))
  }

  async setPolicy(cwd: string, updates: Partial<Omit<VerificationPolicy, 'cwd'>>): Promise<VerificationPolicy> {
    const root = resolve(cwd)
    const policy = normalizePolicy(root, { ...this.getPolicy(root), ...updates })
    this.policies.set(root, policy)
    await this.flush()
    return structuredClone(policy)
  }

  listRuns(cwd?: string, sessionPath?: string): VerificationRun[] {
    const root = cwd ? resolve(cwd) : undefined
    const session = sessionPath ? resolve(sessionPath) : undefined
    return [...this.runs.values()]
      .filter((run) => !root || run.cwd === root)
      .filter((run) => !session || run.sessionPath === session)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 30)
      .map(cloneRun)
  }

  async start(cwd: string, options: StartVerificationOptions = {}): Promise<VerificationRun> {
    const root = resolve(cwd)
    const activeId = this.activeByCwd.get(root)
    if (activeId) {
      const active = this.runs.get(activeId)
      if (active && (active.state === 'queued' || active.state === 'running')) return cloneRun(active)
    }
    const plan = await this.discover(root, true)
    const policy = this.getPolicy(root)
    const selectedKinds = options.kinds?.length ? options.kinds : policy.selectedKinds
    const selected = plan.steps.filter((step) => selectedKinds.includes(step.kind))
    if (selected.length === 0) throw new Error('项目中没有发现可运行的验证命令')

    const run: VerificationRun = {
      id: randomUUID(),
      cwd: root,
      sessionPath: options.sessionPath ? resolve(options.sessionPath) : undefined,
      sourceRunId: options.sourceRunId,
      state: 'queued',
      createdAt: Date.now(),
      steps: selected.map((step): VerificationStepResult => ({
        ...step,
        state: 'queued',
        outputTail: '',
        outputTruncated: false
      })),
      selectedKinds: [...new Set(selected.map((step) => step.kind))],
      repairAttempt: Math.max(0, options.repairAttempt ?? 0),
      revision: 0
    }
    this.runs.set(run.id, run)
    this.activeByCwd.set(root, run.id)
    this.trimRuns()
    this.changed(run)
    void this.execute(run.id)
    return cloneRun(run)
  }

  async rerun(runId: string): Promise<VerificationRun> {
    const source = this.runs.get(runId)
    if (!source) throw new Error('验证记录不存在')
    return this.start(source.cwd, {
      kinds: source.selectedKinds,
      sessionPath: source.sessionPath,
      sourceRunId: source.sourceRunId,
      repairAttempt: source.repairAttempt
    })
  }

  async cancel(runId: string): Promise<VerificationRun> {
    const run = this.runs.get(runId)
    if (!run) throw new Error('验证记录不存在')
    if (run.state !== 'queued' && run.state !== 'running') return cloneRun(run)
    run.state = 'cancelled'
    run.finishedAt = Date.now()
    run.revision += 1
    const current = run.currentStepId
    if (current) await this.runner.cancel(`${run.id}:${current}`)
    this.activeByCwd.delete(run.cwd)
    this.changed(run)
    return cloneRun(run)
  }

  async handleAgentRunCompleted(run: RunOperation): Promise<void> {
    const policy = this.getPolicy(run.cwd)
    if (!policy.autoRun || run.state !== 'completed') return
    const repairAttempt = this.autoRepairAgentAttempts.get(run.id) ?? 0
    this.autoRepairAgentAttempts.delete(run.id)
    try {
      await this.start(run.cwd, {
        kinds: policy.selectedKinds,
        sessionPath: run.sessionPath,
        sourceRunId: run.id,
        repairAttempt
      })
    } catch (error) {
      console.error('[pion] automatic verification could not start:', error)
    }
  }

  private async execute(runId: string): Promise<void> {
    const run = this.runs.get(runId)
    if (!run || run.state !== 'queued') return
    run.state = 'running'
    run.startedAt = Date.now()
    run.revision += 1
    this.changed(run)

    for (const step of run.steps) {
      if (run.state !== 'running') break
      step.state = 'running'
      step.startedAt = Date.now()
      run.currentStepId = step.id
      run.revision += 1
      this.changed(run)
      const result = await this.runner.run(`${run.id}:${step.id}`, step, (chunk) => {
        const text = cleanOutput(chunk.text)
        if (!text) return
        const combined = `${step.outputTail}${text}`
        step.outputTruncated ||= combined.length > MAX_STEP_OUTPUT
        step.outputTail = combined.slice(-MAX_STEP_OUTPUT)
        const update: VerificationLogUpdate = {
          runId: run.id,
          stepId: step.id,
          sequence: ++this.logSequence,
          stream: chunk.stream,
          text
        }
        this.win?.webContents.send(LOG_CHANNEL, update)
      })
      step.finishedAt = Date.now()
      step.durationMs = result.durationMs
      step.exitCode = result.exitCode
      step.signal = result.signal
      if (result.cancelled || this.runs.get(runId)?.state === 'cancelled') {
        step.state = 'cancelled'
        run.state = 'cancelled'
        break
      }
      if (result.spawnError || result.timedOut) {
        step.state = 'infrastructure-error'
        step.error = result.spawnError ?? `超过 ${Math.round(step.timeoutMs / 1000)} 秒超时`
        run.state = 'infrastructure-error'
        run.error = step.error
        break
      }
      if (result.exitCode !== 0) {
        step.state = 'failed'
        run.state = 'failed'
        break
      }
      step.state = 'passed'
      run.revision += 1
      this.changed(run)
    }

    if (run.state === 'running') run.state = 'passed'
    run.finishedAt = Date.now()
    run.currentStepId = undefined
    if (run.state === 'failed') run.repairPrompt = this.buildRepairPrompt(run)
    run.revision += 1
    this.activeByCwd.delete(run.cwd)
    this.changed(run)
    await this.flush()

    const policy = this.getPolicy(run.cwd)
    if (
      run.state === 'failed'
      && policy.autoRepair
      && run.repairAttempt < policy.maxRepairAttempts
      && run.repairPrompt
      && this.autoRepairHandler
    ) {
      try {
        const agentRun = await this.autoRepairHandler(cloneRun(run), run.repairPrompt)
        if (agentRun) this.autoRepairAgentAttempts.set(agentRun.id, run.repairAttempt + 1)
      } catch (error) {
        console.error('[pion] automatic verification repair could not start:', error)
      }
    }
  }

  private buildRepairPrompt(run: VerificationRun): string {
    const failed = run.steps.find((step) => step.state === 'failed')
    const diagnostics = failed?.outputTail.slice(-8_000) ?? '没有捕获到命令输出。'
    return [
      '自动验证失败，请修复实现并重新运行相关验证。',
      failed ? `失败步骤：${failed.label}（${failed.executable} ${failed.args.join(' ')}）` : '验证步骤失败。',
      '不要删除、跳过或弱化现有测试来掩盖失败；先定位根因，完成最小修复。',
      '验证输出：',
      '```text',
      diagnostics,
      '```'
    ].join('\n\n')
  }

  private changed(run: VerificationRun): void {
    const update: VerificationSnapshotUpdate = { runs: [cloneRun(run)] }
    this.win?.webContents.send(RUN_CHANNEL, update)
    this.scheduleWrite()
  }

  private trimRuns(): void {
    const sorted = [...this.runs.values()].sort((left, right) => left.createdAt - right.createdAt)
    while (sorted.length > MAX_RUNS) {
      const victim = sorted.shift()
      if (victim && victim.state !== 'running' && victim.state !== 'queued') this.runs.delete(victim.id)
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      void this.flush()
    }, 250)
  }

  flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    const target = this.filePath
    const temp = `${target}.${randomUUID()}.tmp`
    const payload: VerificationFile = {
      version: 1,
      policies: Object.fromEntries(this.policies),
      runs: [...this.runs.values()].sort((left, right) => left.createdAt - right.createdAt)
    }
    const serialized = `${JSON.stringify(payload, null, 2)}\n`
    const write = this.writeQueue.then(async () => {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(temp, serialized, 'utf8')
      await rename(temp, target)
    })
    this.writeQueue = write.catch((error) => {
      console.error('[pion] failed to persist verification state:', error)
    })
    return write
  }
}
