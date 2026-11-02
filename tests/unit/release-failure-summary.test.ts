import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../../scripts/report-vitest-failures.mjs', import.meta.url))
const reporterUrl = new URL('../../scripts/vitest-failure-reporter.mjs', import.meta.url).href
const test = (fullName: string, message: string) => ({ fullName, status: 'failed', failureMessages: [message] })
const report = {
  success: false, numFailedTests: 2, numFailedTestSuites: 2, numTotalTests: 2,
  testResults: [
    { name: 'a<file>.test.ts', status: 'failed', message: '', assertionResults: [test('one & <script>', 'first <error>')] },
    { name: 'b.test.ts', status: 'failed', message: 'file setup failed', assertionResults: [test('two', 'x'.repeat(1600))] }
  ]
}

function run(input: string | undefined, outcome = 'failure', details: string | null = JSON.stringify({ version: 1, failures: [] })) {
  const dir = mkdtempSync(join(tmpdir(), 'pion-summary-'))
  try {
    const path = join(dir, 'report.json')
    const summary = join(dir, 'summary.md')
    const detailsPath = join(dir, 'details.json')
    if (input !== undefined) writeFileSync(path, input)
    if (details !== null) writeFileSync(detailsPath, details)
    const result = spawnSync(process.execPath, [script, path, detailsPath], {
      encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary, TEST_OUTCOME: outcome }
    })
    return { status: result.status, summary: readFileSync(summary, 'utf8'), stderr: result.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('Windows Vitest public failure summary', () => {
  it('enumerates every failed file and test, escapes HTML and marks clipped diagnostics', () => {
    const result = run(JSON.stringify(report))
    expect(result.status).toBe(1)
    expect(result.summary).toContain('a&lt;file&gt;.test.ts')
    expect(result.summary).toContain('one &amp; &lt;script&gt;')
    expect(result.summary).toContain('first &lt;error&gt;')
    expect(result.summary).toContain('b.test.ts')
    expect(result.summary).toContain('file setup failed')
    expect(result.summary).toContain('<strong>two</strong>')
    expect(result.summary).toContain('Diagnostic truncated')
    expect(result.summary).not.toContain('x'.repeat(1501))
  })

  it('fails closed for missing, malformed, inconsistent and unknown results', () => {
    for (const input of [undefined, '{', '{}', JSON.stringify({ ...report, numFailedTests: 1 }),
      JSON.stringify({ ...report, testResults: [{ ...report.testResults[0], status: 'unknown' }] })]) {
      const result = run(input)
      expect(result.status).toBe(1)
      expect(result.summary).toContain('unavailable or invalid')
    }
  })

  it('fails closed on pending cases even when Vitest and the test step report success', () => {
    const pending = { success: true, numFailedTests: 0, numFailedTestSuites: 0, numTotalTests: 1,
      testResults: [{ name: 'pending.test.ts', status: 'passed', message: '', assertionResults: [{ fullName: 'suite waiting', status: 'pending', failureMessages: [] }] }] }
    const result = run(JSON.stringify(pending), 'success')
    expect(result.status).toBe(1)
    expect(result.summary).toContain('Pending: <strong>suite waiting</strong>')
  })

  it('reports every nested suite, file and unhandled error from the task reporter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pion-reporter-'))
    try {
      const source = `import Reporter from ${JSON.stringify(reporterUrl)};
        await new Reporter().onTestRunEnd([{task: {type:'suite', name:'file', filepath:'a.test.ts', result:{state:'fail', errors:[{message:'file one'}, {message:'file two'}]}, tasks:[
          {type:'suite', name:'outer', result:{state:'fail', errors:[{message:'outer error'}]}, tasks:[
            {type:'suite', name:'inner', result:{state:'fail', errors:[{message:'inner error'}]}, tasks:[]}
          ]}
        ]}}], [{name:'UnhandledOne', message:'global one'}, {name:'UnhandledTwo', message:'global two'}]);`
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: dir, encoding: 'utf8' })
      expect(child.status).toBe(0)
      const details = readFileSync(join(dir, 'vitest-windows-failures.json'), 'utf8')
      const result = run(JSON.stringify(report), 'failure', details)
      expect(result.status).toBe(1)
      for (const text of ['file one', 'file two', 'outer error', 'inner error', 'suite: outer inner', 'UnhandledOne', 'UnhandledTwo', 'global one', 'global two']) expect(result.summary).toContain(text)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed on missing or malformed second reports and does not expose JSON parse input', () => {
    for (const details of [null, '{', '{}', JSON.stringify({ version: 2, failures: [] }), JSON.stringify({ version: 1, failures: [{ kind: 'mystery' }] })]) {
      expect(run(JSON.stringify(report), 'failure', details).status).toBe(1)
    }
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz123456'
    const result = run(`{"token":"${secret}" garbage`)
    expect(result.status).toBe(1)
    expect(result.summary + result.stderr).not.toContain(secret)
  })

  it('requires both a passing report and a successful test step', () => {
    const passing = { success: true, numFailedTests: 0, numFailedTestSuites: 0, numTotalTests: 1,
      testResults: [{ name: 'ok.test.ts', status: 'passed', message: '', assertionResults: [{ fullName: 'ok', status: 'passed', failureMessages: [] }] }] }
    expect(run(JSON.stringify(passing), 'success').status).toBe(0)
    const unhandled = JSON.stringify({ version: 1, failures: [{ file: '', fullName: 'UnhandledError', kind: 'unhandled', message: 'late failure', stack: '' }] })
    expect(run(JSON.stringify(passing), 'success', unhandled).status).toBe(1)
    for (const outcome of ['failure', 'cancelled', 'skipped', '']) expect(run(JSON.stringify(passing), outcome).status).toBe(1)
    expect(run(JSON.stringify(report), 'success').status).toBe(1)
  })
})
