import { appendFile, readFile } from 'node:fs/promises'

const [reportPath, detailsPath] = process.argv.slice(2)
const summaryPath = process.env.GITHUB_STEP_SUMMARY
const outcome = process.env.TEST_OUTCOME
const MAX_DIAGNOSTIC = 1500
const MAX_SUMMARY_BYTES = 900_000

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function safeText(value) {
  let text = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  text = text.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED]')
  text = text.replace(/\b(bearer\s+|(?:token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
  return text
}

function diagnostic(value) {
  const text = safeText(value)
  const clipped = text.length > MAX_DIAGNOSTIC
  return escapeHtml(text.slice(0, MAX_DIAGNOSTIC)) + (clipped ? '\n[Diagnostic truncated; full JSON reports in the artifact.]' : '')
}

function render(report, details) {
  if (!report || typeof report !== 'object' || typeof report.success !== 'boolean' ||
      !Number.isSafeInteger(report.numFailedTests) || report.numFailedTests < 0 ||
      !Number.isSafeInteger(report.numFailedTestSuites) || report.numFailedTestSuites < 0 ||
      !Number.isSafeInteger(report.numTotalTests) || report.numTotalTests < 0 ||
      !Array.isArray(report.testResults) || report.testResults.length === 0) throw new Error('Invalid Vitest report')
  if (!details || details.version !== 1 || !Array.isArray(details.failures)) throw new Error('Invalid Vitest failure details')
  const lines = ['## Windows full test suite', '',
    'Vitest JSON and task error reports list test, file, suite and unhandled errors; they do not contain the complete console log. Diagnostics are limited to 1500 characters each; both full JSON reports are in the workflow artifact. No repository secrets are supplied to this job. Credential masking is partial; review reports before sharing.', '']
  let failures = 0
  let pending = 0
  let failedFiles = 0
  let total = 0
  for (const file of report.testResults) {
    if (!file || typeof file.name !== 'string' || !file.name || typeof file.message !== 'string' ||
        !['passed', 'failed'].includes(file.status) || !Array.isArray(file.assertionResults)) throw new Error('Invalid Vitest file result')
    const failed = []
    const waiting = []
    for (const test of file.assertionResults) {
      if (!test || typeof test.fullName !== 'string' || !test.fullName ||
          !['passed', 'failed', 'skipped', 'pending', 'todo', 'disabled'].includes(test.status) ||
          !Array.isArray(test.failureMessages) || !test.failureMessages.every(message => typeof message === 'string')) throw new Error('Invalid Vitest assertion result')
      total++
      if (test.status === 'failed') { failures++; failed.push(test) }
      if (test.status === 'pending') { pending++; waiting.push(test) }
    }
    if (file.status === 'passed' && (failed.length || file.message)) throw new Error('Inconsistent Vitest file status')
    if (file.status === 'failed') failedFiles++
    if (file.status === 'failed' || waiting.length) {
      lines.push(`<h3>${escapeHtml(safeText(file.name))}</h3>`)
      if (file.message) lines.push(`<pre>${diagnostic(file.message)}</pre>`)
      if (file.status === 'failed' && !file.message && !failed.length) lines.push('<p>File failed without a diagnostic in the JSON report.</p>')
      for (const test of failed) {
        lines.push(`<p><strong>${escapeHtml(safeText(test.fullName))}</strong></p>`)
        for (const message of test.failureMessages) lines.push(`<pre>${diagnostic(message)}</pre>`)
        if (!test.failureMessages.length) lines.push('<p>No diagnostic in the JSON report.</p>')
      }
      for (const test of waiting) lines.push(`<p>Pending: <strong>${escapeHtml(safeText(test.fullName))}</strong></p>`)
    }
  }
  if (total !== report.numTotalTests || failures !== report.numFailedTests ||
      (report.success && (failedFiles > 0 || failures > 0 || report.numFailedTestSuites > 0 || total === 0)) ||
      (!report.success && failedFiles === 0 && failures === 0 && report.numFailedTestSuites === 0)) throw new Error('Inconsistent Vitest totals')
  if (details.failures.length) lines.push('<h3>Task and unhandled errors</h3>')
  for (const item of details.failures) {
    if (!item || !['file', 'suite', 'test', 'unhandled'].includes(item.kind) ||
        typeof item.file !== 'string' || typeof item.fullName !== 'string' || !item.fullName ||
        typeof item.message !== 'string' || typeof item.stack !== 'string' ||
        (item.kind !== 'unhandled' && !item.file)) throw new Error('Invalid Vitest failure detail')
    lines.push(`<p><strong>${escapeHtml(safeText(item.kind))}: ${escapeHtml(safeText(item.fullName))}</strong>${item.file ? ` — ${escapeHtml(safeText(item.file))}` : ''}</p>`)
    if (item.message) lines.push(`<pre>${diagnostic(item.message)}</pre>`)
    if (item.stack && item.stack !== item.message) lines.push(`<pre>${diagnostic(item.stack)}</pre>`)
    if (!item.message && !item.stack) lines.push('<p>No diagnostic in the task report.</p>')
  }
  if (!failedFiles && !pending && !details.failures.length) lines.push(report.numFailedTestSuites > 0
    ? 'A suite failed without a file-level failure in the JSON report; inspect the job log.'
    : 'No test, file, suite or unhandled failures in the JSON reports.')
  if (outcome !== 'success') lines.push('', `Test step outcome: ${escapeHtml(safeText(outcome || 'unknown'))}. Check the workflow job for errors outside the JSON reports.`)
  let content = `${lines.join('\n')}\n`
  if (Buffer.byteLength(content) > MAX_SUMMARY_BYTES) {
    content = `${lines.filter(line => !line.startsWith('<pre>')).join('\n')}\n\nAll diagnostic excerpts omitted to fit the summary; full JSON reports in the artifact.\n`
  }
  if (Buffer.byteLength(content) > MAX_SUMMARY_BYTES) throw new Error('Failure names exceed the summary limit; inspect the full JSON artifacts')
  return { content, success: report.success && outcome === 'success' && pending === 0 && details.failures.length === 0 }
}

async function loadJson(path) {
  const text = await readFile(path, 'utf8')
  try { return JSON.parse(text) } catch { throw new Error('Invalid JSON report') }
}

try {
  if (!summaryPath || !reportPath || !detailsPath) throw new Error('Missing summary or report path')
  const result = render(await loadJson(reportPath), await loadJson(detailsPath))
  await appendFile(summaryPath, result.content, 'utf8')
  if (!result.success) process.exitCode = 1
} catch (error) {
  const message = safeText(`Windows test report unavailable or invalid: ${error instanceof Error ? error.message : 'unknown error'}`)
  if (summaryPath) await appendFile(summaryPath, `## Windows full test suite\n\n${escapeHtml(message)}. Quality gate failed.\n`, 'utf8')
  console.error(message)
  process.exitCode = 1
}
