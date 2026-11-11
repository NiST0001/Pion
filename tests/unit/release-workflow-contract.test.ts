import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { RELEASE_NOTES } from '../../src/shared/release-notes'

// Source contracts only: the workflows, shell, Git, installers and services never run.
const qualitySource = readFileSync(new URL('../../.github/workflows/quality.yml', import.meta.url), 'utf8')
const releaseSource = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
const packageVersion: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version

interface Step {
  name?: string
  run?: string
  env?: Record<string, string>
  'continue-on-error'?: boolean
}

interface Job {
  uses?: string
  needs?: string | string[]
  if?: string
  permissions?: Record<string, string>
  outputs?: Record<string, string>
  steps?: Step[]
  'runs-on'?: string
  'continue-on-error'?: boolean
}

interface Workflow {
  on: {
    push?: { branches?: string[]; tags?: string[] }
    pull_request?: null
    workflow_call?: { outputs: Record<string, { value: string }> }
  }
  permissions: Record<string, string>
  jobs: Record<string, Job>
}

const quality = parse(qualitySource) as Workflow
const release = parse(releaseSource) as Workflow
const qualityJob = quality.jobs.test!
const windowsJob = quality.jobs.windows!
const gateJob = quality.jobs.gate!
const buildJob = release.jobs.build!
const qualitySteps = qualityJob.steps ?? []
const windowsSteps = windowsJob.steps ?? []
const buildSteps = buildJob.steps ?? []
const admissionStep = buildSteps.find(step => step.name === 'Verify release revision, tag and bundled notes')!
const admissionSource = admissionStep?.run?.match(/^node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE\n?$/)?.[1] ?? ''
const buildCondition = "github.event_name == 'push' && github.ref_type == 'tag' && needs.quality.result == 'success' && needs.quality.outputs.sha == github.sha"
const sha = 'a'.repeat(40)
const validEnv = {
  GITHUB_SHA: sha,
  QUALITY_SHA: sha,
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REF_TYPE: 'tag',
  GITHUB_REF: `refs/tags/v${packageVersion}`,
  GITHUB_REF_NAME: `v${packageVersion}`
}

function runIndex(steps: Step[], command: RegExp): number {
  const index = steps.findIndex(step => command.test(step.run ?? ''))
  expect(index, `Missing command: ${command.source}`).toBeGreaterThanOrEqual(0)
  return index
}

function assertReleaseGate(workflow: Workflow): void {
  assert.deepEqual(workflow.jobs.quality, {
    uses: './.github/workflows/quality.yml',
    permissions: { contents: 'read' }
  })
  // Parse real job properties: matching text in comments or shell scripts provides no dependency.
  assert.equal(workflow.jobs.build?.needs, 'quality')
  assert.equal(workflow.jobs.build?.if, buildCondition)
}

interface AdmissionFixture {
  env?: Partial<typeof validEnv>
  head?: string
  version?: unknown
  notes?: unknown
}

function admit({ env = {}, head = sha, version = packageVersion, notes = RELEASE_NOTES }: AdmissionFixture = {}): void {
  assert.ok(admissionSource, 'Missing admission script')
  // Evaluate only the inline JS with in-memory fixtures, replacing every imported dependency.
  runInNewContext(admissionSource.replace(/^import .+\n/gm, ''), {
    assert,
    process: { env: { ...validEnv, ...env } },
    RELEASE_NOTES: notes,
    readFileSync(path: string, encoding: string) {
      assert.equal(path, 'package.json')
      assert.equal(encoding, 'utf8')
      return JSON.stringify({ version })
    },
    execFileSync(command: string, args: string[], options: { encoding: string }) {
      assert.equal(command, 'git')
      assert.deepEqual(Array.from(args), ['rev-parse', 'HEAD'])
      assert.equal(options.encoding, 'utf8')
      return `${head}\n`
    }
  }, { timeout: 1_000 })
}

describe('same-revision release workflow contracts', () => {
  it('retains push/PR quality defaults and exposes a SHA only after successful quality completion', () => {
    expect(quality.on).toMatchObject({ push: { branches: ['**'] }, pull_request: null })
    expect(quality.on.workflow_call?.outputs.sha?.value).toBe('${{ jobs.gate.outputs.sha }}')
    expect([gateJob.needs].flat().sort()).toEqual(['test', 'windows'])
    expect(gateJob.if).toBeUndefined()
    expect(gateJob['continue-on-error']).toBeUndefined()
    expect(qualityJob['runs-on']).toBe('ubuntu-latest')
    expect(qualityJob.if).toBeUndefined()
    expect(qualityJob['continue-on-error']).toBeUndefined()
    expect(qualitySteps.every(step => step['continue-on-error'] === undefined)).toBe(true)
    const output = gateJob.outputs?.sha
    expect(output).toBe("${{ job.status == 'success' && github.sha || '' }}")
    expect(qualitySource).not.toMatch(/secrets\.|inputs\.|workflow_run|test:e2e|rpc-smoke|test:legacy-ui|gui-cdp-test/)
  })

  it('keeps Windows quality mandatory', () => {
    expect(windowsJob['runs-on']).toBe('windows-latest')
    expect(windowsJob.if).toBeUndefined()
    expect(windowsJob.needs).toBeUndefined()
    expect(windowsJob['continue-on-error']).toBeUndefined()
    expect(windowsSteps.every(step => step['continue-on-error'] === undefined)).toBe(true)
  })

  it('requires the caller-local reusable workflow, a real dependency and matching trigger SHA', () => {
    expect(release.on).toEqual({ push: { tags: ['v*'] } })
    assertReleaseGate(release)
    expect(buildJob['continue-on-error']).toBeUndefined()
    expect(buildSteps.every(step => step['continue-on-error'] === undefined)).toBe(true)
    expect(admissionStep.env).toEqual({ QUALITY_SHA: '${{ needs.quality.outputs.sha }}' })
    expect(releaseSource).not.toMatch(/workflow_run|secrets: inherit|always\(\)|head_sha/)
  })

  it('keeps write permissions/token at the publishing job/step', () => {
    expect(quality.permissions).toEqual({ contents: 'read' })
    expect(release.permissions).toEqual({ contents: 'read' })
    expect(buildJob.permissions).toEqual({ contents: 'write' })
    const install = runIndex(buildSteps, /^npm ci$/)
    const publish = runIndex(buildSteps, /^npx electron-builder\b.*--publish always$/)
    expect(buildSteps.indexOf(admissionStep)).toBeLessThan(install)
    expect(buildSteps[publish]?.env).toEqual({ GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' })
    expect(releaseSource.match(/GH_TOKEN|secrets\.GITHUB_TOKEN/g)).toHaveLength(2)
  })

  it('admits exact tag/package/latest notes', () => {
    expect(() => admit()).not.toThrow()
  })

  it.each<[string, AdmissionFixture]>([
    ['different quality revision', { env: { QUALITY_SHA: 'b'.repeat(40) } }],
    ['missing trigger revision', { env: { GITHUB_SHA: '', QUALITY_SHA: '' }, head: '' }],
    ['different checkout revision', { head: 'b'.repeat(40) }],
    ['non-push event', { env: { GITHUB_EVENT_NAME: 'workflow_dispatch' } }],
    ['branch trigger', { env: { GITHUB_REF_TYPE: 'branch' } }],
    ['tag/version mismatch', { env: { GITHUB_REF: 'refs/tags/v999.0.0' } }],
    ['missing package version', { version: '' }],
    ['missing release notes', { notes: [] }],
    ['old release notes', { notes: [{ version: 'old', changes: ['change'] }] }],
    ['empty release notes', { notes: [{ version: packageVersion, changes: [] }] }]
  ])('rejects %s before package installation/build/publishing', (_name, fixture) => {
    expect(() => admit(fixture)).toThrow()
  })
})
