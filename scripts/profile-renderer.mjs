#!/usr/bin/env node
import { cp, mkdir, mkdtemp, open, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const knownScenarios = ['git-many-lines', 'tool-many-lines', 'tool-single-line', 'review-single-line']
function options(args) {
  const result = { label: 'current', runs: 3, scenarios: [] }
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (!['--label', '--baseline', '--source-tree', '--runs', '--scenario'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Usage: node scripts/profile-renderer.mjs --label current [--baseline HEAD | --source-tree DIR] [--runs 3] [--scenario NAME]')
    }
    const value = args[++i]
    if (key === '--label') result.label = value
    if (key === '--baseline') result.baseline = value
    if (key === '--source-tree') result.sourceTree = value
    if (key === '--runs') result.runs = Number(value)
    if (key === '--scenario') result.scenarios.push(...value.split(','))
  }
  if (result.baseline && result.sourceTree) throw new Error('Choose baseline or source tree')
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(result.label)) throw new Error('Invalid label')
  if (!Number.isInteger(result.runs) || result.runs < 1 || result.runs > 100) throw new Error('Runs must be 1..100')
  if (result.scenarios.some((s) => !knownScenarios.includes(s))) throw new Error('Unknown scenario')
  result.scenarios = [...new Set(result.scenarios.length ? result.scenarios : knownScenarios)]
  return result
}
const timeout = (promise, ms, label) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out; actual state unknown`)), ms) })]).finally(() => clearTimeout(timer))
}
function metricsMap(result) { return Object.fromEntries(result.metrics.map(({ name, value }) => [name, value])) }
function metricDeltas(before, after) {
  return Object.fromEntries(Object.entries(after).filter(([key]) => key.endsWith('Duration') || key.endsWith('Count')).map(([key, value]) => [key, value - (before[key] ?? 0)]))
}
function hotspots(profile) {
  const times = new Map()
  const samples = profile.samples || []
  for (let i = 0; i < samples.length; i++) times.set(samples[i], (times.get(samples[i]) || 0) + (profile.timeDeltas?.[i] || 0))
  return profile.nodes.map((node) => ({
    function: node.callFrame.functionName || '(anonymous)', url: node.callFrame.url,
    line: node.callFrame.lineNumber + 1, selfMicroseconds: times.get(node.id) || 0, hits: node.hitCount || 0
  })).filter((node) => node.selfMicroseconds > 0).sort((a, b) => b.selfMicroseconds - a.selfMicroseconds).slice(0, 25)
}
async function saveTrace(client, target, completed) {
  await client.send('Tracing.end')
  const event = await timeout(completed, 30000, 'Tracing.tracingComplete')
  if (!event.stream) throw new Error('Tracing returned no stream')
  const file = await open(target, 'w')
  try {
    while (true) {
      const chunk = await client.send('IO.read', { handle: event.stream, size: 1024 * 1024 })
      await file.writeFile(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data)
      if (chunk.eof) break
    }
  } finally {
    await client.send('IO.close', { handle: event.stream }).catch(() => {})
    await file.close()
  }
}
async function pageSample(page) {
  return page.evaluate(async () => {
    const api = window.__PION_RENDER_PROFILE__
    const intervals = []
    const longtasks = []
    let running = true
    let previous
    const scrollCallMs = []
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longtasks.push({ startTime: entry.startTime, duration: entry.duration })
    })
    let longtaskSupported = true
    try { observer.observe({ type: 'longtask', buffered: false }) } catch { longtaskSupported = false }
    const start = performance.now()
    performance.mark('pion-profile-start')
    let firstFrame = null
    const frame = (time) => {
      if (!running) return
      if (firstFrame === null) firstFrame = performance.now() - start
      if (previous !== undefined) intervals.push(time - previous)
      previous = time
      // Scroll during the stable portion, after opening has begun.
      const elapsed = time - start
      if (elapsed >= 350 && elapsed <= 1350) {
        const scrollStart = performance.now()
        api.scroll(Math.min(1, (elapsed - 350) / 1000))
        scrollCallMs.push(performance.now() - scrollStart)
      }
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
    const openStart = performance.now()
    api.open()
    const openCallMs = performance.now() - openStart
    await new Promise((resolve) => setTimeout(resolve, 1500))
    running = false
    performance.mark('pion-profile-end')
    for (const entry of observer.takeRecords()) longtasks.push({ startTime: entry.startTime, duration: entry.duration })
    observer.disconnect()
    const sorted = [...intervals].sort((a, b) => a - b)
    return {
      elapsedMs: performance.now() - start, endedAt: performance.now(), openCallMs, firstFrameMs: firstFrame,
      raf: { count: sorted.length, meanMs: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
        p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
        maxMs: sorted.length ? sorted[sorted.length - 1] : null, over32ms: sorted.filter((n) => n > 32).length },
      scroll: { calls: scrollCallMs.length, meanCallMs: scrollCallMs.length ? scrollCallMs.reduce((a, b) => a + b, 0) / scrollCallMs.length : null,
        maxCallMs: scrollCallMs.length ? Math.max(...scrollCallMs) : null },
      longtaskSupported, longtasks, visibility: document.visibilityState, dpr: devicePixelRatio
    }
  })
}
async function sourceDigest(root) {
  const hash = createHash('sha256')
  let files = 0
  const visit = async (dir) => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) {
        hash.update(path.relative(root, file) + '\0').update(await readFile(file)).update('\0')
        files++
      } else throw new Error('Source snapshot must contain ordinary files and directories')
    }
  }
  await visit(root)
  return { sha256: hash.digest('hex'), files }
}
async function run() {
  const opts = options(process.argv.slice(2))
  if (process.platform !== 'linux' || !process.env.WAYLAND_DISPLAY || !process.env.XDG_RUNTIME_DIR) throw new Error('A Linux Wayland session is required')
  const dir = await mkdtemp('/tmp/pion-render-profile-')
  console.log(`Profile directory: ${dir}`)
  const tree = path.join(dir, 'tree')
  const buildDir = path.join(dir, 'build')
  const summary = { options: opts, directory: dir, source: null, environment: null, runs: [], diagnostics: [],
    processExit: { state: 'not-started' }, stdioClose: { state: 'not-started' } }
  const save = () => writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  let electronApp
  let profilePage
  let exitPromise
  let closePromise
  let failure
  try {
    await mkdir(tree, { recursive: true })
    if (opts.baseline) {
      const commit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${opts.baseline}^{commit}`], { cwd: repo, encoding: 'utf8' }).trim()
      const archive = path.join(dir, 'source.tar')
      execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, commit, 'src'], { cwd: repo })
      execFileSync('tar', ['-xf', archive, '-C', tree])
      summary.source = { kind: 'baseline', commit }
    } else {
      const origin = opts.sourceTree ? await realpath(path.resolve(opts.sourceTree)) : repo
      await cp(path.join(origin, 'src'), path.join(tree, 'src'), { recursive: true, dereference: false })
      summary.source = opts.sourceTree ? { kind: 'source-snapshot', origin } : {
        kind: 'current', commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), includesWorkingTree: true }
    }
    summary.source.digest = await sourceDigest(path.join(tree, 'src'))
    summary.harness = {}
    for (const relative of ['scripts/profile-renderer.mjs', 'scripts/renderer-profile/main.cjs', 'scripts/renderer-profile/fixture.tsx', 'scripts/renderer-profile/index.html']) {
      summary.harness[relative] = createHash('sha256').update(await readFile(path.join(repo, relative))).digest('hex')
    }
    const resolvePackage = createRequire(import.meta.url)
    summary.dependencies = Object.fromEntries(['react', 'react-dom', 'vite', 'electron', 'playwright'].map(name => [name, resolvePackage(`${name}/package.json`).version]))
    const fixtureDir = path.join(tree, 'scripts/renderer-profile')
    await mkdir(fixtureDir, { recursive: true })
    for (const name of ['index.html', 'fixture.tsx']) await cp(path.join(repo, 'scripts/renderer-profile', name), path.join(fixtureDir, name))
    await symlink(await realpath(path.join(repo, 'node_modules')), path.join(tree, 'node_modules'), 'dir')
    const home = path.join(dir, 'home')
    const userData = path.join(dir, 'user-data')
    const agentDir = path.join(dir, 'agent')
    const cache = path.join(dir, 'cache')
    const config = path.join(dir, 'config')
    await Promise.all([home, userData, agentDir, cache, config].map((p) => mkdir(p, { recursive: true })))
    const env = Object.fromEntries(['PATH', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_TYPE', 'LANG', 'LC_ALL', 'EGL_PLATFORM', 'GBM_BACKEND', '__GLX_VENDOR_LIBRARY_NAME', 'LIBVA_DRIVER_NAME', '__NV_PRIME_RENDER_OFFLOAD', '__VK_LAYER_NV_optimus'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]))
    Object.assign(env, { HOME: home, XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: config, TMPDIR: dir, PI_CODING_AGENT_DIR: agentDir,
      PROFILE_BUILD_ROOT: buildDir, PROFILE_ENTRY: path.join(buildDir, 'scripts/renderer-profile/index.html'), PROFILE_USER_DATA: userData })
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, env)
    const [{ build }, { default: react }, { _electron }] = await Promise.all([import('vite'), import('@vitejs/plugin-react'), import('playwright')])
    await build({ root: tree, cacheDir: path.join(dir, 'vite-cache'), configFile: false, base: './', plugins: [react()], logLevel: 'warn',
      build: { outDir: buildDir, emptyOutDir: true, sourcemap: true, rollupOptions: { input: path.join(fixtureDir, 'index.html') } } })
    const require = createRequire(import.meta.url)
    // launch() exposes the ChildProcess only on success; absence of receipts remains unknown.
    summary.processExit = { state: 'unknown' }
    summary.stdioClose = { state: 'unknown' }
    await save()
    electronApp = await _electron.launch({ executablePath: require('electron'), args: [path.join(repo, 'scripts/renderer-profile/main.cjs')], env, timeout: 30000 })
    const child = electronApp.process()
    summary.processId = child.pid
    exitPromise = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode })
      else child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    closePromise = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
    const page = await electronApp.firstWindow()
    profilePage = page
    page.on('pageerror', (error) => { if (summary.diagnostics.length < 50) summary.diagnostics.push(`pageerror: ${error.message}`) })
    await page.waitForFunction(() => !!window.__PION_RENDER_PROFILE__, null, { timeout: 30000 })
    const fixtureScenarios = await page.evaluate(() => window.__PION_RENDER_PROFILE__.scenarios)
    for (const scenario of opts.scenarios) if (!fixtureScenarios.includes(scenario)) throw new Error(`Fixture missing scenario: ${scenario}`)
    summary.environment = {
      ...(await electronApp.evaluate(async ({ app }) => {
        const gpuInfo = await app.getGPUInfo('complete')
        return { versions: process.versions, argv: process.argv, hardwareAccelerationEnabled: app.isHardwareAccelerationEnabled(),
          gpuFeatureStatus: app.getGPUFeatureStatus(), gpuInfo }
      })),
      ...(await page.evaluate(() => ({ visibility: document.visibilityState, dpr: devicePixelRatio, innerWidth, innerHeight, screen: { width: screen.width, height: screen.height } }))),
      platform: 'linux', ozoneRequested: 'wayland'
    }
    await save()
    const client = await page.context().newCDPSession(page)
    await client.send('Performance.enable')
    await client.send('Profiler.enable')
    for (const scenario of opts.scenarios) {
      await page.evaluate((s) => window.__PION_RENDER_PROFILE__.prepare(s), scenario)
      await pageSample(page)
      await page.evaluate(() => window.__PION_RENDER_PROFILE__.close())
      for (let index = 1; index <= opts.runs; index++) {
        const prefix = `${opts.label}-${scenario}-${index}`
        await page.evaluate((s) => window.__PION_RENDER_PROFILE__.prepare(s), scenario)
        const before = metricsMap(await client.send('Performance.getMetrics'))
        const beforeDom = await client.send('Memory.getDOMCounters')
        const completed = new Promise((resolve) => client.once('Tracing.tracingComplete', resolve))
        await client.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline', transferMode: 'ReturnAsStream' })
        let sample, after, afterDom
        try {
          sample = await pageSample(page)
          after = metricsMap(await client.send('Performance.getMetrics'))
          afterDom = await client.send('Memory.getDOMCounters')
        } finally { await saveTrace(client, path.join(dir, `${prefix}.trace.json`), completed) }
        const captured = await page.evaluate(() => ({ at: performance.now(), state: window.__PION_RENDER_PROFILE__.snapshot() }))
        sample.snapshot = captured.state
        sample.snapshotLagMs = captured.at - sample.endedAt
        sample.snapshotPhase = 'after-trace-drain'
        summary.operation = { scenario, index, phase: 'trace-markers' }
        await page.waitForFunction(() => {
          const state = window.__PION_RENDER_PROFILE__.snapshot()
          return state.visiblePending === 0 && state.visiblePendingLines === 0
        }, null, { timeout: 8000, polling: 100 })
        sample.settledSnapshot = await page.evaluate(() => window.__PION_RENDER_PROFILE__.snapshot())
        await page.evaluate(() => window.__PION_RENDER_PROFILE__.close())
        // Separate round prevents CPU sampling overhead from contaminating the trace run.
        await page.evaluate((s) => window.__PION_RENDER_PROFILE__.prepare(s), scenario)
        await client.send('Profiler.start')
        let profile, cpuSample
        try { cpuSample = await pageSample(page) } finally { ({ profile } = await client.send('Profiler.stop')) }
        await writeFile(path.join(dir, `${prefix}.cpuprofile`), JSON.stringify(profile))
        summary.operation = { scenario, index, phase: 'cpu-markers' }
        await page.waitForFunction(() => {
          const state = window.__PION_RENDER_PROFILE__.snapshot()
          return state.visiblePending === 0 && state.visiblePendingLines === 0
        }, null, { timeout: 8000, polling: 100 })
        cpuSample.settledSnapshot = await page.evaluate(() => window.__PION_RENDER_PROFILE__.snapshot())
        await page.evaluate(() => window.__PION_RENDER_PROFILE__.close())
        summary.runs.push({ scenario, index, trace: `${prefix}.trace.json`, cpuProfile: `${prefix}.cpuprofile`,
          sample, cpuSample, metricsBefore: before, metricsAfter: after, metricDeltas: metricDeltas(before, after), domBefore: beforeDom, domAfter: afterDom, hotspots: hotspots(profile) })
        await save()
        console.log(`${scenario} ${index}/${opts.runs}: raf p95 ${sample.raf.p95Ms?.toFixed(1) ?? 'n/a'} ms`)
      }
    }
    await client.send('Profiler.disable')
    await client.send('Performance.disable')
    await client.detach()
  } catch (error) {
    failure = error
    summary.diagnostics.push(error?.stack || String(error))
    if (profilePage && !profilePage.isClosed()) {
      try {
        summary.failureSnapshot = await timeout(profilePage.evaluate(() => window.__PION_RENDER_PROFILE__?.snapshot()), 5000, 'failure snapshot')
      } catch (snapshotError) { summary.diagnostics.push(`failure snapshot: ${snapshotError.message}`) }
    }
  } finally {
    if (electronApp && exitPromise) {
      try {
        await timeout(electronApp.evaluate(({ app }) => app.quit()).catch((error) => { summary.diagnostics.push(`quit: ${error.message}`) }), 10000, 'quit request')
        summary.processExit = await timeout(exitPromise, 15000, 'Electron exit')
        summary.stdioClose = await timeout(closePromise, 15000, 'Electron stdio close')
        if (summary.processExit.code !== 0 || summary.processExit.signal) failure ||= new Error(`Electron exit: ${JSON.stringify(summary.processExit)}`)
      } catch (error) { summary.diagnostics.push(error.message); failure ||= error }
    }
    await save()
  }
  if (failure) throw failure
  console.log(`Summary: ${path.join(dir, 'summary.json')}`)
}
run().catch((error) => { console.error(error?.stack || error); process.exitCode = 1 })
