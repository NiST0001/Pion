import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { RELEASE_NOTES } from '../../src/shared/release-notes'

// Source contracts only: the workflows, shell, Git, installers and services never run.
const qualitySource = readFileSync(new URL('../../.github/workflows/quality.yml', import.meta.url), 'utf8')
const releaseSource = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
const notesSource = readFileSync(new URL('../../src/shared/release-notes.ts', import.meta.url), 'utf8')
const packageVersion: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version

interface Step {
  name?: string
  uses?: string
  if?: string
  run?: string
  shell?: string
  with?: Record<string, unknown>
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
  strategy?: { 'fail-fast': boolean; matrix: { os: string[] } }
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

function expression(source: string, context: Record<string, unknown>): unknown {
  return runInNewContext(source.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), context, { timeout: 1_000 })
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
    expect(Object.keys(quality.jobs)).toEqual(['test', 'windows', 'gate'])
    expect(quality.on.workflow_call?.outputs.sha?.value).toBe('${{ jobs.gate.outputs.sha }}')
    expect(gateJob.needs).toEqual(['test', 'windows'])
    expect(gateJob.if).toBeUndefined()
    expect(gateJob['continue-on-error']).toBeUndefined()
    expect(qualityJob['runs-on']).toBe('ubuntu-latest')
    expect(qualityJob.if).toBeUndefined()
    expect(qualityJob['continue-on-error']).toBeUndefined()
    expect(qualitySteps.every(step => step['continue-on-error'] === undefined)).toBe(true)
    expect(qualitySteps.flatMap(step => step.run ? [step.run] : [])).toEqual([
      'npm ci', 'npm run typecheck', 'npm test', 'npm run test:coverage',
      'npm run build', 'xvfb-run -a ./node_modules/.bin/playwright test'
    ])
    const output = gateJob.outputs?.sha
    expect(output).toBe("${{ job.status == 'success' && github.sha || '' }}")
    for (const status of ['success', 'failure', 'cancelled', 'skipped']) {
      expect(expression(output!, { job: { status }, github: { sha } })).toBe(status === 'success' ? sha : '')
    }
    expect(qualitySteps.filter(step => step.if)).toEqual([{
      name: 'Upload test artifacts', if: 'failure()', uses: 'actions/upload-artifact@v4',
      with: { name: 'playwright-results', path: 'playwright-report/\ntest-results/\n', 'if-no-files-found': 'ignore' }
    }])
    expect(qualitySource).not.toMatch(/secrets\.|inputs\.|workflow_run|test:e2e|rpc-smoke|test:legacy-ui|gui-cdp-test/)
  })

  it('runs full Windows checks on push, PR and reusable quality and fails closed', () => {
    expect(windowsJob['runs-on']).toBe('windows-latest')
    expect(windowsJob.if).toBeUndefined()
    expect(windowsJob.needs).toBeUndefined()
    expect(windowsJob['continue-on-error']).toBeUndefined()
    expect(windowsSteps.every(step => step['continue-on-error'] === undefined)).toBe(true)
    expect(windowsSteps.flatMap(step => step.run ? [step.run] : [])).toEqual([
      'npm ci', 'npm run typecheck',
      'npm test -- --reporter=default --reporter=json --reporter=./scripts/vitest-failure-reporter.mjs --outputFile.json=vitest-windows.json',
      'node scripts/report-vitest-failures.mjs vitest-windows.json vitest-windows-failures.json'
    ])
    expect(windowsSteps.filter(step => step.if)).toEqual([
      { name: 'Publish Windows failure summary', if: 'always()', env: { TEST_OUTCOME: '${{ steps.tests.outcome }}' }, run: 'node scripts/report-vitest-failures.mjs vitest-windows.json vitest-windows-failures.json' },
      { name: 'Upload Windows test report', if: 'always()', uses: 'actions/upload-artifact@v4', with: { name: 'vitest-windows-report', path: 'vitest-windows.json\nvitest-windows-failures.json\n', 'if-no-files-found': 'ignore' } }
    ])
    expect(windowsSteps.find(step => step.name === 'Windows full test suite')).toMatchObject({ id: 'tests' })
    // Model the implicit success() on the aggregate and reusable workflow.
    for (const linux of ['success', 'failure', 'cancelled', 'skipped']) {
      for (const windows of ['success', 'failure', 'cancelled', 'skipped']) {
        const result = linux === 'success' && windows === 'success' ? 'success' : 'failure'
        const admitted = expression(buildCondition, { github: { event_name: 'push', ref_type: 'tag', sha }, needs: { quality: { result, outputs: { sha } } } })
        expect(Boolean(admitted)).toBe(linux === 'success' && windows === 'success')
      }
    }
  })

  it('requires the caller-local reusable workflow, a real dependency and matching trigger SHA', () => {
    expect(release.on).toEqual({ push: { tags: ['v*'] } })
    expect(Object.keys(release.jobs)).toEqual(['quality', 'build'])
    assertReleaseGate(release)
    expect(buildJob['continue-on-error']).toBeUndefined()
    expect(buildSteps.every(step => step['continue-on-error'] === undefined)).toBe(true)
    expect(buildJob.strategy).toEqual({ 'fail-fast': false, matrix: { os: ['windows-latest', 'ubuntu-latest'] } })
    expect(buildJob['runs-on']).toBe('${{ matrix.os }}')
    expect(admissionStep.env).toEqual({ QUALITY_SHA: '${{ needs.quality.outputs.sha }}' })
    // This source-level model covers the documented implicit success() boundary, not GitHub execution.
    expect(buildJob.if).not.toMatch(/\b(?:always|success|failure|cancelled)\s*\(/)
    for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
      for (const checkedSha of [sha, '', 'b'.repeat(40)]) {
        const needs = { quality: { result, outputs: { sha: checkedSha } } }
        const dependencies = [buildJob.needs].flat() as string[]
        const succeeded = dependencies.every(id => needs[id as 'quality']?.result === 'success')
        const admitted = succeeded && Boolean(expression(buildJob.if!, {
          github: { event_name: 'push', ref_type: 'tag', sha }, needs
        }))
        expect(admitted).toBe(result === 'success' && checkedSha === sha)
      }
    }
    expect(releaseSource).not.toMatch(/workflow_run|secrets: inherit|always\(\)|head_sha/)
  })

  it('rejects disconnected jobs even when comments preserve the expected needs/if text', () => {
    for (const line of ['    needs: quality', `    if: ${buildCondition}`]) {
      const disconnected = parse(releaseSource.replace(line, line.replace('    ', '    # '))) as Workflow
      expect(() => assertReleaseGate(disconnected)).toThrow()
    }
  })

  it('fixes both checkouts and keeps write permissions/token at the publishing job/step', () => {
    expect(quality.permissions).toEqual({ contents: 'read' })
    expect(release.permissions).toEqual({ contents: 'read' })
    expect(buildJob.permissions).toEqual({ contents: 'write' })
    for (const steps of [qualitySteps, windowsSteps, buildSteps]) {
      expect(steps[0]).toEqual({
        uses: 'actions/checkout@v4', with: { ref: '${{ github.sha }}', 'persist-credentials': false }
      })
      expect(steps[1]).toEqual({ uses: 'actions/setup-node@v4', with: { 'node-version': 24, cache: 'npm' } })
    }
    expect(buildSteps.map(step => step.run ? step.run.split('\n')[0] : step.uses)).toEqual([
      'actions/checkout@v4', 'actions/setup-node@v4', "node --input-type=module <<'NODE'",
      'npm ci', 'npm run build', 'npx electron-builder --publish always'
    ])
    expect(buildSteps.filter(step => step.if)).toEqual([])
    expect(buildSteps.at(-1)?.env).toEqual({ GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' })
    expect(releaseSource.match(/GH_TOKEN|secrets\.GITHUB_TOKEN/g)).toHaveLength(2)
    expect([...qualitySteps, ...windowsSteps, ...buildSteps].flatMap(step => step.uses ? [step.uses] : [])).toEqual([
      'actions/checkout@v4', 'actions/setup-node@v4', 'actions/upload-artifact@v4',
      'actions/checkout@v4', 'actions/setup-node@v4', 'actions/upload-artifact@v4',
      'actions/checkout@v4', 'actions/setup-node@v4'
    ])
    expect(JSON.stringify(buildJob)).not.toMatch(/playwright|test:e2e|Portal|pion_generate_image|rpc-smoke|gui-cdp-test/)
  })

  it('admits exact tag/package/latest notes before installation using native Node TS strip', () => {
    expect(admissionStep.shell).toBe('bash')
    expect(admissionSource.match(/^import .+$/gm)).toEqual([
      "import assert from 'node:assert/strict'",
      "import { execFileSync } from 'node:child_process'",
      "import { readFileSync } from 'node:fs'",
      "import { RELEASE_NOTES } from './src/shared/release-notes.ts'"
    ])
    const stripped = stripTypeScriptTypes(notesSource, { mode: 'strip' })
    const nativeNotes = runInNewContext(`${stripped.replace(/^export /gm, '')}\nRELEASE_NOTES`, {}, { timeout: 1_000 })
    expect(nativeNotes).toEqual(RELEASE_NOTES)
    expect(() => admit()).not.toThrow()
  })

  it.each<[string, AdmissionFixture]>([
    ['different quality revision', { env: { QUALITY_SHA: 'b'.repeat(40) } }],
    ['missing quality revision', { env: { QUALITY_SHA: '' } }],
    ['missing trigger revision', { env: { GITHUB_SHA: '', QUALITY_SHA: '' }, head: '' }],
    ['different checkout revision', { head: 'b'.repeat(40) }],
    ['non-push event', { env: { GITHUB_EVENT_NAME: 'workflow_dispatch' } }],
    ['branch trigger', { env: { GITHUB_REF_TYPE: 'branch' } }],
    ['tag/version mismatch', { env: { GITHUB_REF: 'refs/tags/v999.0.0' } }],
    ['tag-name mismatch', { env: { GITHUB_REF_NAME: 'v999.0.0' } }],
    ['missing package version', { version: '' }],
    ['invalid package version type', { version: 1 }],
    ['missing release notes', { notes: [] }],
    ['old release notes', { notes: [{ version: 'old', changes: ['change'] }] }],
    ['empty release notes', { notes: [{ version: packageVersion, changes: [] }] }],
    ['blank release notes', { notes: [{ version: packageVersion, changes: ['  '] }] }],
    ['invalid release notes', { notes: [{ version: packageVersion, changes: [1] }] }]
  ])('rejects %s before package installation/build/publishing', (_name, fixture) => {
    expect(() => admit(fixture)).toThrow()
  })
})
