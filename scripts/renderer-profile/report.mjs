#!/usr/bin/env node
// Offline report for profile-renderer.mjs output. Never prints trace payloads or source content.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const { TraceMap, originalPositionFor } = createRequire(import.meta.url)('@jridgewell/trace-mapping')
const args = process.argv.slice(2)
const withTrace = args.includes('--trace')
const dirs = args.filter((arg) => arg !== '--trace')
if (!dirs.length || dirs.some((arg) => arg.startsWith('--'))) {
  console.error('Usage: node scripts/renderer-profile/report.mjs [--trace] DIR [DIR...]')
  process.exit(1)
}
function json(file) {
  const text = readFileSync(file, 'utf8')
  try { return JSON.parse(text) } catch { throw new Error(`invalid JSON: ${path.basename(file)}`) }
}
const fmt = (n) => Number.isFinite(n) ? Number(n.toFixed(2)).toString() : 'n/a'
function median(values) {
  if (!values.length || values.some((n) => !Number.isFinite(n))) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const medianOf = (runs, get) => fmt(median(runs.map(get)))
const durationMs = (run, key) => Number.isFinite(run.metricDeltas?.[key]) ? run.metricDeltas[key] * 1000 : null
const eventNames = ['Layout', 'UpdateLayoutTree', 'Paint', 'PrePaint', 'Layerize', 'FunctionCall', 'RunTask']

function traceReport(file) {
  const trace = json(file)
  const events = Array.isArray(trace) ? trace : trace.traceEvents
  if (!Array.isArray(events)) throw new Error('traceEvents missing')
  const starts = events.filter((e) => e.name === 'pion-profile-start' && Number.isFinite(e.ts))
  const ends = events.filter((e) => e.name === 'pion-profile-end' && Number.isFinite(e.ts))
  if (starts.length !== 1 || ends.length !== 1 || starts[0].pid !== ends[0].pid || starts[0].tid !== ends[0].tid || starts[0].ts >= ends[0].ts) {
    throw new Error('ambiguous or missing start/end marks on one pid/tid')
  }
  const start = starts[0], end = ends[0]
  const totals = Object.fromEntries(eventNames.map((name) => [name, { count: 0, total: 0, max: 0 }]))
  for (const e of events) {
    if (e.ph !== 'X' || e.pid !== start.pid || e.tid !== start.tid || !Object.hasOwn(totals, e.name) || !Number.isFinite(e.ts) || !Number.isFinite(e.dur) || e.dur < 0) continue
    // Clip events crossing the boundary; count only positive overlap.
    const overlap = Math.min(e.ts + e.dur, end.ts) - Math.max(e.ts, start.ts)
    if (overlap <= 0) continue
    const item = totals[e.name]
    item.count++
    item.total += overlap / 1000
    item.max = Math.max(item.max, overlap / 1000)
  }
  console.log(`  trace pid/tid=${start.pid}/${start.tid} window=${fmt((end.ts - start.ts) / 1000)}ms; X overlap clipped to marks; inclusive, categories overlap and are not additive`)
  for (const [name, item] of Object.entries(totals)) console.log(`    ${name}: count=${item.count} total=${fmt(item.total)}ms max=${fmt(item.max)}ms`)
}

function cpuReport(dir, file) {
  const profile = json(file)
  if (!Array.isArray(profile.nodes) || !Array.isArray(profile.samples) || !Array.isArray(profile.timeDeltas) || profile.samples.length !== profile.timeDeltas.length) throw new Error('invalid CPU samples')
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const parents = new Map()
  for (const node of profile.nodes) for (const child of node.children || []) parents.set(child, node.id)
  const maps = new Map(), descriptions = new Map()
  function describe(node) {
    if (descriptions.has(node.id)) return descriptions.get(node.id)
    const frame = node.callFrame || {}, name = frame.functionName || '(anonymous)'
    let source = null, line = null, originalName = null
    // Resolve only the generated build file in this report directory, never arbitrary URLs.
    if (frame.url?.startsWith('file:') && frame.lineNumber >= 0 && frame.columnNumber >= 0) {
      let basename
      try { basename = path.basename(new URL(frame.url).pathname) } catch { /* invalid URL */ }
      if (basename?.endsWith('.js')) {
        if (!maps.has(basename)) {
          try { maps.set(basename, new TraceMap(json(path.join(dir, 'build', 'assets', `${basename}.map`)))) } catch { maps.set(basename, null) }
        }
        const map = maps.get(basename)
        if (map) {
          const original = originalPositionFor(map, { line: frame.lineNumber + 1, column: frame.columnNumber })
          source = original.source; line = original.line; originalName = original.name
        }
      }
    }
    const location = source ? `${source}:${line}` : frame.url ? `${path.basename(frame.url)}:${frame.lineNumber + 1} (unmapped)` : '(native/VM or anonymous script)'
    const result = { label: `${originalName || name} @ ${location}`, source, name }
    descriptions.set(node.id, result)
    return result
  }
  const self = new Map(), nativeOwners = new Map(), scans = new Map()
  const add = (map, key, duration) => map.set(key, (map.get(key) || 0) + duration)
  for (let i = 0; i < profile.samples.length; i++) {
    const node = nodes.get(profile.samples[i]), us = profile.timeDeltas[i]
    if (!node || !Number.isFinite(us) || us < 0) continue
    const leaf = describe(node)
    add(self, leaf.label, us)
    let id = node.id, owner = null
    const seen = new Set(), scanFrames = new Set()
    while (id != null && !seen.has(id)) {
      seen.add(id)
      const current = nodes.get(id)
      if (!current) break
      const desc = describe(current)
      if (id !== node.id && !owner && desc.source) owner = desc.label
      if (desc.source && /(?:lineReveal|textReveal|ReviewRevealText)/i.test(desc.source)) scanFrames.add(desc.label)
      id = parents.get(id)
    }
    if (!node.callFrame?.url && node.callFrame?.lineNumber < 0 && !leaf.name.startsWith('(')) add(nativeOwners, `${leaf.name} <- ${owner || '(no mapped JS ancestor)'}`, us)
    for (const scan of scanFrames) add(scans, scan, us)
  }
  function printTop(title, values, limit) {
    console.log(`    ${title}`)
    const sorted = [...values].sort((a, b) => b[1] - a[1]).slice(0, limit)
    if (!sorted.length) console.log('      n/a')
    for (const [label, us] of sorted) console.log(`      ${fmt(us / 1000)}ms ${label}`)
  }
  console.log(`  CPU separate sampling round, ${profile.samples.length} samples; timeDeltas weighted estimates (includes idle/program); mapped locations use generated frame position, no line-level attribution guarantee`)
  printTop('top self samples:', self, 15)
  printTop('native self samples <- nearest mapped JS ancestor:', nativeOwners, 10)
  printTop('reveal scan/reveal source ancestors inclusive (overlap; not additive):', scans, 10)
}

function report(dir) {
  const data = json(path.join(dir, 'summary.json'))
  if (!Array.isArray(data.runs)) throw new Error('summary runs missing')
  const env = data.environment || {}, options = data.options || {}
  console.log(`\n=== ${options.label || '(unlabeled)'}: ${dir} ===`)
  console.log(`source=${JSON.stringify(data.source ?? null)}; processExit=${JSON.stringify(data.processExit ?? null)}; stdioClose=${JSON.stringify(data.stdioClose ?? null)}; diagnostics=${Array.isArray(data.diagnostics) ? data.diagnostics.length : 'unknown'}`)
  console.log(`environment: ${env.platform || '?'} ozoneRequested=${env.ozoneRequested || '?'} Electron=${env.versions?.electron || '?'} Chrome=${env.versions?.chrome || '?'} visibility=${env.visibility || '?'} window=${env.innerWidth ?? '?'}x${env.innerHeight ?? '?'} DPR=${env.dpr ?? '?'} gpu_compositing=${env.gpuFeatureStatus?.gpu_compositing || '?'} rasterization=${env.gpuFeatureStatus?.rasterization || '?'}`)
  console.log('Fixture CSS viewport: width min(1100px, 100%), height 640px; actual scroll viewport below. Wayland Electron with controlled synthetic content; software status as reported above. RAF intervals indicate stalls, not whole-app hardware FPS.')
  const scenarios = [...new Set(data.runs.map((run) => run.scenario))]
  for (const scenario of scenarios) {
    const runs = data.runs.filter((run) => run.scenario === scenario).sort((a, b) => a.index - b.index)
    console.log(`\n${scenario}: ${runs.length} rounds, per-metric median${runs.length !== 3 ? ' (expected 3)' : ''}`)
    console.log(`  openCall=${medianOf(runs, (r) => r.sample?.openCallMs)}ms RAF p95=${medianOf(runs, (r) => r.sample?.raf?.p95Ms)}ms max=${medianOf(runs, (r) => r.sample?.raf?.maxMs)}ms`)
    console.log(`  CDP metric deltas ms: Script=${medianOf(runs, (r) => durationMs(r, 'ScriptDuration'))} Layout=${medianOf(runs, (r) => durationMs(r, 'LayoutDuration'))} RecalcStyle=${medianOf(runs, (r) => durationMs(r, 'RecalcStyleDuration'))} TaskDuration=${medianOf(runs, (r) => durationMs(r, 'TaskDuration'))} (overlap possible)`)
    console.log(`  DOM snapshot ${[...new Set(runs.map((r) => r.sample?.snapshotPhase || 'unknown'))].join('/')}, non-peak: rows=${medianOf(runs, (r) => r.sample?.snapshot?.rows)} blocks=n/a (not recorded) reveal-character nodes=${medianOf(runs, (r) => r.sample?.snapshot?.chars)} text UTF-16 units=${medianOf(runs, (r) => r.sample?.snapshot?.textLength)} nodes=${medianOf(runs, (r) => r.sample?.snapshot?.nodes)} elements=${medianOf(runs, (r) => r.sample?.snapshot?.elements)} viewport=${medianOf(runs, (r) => r.sample?.snapshot?.viewportWidth)}x${medianOf(runs, (r) => r.sample?.snapshot?.viewport)}`)
    if (withTrace) {
      if (runs.length % 2 !== 1) { console.log('  trace/CPU skipped: no unique middle round'); continue }
      const middle = runs[Math.floor(runs.length / 2)]
      console.log(`  middle chronological round index=${middle.index} (not selected by metric median)`)
      try { traceReport(path.join(dir, middle.trace)) } catch (error) { console.log(`  trace unavailable: ${error.message}`); process.exitCode = 1 }
      try { cpuReport(dir, path.join(dir, middle.cpuProfile)) } catch (error) { console.log(`  CPU unavailable: ${error.message}`); process.exitCode = 1 }
    }
  }
}
for (const dir of dirs) {
  try { report(dir) } catch (error) { console.error(`${dir}: ${error.message}`); process.exitCode = 1 }
}
