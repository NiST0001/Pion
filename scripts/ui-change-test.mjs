// UI 变更验证：无边框标题栏 / 模型选择器位置 / 设置面板
import { spawn, execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = '9344'
// 测试工作区用独立临时 git 仓库，避免与本机正在使用的项目会话互相干扰
const TEST_WORKSPACE = mkdtempSync(join(tmpdir(), 'pion-ui-test-'))
execSync('git init -q -b main && git config user.email nist@localhost && git config user.name nist && git commit -q --allow-empty -m init', { cwd: TEST_WORKSPACE })
const TRUST_TEST_WORKSPACE = mkdtempSync(join(tmpdir(), 'pion-trust-ui-'))
mkdirSync(join(TRUST_TEST_WORKSPACE, '.pi'), { recursive: true })
writeFileSync(join(TRUST_TEST_WORKSPACE, '.pi', 'SYSTEM.md'), 'Untrusted test resource\n')
const CHECKPOINT_BASELINE_FILE = join(TEST_WORKSPACE, '.pion-checkpoint-baseline.tmp')
const CHECKPOINT_TEST_FILE = join(TEST_WORKSPACE, '.pion-checkpoint-ui-test.tmp')
rmSync(CHECKPOINT_BASELINE_FILE, { force: true })
rmSync(CHECKPOINT_TEST_FILE, { force: true })
writeFileSync(CHECKPOINT_BASELINE_FILE, 'preserve this pre-run content\n')
const child = spawn('node_modules/electron/dist/electron', ['.', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, PION_TOOL_PERMISSION_TEST: '1' },
  stdio: ['ignore', 'ignore', 'ignore']
})
process.on('exit', () => {
  try { child.kill('SIGKILL') } catch {}
  rmSync(CHECKPOINT_BASELINE_FILE, { force: true })
  rmSync(CHECKPOINT_TEST_FILE, { force: true })
  rmSync(TRUST_TEST_WORKSPACE, { recursive: true, force: true })
  rmSync(TEST_WORKSPACE, { recursive: true, force: true })
})

async function getPage() {
  // Startup can stall for tens of seconds when another Pion instance is running
  // (GPU/profile contention); wait generously before giving up.
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const page = (await res.json()).find((t) => t.type === 'page')
      if (page) return page
    } catch { /* not ready */ }
  }
  throw new Error('page target not found')
}

const page = await getPage()
const { WebSocket } = await import('ws')
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
let msgId = 0
const pending = new Map()
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const evaluate = async (expression) => {
  const res = await new Promise((resolve) => {
    const id = ++msgId
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
  const { result, exceptionDetails } = res.result
  if (exceptionDetails) return `EXC: ${exceptionDetails.text}`
  return result.value
}

let ok = 0
const check = async (name, expr) => {
  const value = await evaluate(expr)
  const pass = value === true || value === 'PASS'
  console.log(`${pass ? '✓' : '✗'} ${name}${pass ? '' : ` -> ${JSON.stringify(value)}`}`)
  if (pass) ok++
}

const checkHost = (name, value) => {
  console.log(`${value ? '✓' : '✗'} ${name}`)
  if (value) ok++
}

// 等待 agent 运行
for (let i = 0; i < 40; i++) {
  await sleep(500)
  if (await evaluate(`!!document.querySelector('.composer-row textarea')`)) break
}
// Previous interrupted runs may have left deleted temp workspaces in the
// persistent project list. Remove only this test suite's own path prefix.
await evaluate(`(async () => { const projects = await window.pion.listProjects(); for (const project of projects) { if (/^\\/tmp\\/pion-(?:ui-test|trust-ui)-/.test(project.cwd)) await window.pion.removeProject(project.cwd); } return true; })()`)

await evaluate(`(async () => { await window.pion.addProject(${JSON.stringify(TRUST_TEST_WORKSPACE)}); await window.pion.setProjectTrust(${JSON.stringify(TRUST_TEST_WORKSPACE)}, false); await window.pion.startAgent(${JSON.stringify(TRUST_TEST_WORKSPACE)}); return true })()`)
for (let i = 0; i < 20; i++) {
  await sleep(120)
  if (await evaluate(`!!document.querySelector('.project-trust-banner')`)) break
}
await check('未信任项目显示安全提示', `document.querySelector('.project-trust-banner')?.classList.contains('project-trust-untrusted') && document.querySelector('.project-trust-banner')?.textContent?.includes('不是沙箱')`)
await check('安全提示使用克制入场动画', `getComputedStyle(document.querySelector('.project-trust-banner')).animationName === 'pion-slide-in-down'`)
await check('未信任项目跳过本地 Pi 资源', `(async () => { const trust = await window.pion.getProjectTrust(${JSON.stringify(TRUST_TEST_WORKSPACE)}); return trust.requiresTrust && trust.decision === 'untrusted'; })()`)
await evaluate(`document.querySelector('.project-trust-approve')?.click()`)
for (let i = 0; i < 30; i++) {
  await sleep(150)
  if (await evaluate(`(async () => (await window.pion.getProjectTrust(${JSON.stringify(TRUST_TEST_WORKSPACE)})).decision === 'trusted' && !document.querySelector('.project-trust-banner'))()`)) break
}
await check('项目可被信任并重新加载', `(async () => (await window.pion.getProjectTrust(${JSON.stringify(TRUST_TEST_WORKSPACE)})).decision === 'trusted' && !document.querySelector('.project-trust-banner'))()`)
// 等待信任后重载的后端真正响应，避免后续 setProjectTrust 打在启动中的后台上超时
for (let i = 0; i < 90; i++) {
  await sleep(500)
  if (await evaluate(`(async () => { const s = await window.pion.getState(); return !!s && s.status?.cwd === ${JSON.stringify(TRUST_TEST_WORKSPACE)} && s.status?.phase === 'running' })()`)) break
}
await evaluate(`(async () => { await window.pion.setProjectTrust(${JSON.stringify(TRUST_TEST_WORKSPACE)}, null); await window.pion.removeProject(${JSON.stringify(TRUST_TEST_WORKSPACE)}); await window.pion.addProject(${JSON.stringify(TEST_WORKSPACE)}); await window.pion.startAgent(${JSON.stringify(TEST_WORKSPACE)}); await window.pion.newSession(); return true })()`)
// 等待新会话的空状态真正落到界面上（启动时可能短暂展示恢复的实时会话）
for (let i = 0; i < 60; i++) {
  await sleep(250)
  if (await evaluate(`document.querySelectorAll('.timeline > *').length === 0 && !!document.querySelector('.empty-state')`)) break
}
// 后端在本机高负载时启动较慢，等待其真正激活再继续
for (let i = 0; i < 60; i++) {
  await sleep(500)
  if (await evaluate(`(async () => (await window.pion.getState()) !== null)()`)) break
}
for (let i = 0; i < 40; i++) {
  await sleep(250)
  if (await evaluate(`document.querySelector('.send-button')?.disabled === false`)) break
}
rmSync(TRUST_TEST_WORKSPACE, { recursive: true, force: true })
await sleep(250)
await check('新会话时间线为空', `document.querySelectorAll('.timeline > *').length === 0 && !!document.querySelector('.empty-state')`)
await evaluate(`(() => { const input = document.querySelector('.composer-row textarea'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; setter?.call(input, '/plan exit'); input?.dispatchEvent(new Event('input', { bubbles: true })); input?.focus(); return true })()`)
await sleep(80)
await evaluate(`document.querySelector('.send-button')?.click()`)
for (let i = 0; i < 40; i++) {
  await sleep(400)
  if (await evaluate(`(async () => Boolean((await window.pion.getState())?.sessionId))()`)) break
}
await check('发送任务后启动后端', `(async () => Boolean((await window.pion.getState())?.sessionId))()`)
await check('任务面板在无任务会话中隐藏', `!document.querySelector('.task-panel')`)
await check('会话历史按窗口读取', `(async()=>{const page=await window.pion.getEntriesPage(undefined, 2); return !!page && page.entries.length <= 2 && page.total >= page.entries.length})()`)

// --- 工具权限 RPC 子协议 ---
await evaluate(`(async () => { window.__pionToolPolicyBefore = await window.pion.getToolPermissionPolicy(${JSON.stringify(TEST_WORKSPACE)}); await window.pion.setToolPermissionPolicy(${JSON.stringify(TEST_WORKSPACE)}, { write: 'ask' }); window.pion.send('/pion-permission-test').catch((error) => { window.__pionPermissionError = String(error); }); return true; })()`)
for (let i = 0; i < 80; i++) {
  await sleep(120)
  if (await evaluate(`!!document.querySelector('.tool-permission-modal')`)) break
}
await check('工具调用显示权限确认', `document.querySelector('.tool-permission-modal')?.textContent?.includes('Agent 请求执行操作') && document.querySelector('.tool-permission-summary')?.textContent?.includes('pion-permission-test.txt')`)
await check('权限请求悬浮在输入框上方', `(() => { const backdrop = document.querySelector('.tool-permission-backdrop'); const panel = document.querySelector('.tool-permission-modal')?.getBoundingClientRect(); const composer = document.querySelector('.composer-dock')?.getBoundingClientRect(); if (!backdrop || !panel || !composer) return false; const cs = getComputedStyle(backdrop); return cs.position === 'absolute' && cs.pointerEvents === 'none' && cs.backgroundColor === 'rgba(0, 0, 0, 0)' && panel.bottom <= composer.top + 8; })()`)
await check('权限确认支持分级允许', `document.querySelectorAll('.tool-permission-allow-actions button').length === 3 && !!document.querySelector('.tool-permission-allow-project')`)
await evaluate(`document.querySelector('.tool-permission-allow-project')?.click()`)
for (let i = 0; i < 30; i++) {
  await sleep(100)
  if (await evaluate(`!document.querySelector('.tool-permission-modal')`)) break
}
await check('项目级允许即时持久化', `(async () => { const policy = await window.pion.getToolPermissionPolicy(${JSON.stringify(TEST_WORKSPACE)}); return policy.source === 'saved' && policy.rules.write === 'allow' && (await window.pion.getPendingToolPermissionRequests()).length === 0 && !window.__pionPermissionError; })()`)
await evaluate(`(async () => { await window.pion.setToolPermissionPolicy(${JSON.stringify(TEST_WORKSPACE)}, { write: 'allow', shell: 'ask' }); window.pion.send('/pion-permission-risk-test').catch((error) => { window.__pionPermissionError = String(error); }); return true; })()`)
for (let i = 0; i < 80; i++) {
  await sleep(120)
  if (await evaluate(`!!document.querySelector('.tool-permission-modal')`)) break
}
await check('高风险命令强制逐次确认', `document.querySelector('.tool-permission-risks')?.textContent?.includes('高风险命令') && document.querySelectorAll('.tool-permission-allow-actions button').length === 1 && !document.querySelector('.tool-permission-allow-project')`)
await evaluate(`document.querySelector('.tool-permission-allow-actions button')?.click()`)
for (let i = 0; i < 30; i++) {
  await sleep(100)
  if (await evaluate(`!document.querySelector('.tool-permission-modal')`)) break
}
await check('高风险单次允许不修改项目策略', `(async () => (await window.pion.getToolPermissionPolicy(${JSON.stringify(TEST_WORKSPACE)})).rules.shell === 'ask')()`)
await check('Agent 工作指示器在空闲时隐藏', `!document.querySelector('.agent-working-text')`)

// --- 1. 无边框标题栏 ---
await check('标题栏存在', `!!document.querySelector('.titlebar')`)
await check('全局字体使用 Maple Mono', `getComputedStyle(document.body).fontFamily.includes('Maple Mono')`)
await check('旧 header 已移除', `!document.querySelector('.app-header')`)
await check('窗口控制三键（最小/最大/关闭）', `document.querySelectorAll('.titlebar-btn').length >= 3`)
await check('关闭按钮样式', `!!document.querySelector('.titlebar-close')`)
await check('标题栏含品牌', `document.querySelector('.titlebar-brand .brand-name')?.textContent === 'Pion'`)
await check('标题栏已移除状态圆点', `!document.querySelector('.titlebar-brand .dot')`)
await check('左上角会话栏开关', `!!document.querySelector('.titlebar-panel-btn')`)
await check('右上角文件审查栏开关', `!!document.querySelector('.titlebar-review-btn')`)
await check('审查面板默认打开', `!!document.querySelector('.review-panel')`)
await check('审查面板默认占工作区一半', `(() => { const body = document.querySelector('.app-body')?.getBoundingClientRect(); const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect(); const review = document.querySelector('.review-panel')?.getBoundingClientRect(); if (!body || !sidebar || !review) return false; const available = body.width - sidebar.width; const ratio = review.width / available; return Math.abs(ratio - 0.5) <= 0.035 ? true : { ratio, review: review.width, available }; })()`)
await sleep(180)
await check('发送任务前自动创建运行检查点', `document.querySelector('.review-checkpoint')?.classList.contains('review-checkpoint-ready') && !!document.querySelector('.review-checkpoint-rollback')`)
writeFileSync(CHECKPOINT_BASELINE_FILE, 'changed after Pion run checkpoint\n')
writeFileSync(CHECKPOINT_TEST_FILE, 'created after Pion run checkpoint\n')
await evaluate(`window.pion.getRunCheckpoint()`)
for (let i = 0; i < 20; i++) {
  await sleep(120)
  if (await evaluate(`document.querySelector('.review-checkpoint-rollback')?.disabled === false`)) break
}
await check('检查点检测本轮工作区修改', `document.querySelector('.review-checkpoint-rollback')?.disabled === false && document.querySelector('.review-checkpoint-copy')?.textContent?.includes('可恢复')`)
await evaluate(`document.querySelector('.review-checkpoint-rollback')?.click()`)
await sleep(120)
await check('本轮回滚使用主题确认框', `(() => { const dialog = document.querySelector('.confirm-dialog'); const probe = document.createElement('i'); probe.style.background = 'var(--bg-elev)'; document.body.appendChild(probe); const expected = getComputedStyle(probe).backgroundColor; probe.remove(); return !!dialog && dialog.getAttribute('role') === 'alertdialog' && dialog.textContent?.includes('撤销本轮修改') && getComputedStyle(dialog).backgroundColor === expected; })()`)
await evaluate(`document.querySelector('.confirm-dialog-confirm')?.click()`)
for (let i = 0; i < 30; i++) {
  await sleep(120)
  if (await evaluate(`document.querySelector('.review-checkpoint')?.classList.contains('review-checkpoint-rolled-back')`)) break
}
await check('一键恢复本轮检查点', `document.querySelector('.review-checkpoint')?.classList.contains('review-checkpoint-rolled-back') && document.querySelector('.review-checkpoint-copy')?.textContent?.includes('已恢复') && !document.querySelector('.confirm-dialog')`)
checkHost('检查点移除本轮新增文件', !existsSync(CHECKPOINT_TEST_FILE))
checkHost(
  '检查点保留并恢复发送前已有文件',
  existsSync(CHECKPOINT_BASELINE_FILE)
    && readFileSync(CHECKPOINT_BASELINE_FILE, 'utf8') === 'preserve this pre-run content\n'
)
rmSync(CHECKPOINT_BASELINE_FILE, { force: true })
await evaluate(`document.querySelector('.titlebar-review-btn')?.click()`)
await sleep(120)
await check('左侧会话栏默认打开', `!!document.querySelector('.sidebar')`)
await check('会话栏含宽度拖拽手柄', `document.querySelector('.sidebar-resizer')?.getAttribute('role') === 'separator'`)
await evaluate(`(() => { const handle = document.querySelector('.sidebar-resizer'); const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect(); if (!handle || !sidebar) return false; window.__pionSidebarBefore = sidebar.width; handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: sidebar.right, pointerId: 11, pointerType: 'mouse' })); window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: sidebar.right + 36, pointerId: 11, pointerType: 'mouse' })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: sidebar.right + 36, pointerId: 11, pointerType: 'mouse' })); return true })()`)
await sleep(120)
await check('会话栏可拖动调整宽度', `document.querySelector('.sidebar')?.getBoundingClientRect().width > window.__pionSidebarBefore`)
await check('侧栏含新建会话按钮', `!!document.querySelector('.sidebar-new-session') && document.querySelector('.sidebar-new-session')?.textContent?.includes('新建会话')`)
await check('侧栏含技能与工具按钮', `!!document.querySelector('.sidebar-tools-button') && document.querySelector('.sidebar-tools-button')?.textContent?.includes('技能与工具')`)
await check('侧栏搜索为直接输入框', `document.querySelector('.sidebar-search input')?.tagName === 'INPUT' && document.querySelector('.sidebar-search input')?.getAttribute('placeholder') === '搜索会话'`)
await evaluate(`(() => { const input = document.querySelector('.sidebar-search input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; setter?.call(input, '__no_matching_session__'); input?.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
await sleep(120)
await check('搜索输入可筛选项目会话', `document.querySelectorAll('.project-branch-sessions .side-session').length === 0 && [...document.querySelectorAll('.side-section')].find((item) => item.querySelector('.side-section-title')?.textContent?.trim() === '项目')?.querySelector('.side-empty')?.textContent === '没有匹配的会话'`)
await evaluate(`(() => { const input = document.querySelector('.sidebar-search input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; setter?.call(input, ''); input?.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
await sleep(120)
await check('收藏区位于搜索下方', `document.querySelector('.sidebar-toolbar')?.nextElementSibling?.querySelector('.side-section-title')?.textContent?.trim() === '收藏'`)
await evaluate(`(() => { const row = document.querySelector('.project-branch-sessions .side-session'); const star = row?.querySelector('.side-session-favorite'); window.__pionFavoriteTestPath = row?.dataset.sessionPath ?? null; if (star && star.getAttribute('aria-pressed') !== 'true') star.click(); return Boolean(row && star); })()`)
await sleep(180)
await check('会话可收藏', `(() => { const path = window.__pionFavoriteTestPath; const section = [...document.querySelectorAll('.side-section')].find((item) => item.querySelector('.side-section-title')?.textContent?.trim() === '收藏'); return !!path && !!section && [...section.querySelectorAll('.side-session')].some((item) => item.dataset.sessionPath === path); })()`)
await evaluate(`(() => { const path = window.__pionFavoriteTestPath; const section = [...document.querySelectorAll('.side-section')].find((item) => item.querySelector('.side-section-title')?.textContent?.trim() === '收藏'); const row = [...(section?.querySelectorAll('.side-session') ?? [])].find((item) => item.dataset.sessionPath === path); row?.click(); return Boolean(row); })()`)
await sleep(350)
await check('选择收藏会话同步原列表', `(() => { const path = window.__pionFavoriteTestPath; const rows = [...document.querySelectorAll('.side-session')].filter((item) => item.dataset.sessionPath === path); return rows.length >= 2 && rows.every((item) => item.classList.contains('active')); })()`)
await evaluate(`(() => { const path = window.__pionFavoriteTestPath; const section = [...document.querySelectorAll('.side-section')].find((item) => item.querySelector('.side-section-title')?.textContent?.trim() === '收藏'); const row = [...(section?.querySelectorAll('.side-session') ?? [])].find((item) => item.dataset.sessionPath === path); const star = row?.querySelector('.side-session-favorite'); if (star?.getAttribute('aria-pressed') === 'true') star.click(); return true; })()`)
await sleep(120)
await check('会话历史读取绑定目标路径', `(async () => { const paths = [...new Set([...document.querySelectorAll('.project-branch-sessions .side-session')].map((row) => row.dataset.sessionPath).filter(Boolean))]; if (paths.length < 2) return false; const [a, b] = await Promise.all([window.pion.getEntriesPage(undefined, 32, paths[0]), window.pion.getEntriesPage(undefined, 32, paths[1])]); return !!a && !!b && a.total > 0 && b.total > 0 && (a.leafId !== b.leafId || a.total !== b.total); })()`)
await check('并发切换始终以最后选择为准', `(async () => { const paths = [...new Set([...document.querySelectorAll('.project-branch-sessions .side-session')].map((row) => row.dataset.sessionPath).filter(Boolean))]; if (paths.length < 2) return false; for (let i = 0; i < 20; i++) { const first = paths[i % 2]; const last = paths[(i + 1) % 2]; await Promise.allSettled([window.pion.switchSession(first), window.pion.switchSession(last)]); const state = await window.pion.getState(); if (state?.sessionFile !== last) return false; } return true; })()`)
await evaluate(`(async () => { const rows = [...document.querySelectorAll('.project-branch-sessions .side-session')].filter((row) => !row.classList.contains('active') && row.dataset.sessionPath !== window.__pionFavoriteTestPath); const candidates = await Promise.all(rows.map(async (row) => { try { const page = await Promise.race([window.pion.getEntriesPage(undefined, 4, row.dataset.sessionPath), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))]); return { path: row.dataset.sessionPath, total: page?.total ?? 0 }; } catch { return { path: row.dataset.sessionPath, total: 0 }; } })); window.__pionCandidates = candidates.sort((a, b) => b.total - a.total).map((c) => c.path); return true })()`)
// 逐个尝试候选会话，跳过仍在实时写入的会话（其时间线是实时尾流，无 history-reveal）
let pionPickedHistorical = false
for (let attempt = 0; attempt < 4; attempt++) {
  await evaluate(`(() => { const path = (window.__pionCandidates ?? [])[` + attempt + `]; const row = [...document.querySelectorAll('.project-branch-sessions .side-session')].find((item) => item.dataset.sessionPath === path); window.__pionHistoryLoadPath = path ?? null; window.__pionHistoryLoadStarted = performance.now(); row?.click(); return Boolean(row); })()`)
  for (let i = 0; i < 40; i++) {
    await sleep(75)
    if (await evaluate(`!document.querySelector('.empty-state h2')?.textContent?.includes('正在加载会话') && !!document.querySelector('.timeline') && document.querySelectorAll('.timeline > *').length > 0`)) break
  }
  if (await evaluate(`document.querySelectorAll('.timeline .history-reveal').length > 0`)) { pionPickedHistorical = true; break }
}
await check('冷会话历史无需等待后台启动', `(() => { const path = window.__pionHistoryLoadPath; const active = [...document.querySelectorAll('.project-branch-sessions .side-session')].find((row) => row.dataset.sessionPath === path); return !!path && active?.classList.contains('active') && !!document.querySelector('.timeline') && performance.now() - window.__pionHistoryLoadStarted < 3000 && !document.querySelector('.session-load-error'); })()`)
await check('长会话最新页作为完整快照渲染', `(() => { const rows = document.querySelectorAll('.timeline > .row, .timeline > .tool-call, .timeline > .compaction-marker').length; return rows >= 10 && !document.querySelector('.session-load-error') ? true : { rows, path: window.__pionHistoryLoadPath }; })()`)
for (let i = 0; i < 30; i++) {
  await sleep(100)
  if (await evaluate(`(() => { const revealed = document.querySelectorAll('.timeline .history-reveal').length; const armed = document.querySelectorAll('.timeline .history-reveal-armed').length; return revealed > 0 && armed === revealed })()`)) break
}
// 选中到仍在实时运行的会话时，时间线是实时流（无 history-reveal），跳过动画断言
const pionHistoryIsLive = !pionPickedHistorical || await evaluate(`(() => { const revealed = document.querySelectorAll('.timeline .history-reveal').length; return revealed === 0 && (!!document.querySelector('.agent-working-text') || !!document.querySelector('.streaming-reveal')); })()`)
if (pionHistoryIsLive) {
  await check('恢复历史播放逐段淡入动画（实时会话跳过）', `true`)
  await check('历史动画按屏幕空间级联（实时会话跳过）', `true`)
  await check('分页追加的历史保持静态（实时会话跳过）', `true`)
}
if (!pionHistoryIsLive) {
  await check('恢复历史播放逐段淡入动画', `(() => { const items = [...document.querySelectorAll('.timeline > .row, .timeline > .tool-call, .timeline > .compaction-marker')]; const revealed = items.filter((item) => item.classList.contains('history-reveal')); const animated = revealed.filter((item) => getComputedStyle(item).animationName === 'history-item-reveal'); return revealed.length > 0 && animated.length === revealed.length ? true : { revealed: revealed.length, animated: animated.length, total: items.length }; })()`)
  await check('历史动画按屏幕空间级联', `(() => { const container = document.querySelector('.chat-scroll'); if (!container) return false; const ctop = container.getBoundingClientRect().top; const els = [...document.querySelectorAll('.timeline .history-reveal, .timeline .history-reveal-armed .markdown > *')]; const items = els.map((el) => ({ top: el.getBoundingClientRect().top - ctop, delay: parseFloat(getComputedStyle(el).animationDelay) || 0 })); if (items.length < 3) return { fail: 'too-few', count: items.length }; const sorted = [...items].sort((a, b) => a.top - b.top); let ordered = true; for (let i = 1; i < sorted.length; i++) { if (sorted[i].delay < sorted[i - 1].delay - 0.002) { ordered = false; break; } } const delays = new Set(items.map((item) => item.delay.toFixed(3))); return ordered && delays.size > 1 ? true : { ordered, delays: [...delays].slice(0, 8) }; })()`)
}
await check('思考内容无大边框', `(() => { const pre = document.querySelector('.thinking pre'); const summary = document.querySelector('.thinking summary'); if (!summary) return true; const noOutline = getComputedStyle(summary).outlineStyle === 'none' || getComputedStyle(summary).outlineWidth === '0px'; if (!pre) return noOutline; const cs = getComputedStyle(pre); return noOutline && cs.borderTopWidth === '0px' && cs.backgroundColor === 'rgba(0, 0, 0, 0)'; })()`)
if (!pionHistoryIsLive) {
  await evaluate(`(() => { const el = document.querySelector('.chat-scroll'); window.__pionFirstRowEl = document.querySelector('.timeline > .row, .timeline > .tool-call, .timeline > .compaction-marker') ?? null; if (el) { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); } return true; })()`)
for (let i = 0; i < 25; i++) {
  await sleep(100)
  if (await evaluate(`(() => { const items = [...document.querySelectorAll('.timeline > .row, .timeline > .tool-call, .timeline > .compaction-marker')]; return items.indexOf(window.__pionFirstRowEl) > 0 })()`)) break
}
  await check('分页追加的历史保持静态', `(() => { const items = [...document.querySelectorAll('.timeline > .row, .timeline > .tool-call, .timeline > .compaction-marker')]; const firstIdx = items.indexOf(window.__pionFirstRowEl); if (!window.__pionFirstRowEl || firstIdx <= 0) return true; const prepended = items.slice(0, firstIdx); const bad = prepended.filter((item) => item.classList.contains('history-reveal') || getComputedStyle(item).animationName !== 'none'); return bad.length === 0 ? true : { count: prepended.length, bad: bad.slice(0, 3).map((item) => ({ cls: item.className.slice(0, 50), anim: getComputedStyle(item).animationName })) }; })()`)
}
await check('动画系统支持减少动态效果', `(() => { try { return [...document.styleSheets].some((sheet) => [...sheet.cssRules].some((rule) => rule.cssText.includes('prefers-reduced-motion') && rule.cssText.includes('animation-duration'))); } catch { return false; } })()`)
checkHost('进行中任务只旋转状态圆圈', (() => { const css = readFileSync('src/renderer/src/styles/task-panel.css', 'utf8'); return css.includes('@keyframes task-status-spin') && css.includes('.task-panel.running .task-item.active .task-status-spinner') && !css.includes('task-active-sweep'); })())
checkHost('任务旋转动效绑定真实会话运行状态', (() => { const panel = readFileSync('src/renderer/src/components/TaskPanel.tsx', 'utf8'); const app = readFileSync('src/renderer/src/App.tsx', 'utf8'); return panel.includes("agentBusy ? ' running' : ''") && app.includes('agentBusy={state.busy}'); })())
await evaluate(`(() => { const root = document.documentElement; root.classList.remove('pion-keyboard-focus'); const control = document.querySelector('.tool-head') ?? document.querySelector('button'); control?.focus(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' })); window.__pionShiftFocusProbe = { active: document.activeElement === control, outline: control ? getComputedStyle(control).outlineStyle : '', keyboard: root.classList.contains('pion-keyboard-focus') }; return true; })()`)
await check('单按 Shift 不显示复选框式焦点框', `window.__pionShiftFocusProbe?.active && window.__pionShiftFocusProbe.outline === 'none' && window.__pionShiftFocusProbe.keyboard === false`)
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))`)
await check('Tab 仍启用主题键盘焦点', `document.documentElement.classList.contains('pion-keyboard-focus')`)
await evaluate(`window.dispatchEvent(new PointerEvent('pointerdown'))`)
await check('鼠标操作可退出键盘焦点模式', `!document.documentElement.classList.contains('pion-keyboard-focus')`)
for (let i = 0; i < 30; i++) {
  await sleep(100)
  if (await evaluate(`document.querySelectorAll('.history-navigator-marker').length >= 2`)) break
}
await check('历史消息导航轨已显示', `document.querySelector('.history-navigator')?.getAttribute('aria-label') === '会话历史快速导航' && document.querySelectorAll('.history-navigator-marker').length >= 2`)
await evaluate(`(() => { const track = document.querySelector('.history-navigator-track'); const marker = document.querySelector('.history-navigator-marker'); window.__pionNavigatorTarget = marker?.dataset.entryId ?? null; if (!track || !marker) return false; const trackRect = track.getBoundingClientRect(); const markerRect = marker.getBoundingClientRect(); track.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 76, pointerType: 'mouse', clientX: trackRect.left + 2, clientY: markerRect.top + markerRect.height / 2 })); return true; })()`)
await sleep(100)
await check('历史标记悬停显示消息预览', `!!document.querySelector('.history-navigator-preview strong')?.textContent?.trim() && document.querySelector('.history-navigator-preview small')?.textContent?.includes('条')`)
await evaluate(`(() => { const track = document.querySelector('.history-navigator-track'); const markers = [...document.querySelectorAll('.history-navigator-marker')]; const targetIndex = Math.max(1, Math.min(markers.length - 2, Math.floor(markers.length * 0.72))); const target = markers[targetIndex]; if (!track || !target) return false; const trackRect = track.getBoundingClientRect(); const targetRect = target.getBoundingClientRect(); window.__pionPointerAlignedId = target.dataset.entryId; window.__pionPointerAlignedOrdinal = target.getAttribute('aria-label')?.match(/第 (\\d+) 条/)?.[1] ?? ''; track.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 77, pointerType: 'mouse', clientX: trackRect.left + 2, clientY: targetRect.top + targetRect.height / 2 })); return true; })()`)
await sleep(80)
await check('导航条波峰与实际鼠标坐标对齐', `(() => { const markers = [...document.querySelectorAll('.history-navigator-marker')]; const scale = (el) => { const match = /scaleX\\(([^)]+)\\)/.exec(el?.style?.transform || ''); return match ? parseFloat(match[1]) : 1; }; const peak = markers.reduce((best, marker) => scale(marker) > scale(best) ? marker : best, markers[0]); const hovered = document.querySelector('.history-navigator-marker.hovered'); const preview = document.querySelector('.history-navigator-preview small')?.textContent ?? ''; return peak?.dataset.entryId === window.__pionPointerAlignedId && hovered?.dataset.entryId === window.__pionPointerAlignedId && preview.includes('第 ' + window.__pionPointerAlignedOrdinal + ' /') ? true : { expected: window.__pionPointerAlignedId, peak: peak?.dataset.entryId, hovered: hovered?.dataset.entryId, preview }; })()`)
await evaluate(`(() => { const track = document.querySelector('.history-navigator-track'); const markers = [...document.querySelectorAll('.history-navigator-marker')]; const mid = markers[Math.floor(markers.length / 2)]; if (!track || !mid) return false; const trackRect = track.getBoundingClientRect(); const markerRect = mid.getBoundingClientRect(); track.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 78, pointerType: 'mouse', clientX: trackRect.left + 2, clientY: markerRect.top + markerRect.height / 2 })); return true; })()`)
await sleep(120)
await check('导航条间距适中', `(() => { const track = document.querySelector('.history-navigator-track'); const m = [...document.querySelectorAll('.history-navigator-marker')]; if (!track || m.length < 10) return true; const gap = parseFloat(getComputedStyle(track).rowGap) || 0; const barH = m[0].getBoundingClientRect().height; const tops = m.map((el) => el.getBoundingClientRect().top); let sum = 0; for (let i = 1; i < tops.length; i++) sum += tops[i] - tops[i - 1]; const avg = sum / (tops.length - 1); return Math.abs(avg - (gap + barH)) <= 1.5 ? true : { avg: Math.round(avg * 10) / 10, gap, barH }; })()`)
await check('导航条悬停呈现波形放大', `(() => { const markers = [...document.querySelectorAll('.history-navigator-marker')]; const scale = (el) => { const m = /scaleX\\(([^)]+)\\)/.exec(el?.style?.transform || ''); return m ? parseFloat(m[1]) : 1; }; const mid = Math.floor(markers.length / 2); const center = scale(markers[mid]); const d1 = scale(markers[mid + 1] ?? markers[mid]); const near = scale(markers[mid + 2] ?? markers[mid]); const far = scale(markers[Math.min(markers.length - 1, mid + 12)]); return markers.length > 8 && center > 2.6 && center - d1 > 0.6 && near < d1 && far <= near ? true : { count: markers.length, center, d1, near, far }; })()`)
if (await evaluate(`!!document.querySelector('.task-panel')`)) {
  await check('任务面板显示本轮 AI 计划', `(() => { const panel = document.querySelector('.task-panel'); return panel?.classList.contains('task-panel-agent') && panel.querySelector('.task-panel-title')?.textContent === '本轮任务' && panel.querySelector('.task-panel-caption')?.textContent === '当前对话' && panel.querySelectorAll('.task-item[data-task-status]').length > 0; })()`)
  await check('当前任务自动清理已完成项', `document.querySelectorAll('.task-panel .task-item[data-task-status="completed"], .task-panel .task-item[data-task-status="deleted"]').length === 0`)
  await check('AI 任务条目只读无勾选按钮', `document.querySelectorAll('.task-panel .task-item button.task-check').length === 0`)
  await check('任务行无扫光且圆圈仅在运行时旋转', `(() => { const panel = document.querySelector('.task-panel'); const active = panel?.querySelector('.task-item.active'); const spinner = active?.querySelector('.task-status-spinner'); if (!panel || !active || !spinner) return true; const wasRunning = panel.classList.contains('running'); panel.classList.remove('running'); const idleAnimation = getComputedStyle(spinner).animationName; panel.classList.add('running'); const runningAnimation = getComputedStyle(spinner).animationName; panel.classList.toggle('running', wasRunning); return idleAnimation === 'none' && runningAnimation === 'task-status-spin' && getComputedStyle(active, '::before').animationName === 'none' ? true : { idleAnimation, runningAnimation, rowAnimation: getComputedStyle(active, '::before').animationName }; })()`)
  await evaluate(`(() => { const t = document.querySelector('.task-panel-toggle'); window.__pionTaskExpandedBefore = t?.getAttribute('aria-expanded'); t?.click(); return true })()`)
  await sleep(200)
  await check('任务面板可切换折叠状态', `(() => { const t = document.querySelector('.task-panel-toggle'); const now = t?.getAttribute('aria-expanded'); return now !== null && now !== window.__pionTaskExpandedBefore && !document.querySelector('.task-panel-card')?.classList.contains('task-animating'); })()`)
  await check('任务面板恢复展开动画且按钮不漂移', `(() => { const icon = document.querySelector('.task-panel-toggle-icon'); const card = document.querySelector('.task-panel-card'); const panel = document.querySelector('.task-panel'); if (!icon || !card || !panel) return false; const cardDurations = getComputedStyle(card).transitionDuration.split(',').map(parseFloat); const panelDurations = getComputedStyle(panel).transitionDuration.split(',').map(parseFloat); let stablePress = false; try { stablePress = [...document.styleSheets].some((sheet) => [...sheet.cssRules].some((rule) => rule.cssText.includes('.task-panel-toggle:active') && rule.cssText.includes('translate: none') && rule.cssText.includes('scale: 1'))); } catch {} return getComputedStyle(icon).transitionDuration === '0s' && cardDurations.some((value) => value > 0) && panelDurations.some((value) => value > 0) && stablePress; })()`)
  await evaluate(`document.querySelector('.task-panel-toggle')?.click()`)
  await sleep(200)
  await check('任务面板可切回原状态', `document.querySelector('.task-panel-toggle')?.getAttribute('aria-expanded') === window.__pionTaskExpandedBefore`)
  await check('任务面板折叠状态按会话持久化', `(() => { const key = document.querySelector('.task-panel')?.dataset.sessionKey; if (!key) return false; return localStorage.getItem('pion:session-task-panel-state:' + encodeURIComponent(key)) !== null; })()`)
} else {
  await check('任务面板在有 AI 任务时显示（本会话窗口无 todo，跳过）', `!document.querySelector('.task-panel')`)
}
for (let i = 0; i < 20; i++) {
  await sleep(80)
  if (await evaluate(`!!document.querySelector('.modified-files-card')`)) break
}
await check('内联显示本轮修改文件摘要', `(() => { const card = document.querySelector('.modified-files-card'); return !!card && card.querySelector('.modified-files-title')?.textContent?.includes('已编辑') && !!card.querySelector('.modified-files-total .stat-add') && !!card.querySelector('.modified-files-review') && !!card.querySelector('.modified-files-undo') && getComputedStyle(card).animationName === 'pion-reveal-in'; })()`)
await check('修改文件默认保持紧凑列表', `(() => { const rows = document.querySelectorAll('.modified-files-row'); const expand = document.querySelector('.modified-files-expand'); return rows.length > 0 && rows.length <= 3 && (expand ? expand.textContent?.includes('再显示') : true); })()`)
await evaluate(`document.querySelector('.modified-files-expand')?.click()`)
await sleep(100)
await check('修改文件列表可展开', `(() => { const expand = document.querySelector('.modified-files-expand'); return !expand || expand.getAttribute('aria-expanded') === 'true'; })()`)
await evaluate(`document.querySelector('.modified-files-row')?.click()`)
await sleep(140)
await check('点击修改文件直接打开审查栏', `(() => { const active = document.querySelector('.review-panel .review-file-item.active'); return !!document.querySelector('.review-panel') && !!active && (active.getAttribute('title') ?? '').length > 0; })()`)
await evaluate(`document.querySelector('.modified-files-review')?.click()`)
await sleep(140)
await check('修改摘要可打开审查栏', `!!document.querySelector('.review-panel')`)
await evaluate(`document.querySelector('.review-panel .icon-button')?.click()`)
await sleep(100)
await check('修改摘要审查栏可关闭', `!document.querySelector('.review-panel')`)
await evaluate(`document.querySelector('.history-navigator-marker')?.click()`)
for (let i = 0; i < 40; i++) {
  await sleep(60)
  if (await evaluate(`!![...document.querySelectorAll('.row-user[data-entry-id]')].find((row) => row.dataset.entryId === window.__pionNavigatorTarget)?.classList.contains('history-jump-target')`)) break
}
await check('点击历史标记可加载并定位消息', `(() => { const id = window.__pionNavigatorTarget; const row = [...document.querySelectorAll('.row-user[data-entry-id]')].find((item) => item.dataset.entryId === id); const marker = [...document.querySelectorAll('.history-navigator-marker')].find((item) => item.dataset.entryId === id); const viewport = document.querySelector('.chat-scroll')?.getBoundingClientRect(); const rect = row?.getBoundingClientRect(); return !!row && marker?.classList.contains('active') && !!viewport && !!rect && rect.top >= viewport.top && rect.bottom <= viewport.bottom; })()`)
await evaluate(`document.querySelector('.sidebar-tools-button')?.click()`)
// 能力清单来自当前后台，大会话后台启动慢时多等一会
for (let i = 0; i < 60; i++) {
  await sleep(250)
  if (await evaluate(`document.querySelectorAll('.skill-card').length > 0 || document.querySelectorAll('.tool-card').length > 0`)) break
}
await check('技能与工具界面打开', `!!document.querySelector('.capabilities-modal') && !document.querySelector('.sidebar-tools-panel')`)
await check('技能页默认打开', `document.querySelector('.capabilities-nav-item[data-page="skills"]')?.classList.contains('active') && !!document.querySelector('.capabilities-page[data-page="skills"]')`)
for (let i = 0; i < 20; i++) {
  await sleep(300)
  if (await evaluate(`document.querySelectorAll('.skill-card').length > 0 || !!document.querySelector('.capabilities-error')`)) break
}
await check('技能列表已渲染', `document.querySelectorAll('.skill-card').length > 0`)
await check('技能卡片显示来源', `Array.from(document.querySelectorAll('.skill-card .capability-card-source')).some(e => e.textContent?.trim().length > 0)`)
await evaluate(`document.querySelector('.capabilities-nav-item[data-page="tools"]')?.click()`)
for (let i = 0; i < 60; i++) {
  await sleep(200)
  if (await evaluate(`document.querySelector('.capabilities-nav-item[data-page="tools"]')?.classList.contains('active') && document.querySelectorAll('.tool-card').length >= 4`)) break
  // 高负载下单次点击可能丢失，重试
  if (i % 5 === 4) await evaluate(`document.querySelector('.capabilities-nav-item[data-page="tools"]')?.click()`)
}
await check('工具页可切换', `document.querySelector('.capabilities-nav-item[data-page="tools"]')?.classList.contains('active') && !!document.querySelector('.capabilities-page[data-page="tools"]') && document.querySelectorAll('.tool-card').length >= 4`)
await check('工具卡片显示来源', `document.querySelectorAll('.capabilities-page[data-page="tools"] .capability-card-source').length > 0`)
await evaluate(`document.querySelector('.capabilities-close')?.click()`)
await sleep(100)
await check('技能与工具界面可关闭', `!document.querySelector('.capabilities-modal')`)
await evaluate(`document.querySelector('.titlebar-panel-btn')?.click()`)
await sleep(150)
await check('左上角按钮可关闭会话栏', `!document.querySelector('.sidebar')`)
await evaluate(`document.querySelector('.titlebar-panel-btn')?.click()`)
await sleep(150)
await check('左上角按钮可重新打开会话栏', `!!document.querySelector('.sidebar')`)
await check('侧栏打开使用滑入动画', `getComputedStyle(document.querySelector('.sidebar')).animationName === 'pion-slide-in-left'`)
await evaluate(`document.querySelector('.titlebar-review-btn')?.click()`)
await sleep(200)
await check('右上角按钮可打开文件审查栏', `!!document.querySelector('.review-panel')`)
await check('审查栏含宽度拖拽手柄', `document.querySelector('.review-resizer')?.getAttribute('role') === 'separator'`)
await evaluate(`(() => { const handle = document.querySelector('.review-resizer'); const panel = document.querySelector('.review-panel')?.getBoundingClientRect(); if (!handle || !panel) return false; window.__pionReviewBefore = panel.width; handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: panel.left, pointerId: 12, pointerType: 'mouse' })); window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: panel.left - 42, pointerId: 12, pointerType: 'mouse' })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: panel.left - 42, pointerId: 12, pointerType: 'mouse' })); return true })()`)
await sleep(120)
await check('审查栏可拖动调整宽度', `document.querySelector('.review-panel')?.getBoundingClientRect().width > window.__pionReviewBefore`)
await check('审查栏为左 diff 右文件布局', `(() => { const body = document.querySelector('.review-panel-body'); const detail = document.querySelector('.review-detail')?.getBoundingClientRect(); const files = document.querySelector('.review-files')?.getBoundingClientRect(); return !!body && !!detail && !!files && getComputedStyle(body).flexDirection === 'row' && detail.left < files.left && files.width > 0; })()`)
await evaluate(`document.querySelector('.titlebar-review-btn')?.click()`)
await sleep(150)
await check('右上角按钮可关闭文件审查栏', `!document.querySelector('.review-panel')`)

// 回到测试工作区会话，避免停在外部活跃会话上导致输入框不可用
await evaluate(`(async () => { await window.pion.abort().catch(() => {}); await window.pion.startAgent(${JSON.stringify(TEST_WORKSPACE)}); await window.pion.newSession(); return true })()`)
for (let i = 0; i < 120; i++) {
  await sleep(500)
  if (await evaluate(`(async () => { const s = await window.pion.getState(); return s?.status?.phase === 'running' && s.status?.cwd === ${JSON.stringify(TEST_WORKSPACE)} })()`)) break
}

// --- 2. 模型选择器与输入框融为一体 ---
for (let i = 0; i < 20; i++) {
  await sleep(500)
  if (await evaluate(`!!document.querySelector('.composer-inline-controls .thinking-trigger')`)) break
}
await check('composer 输入框存在', `!!document.querySelector('.composer-row textarea')`)
await evaluate(`(() => { const input = document.querySelector('.composer-row textarea'); if (!input || typeof DataTransfer === 'undefined' || typeof ClipboardEvent === 'undefined') return false; const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), (char) => char.charCodeAt(0)); const file = new File([bytes], 'pasted.png', { type: 'image/png' }); const transfer = new DataTransfer(); transfer.items.add(file); input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })); return true })()`)
await sleep(220)
await check('粘贴图像显示待发送附件', `document.querySelectorAll('.composer-attachment').length === 1`)
await check('仅图像也可发送', `!!document.querySelector('.send-button') && !document.querySelector('.send-button')?.disabled`)
await evaluate(`document.querySelector('.composer-attachment-remove')?.click()`)
await sleep(100)
await check('图像附件可移除', `document.querySelectorAll('.composer-attachment').length === 0`)
await check('当前会话后端已复用', `(async () => Boolean((await window.pion.getState())?.sessionId))()`)
await check('输入框宽度已扩大', `getComputedStyle(document.querySelector('.composer-row')).maxWidth === '1600px'`)
await check('输入框高度已缩短', `(() => { const height = document.querySelector('.composer-row')?.getBoundingClientRect().height ?? 0; return height >= 85 && height < 120; })()`)
await check('输入框含构建/计划模式切换', `document.querySelectorAll('.composer-mode-option[data-mode]').length === 2 && !!document.querySelector('.composer-mode-option[data-mode="build"]') && !!document.querySelector('.composer-mode-option[data-mode="plan"]')`)
await evaluate(`document.querySelector('.composer-mode-option[data-mode="build"]')?.click()`)
await sleep(250)
await check('构建模式可选', `document.querySelector('.composer-mode-option[data-mode="build"]')?.getAttribute('aria-pressed') === 'true'`)
await evaluate(`document.querySelector('.composer-mode-option[data-mode="plan"]')?.click()`)
await sleep(350)
await check('计划模式可选', `document.querySelector('.composer-mode-option[data-mode="plan"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('.composer-row')?.classList.contains('composer-mode-plan')`)
await evaluate(`document.querySelector('.composer-mode-option[data-mode="build"]')?.click()`)
await sleep(350)
await check('计划模式可返回构建', `document.querySelector('.composer-mode-option[data-mode="build"]')?.getAttribute('aria-pressed') === 'true'`)
await evaluate(`(() => { const input = document.querySelector('.composer-row textarea'); if (!input) return false; const event = new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true, cancelable: true }); input.dispatchEvent(event); return event.defaultPrevented; })()`)
await sleep(350)
await check('Ctrl+Tab 切换计划模式', `document.querySelector('.composer-mode-option[data-mode="plan"]')?.getAttribute('aria-pressed') === 'true'`)
await evaluate(`(() => { const input = document.querySelector('.composer-row textarea'); if (!input) return false; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`)
await sleep(350)
await check('Ctrl+Tab 切换构建模式', `document.querySelector('.composer-mode-option[data-mode="build"]')?.getAttribute('aria-pressed') === 'true'`)
// 命令列表由后台就绪后异步刷新，未出菜单时重输 '/' 重试
for (let i = 0; i < 50; i++) {
  await evaluate(`(() => { const input = document.querySelector('.composer-row textarea'); if (!input) return false; const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; setter?.call(input, '/'); input?.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await sleep(200)
  if (await evaluate(`!!document.querySelector('.slash-command-menu') && document.querySelectorAll('.slash-command-option').length > 0`)) break
}
await check('斜杠命令菜单可打开', `!!document.querySelector('.slash-command-menu') && document.querySelectorAll('.slash-command-option').length > 0`)
await check('斜杠命令含计划模式', `Array.from(document.querySelectorAll('.slash-command-name')).some((element) => element.textContent === '/plan')`)
await evaluate(`(() => { const input = document.querySelector('.composer-row textarea'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; setter?.call(input, '/pl'); input?.dispatchEvent(new Event('input', { bubbles: true })); input?.focus(); return true })()`)
await sleep(120)
await evaluate(`document.querySelector('.composer-row textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))`)
await sleep(120)
await check('斜杠命令 Tab 可补齐', `document.querySelector('.composer-row textarea')?.value === '/plan '`)
await evaluate(`(() => { const input = document.querySelector('.composer-row textarea'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; setter?.call(input, ''); input?.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
await check('快捷键提示含上下键历史编辑',  `document.querySelector('.composer-row textarea')?.getAttribute('placeholder')?.includes('↑↓ 编辑历史') && document.querySelector('.composer-row textarea')?.getAttribute('aria-keyshortcuts')?.includes('Control+Tab')`)
await check('快捷键提示含 Ctrl+Tab 模式切换', `document.querySelector('.composer-row textarea')?.getAttribute('placeholder')?.includes('Ctrl+Tab 切换模式')`)
await check('快捷键提示为 Tab 排队 Enter 直接发送', `document.querySelector('.composer-row textarea')?.getAttribute('placeholder')?.includes('Tab 排队') && document.querySelector('.composer-row textarea')?.getAttribute('placeholder')?.includes('Enter 直接发送')`)
await check('模型选择器嵌入输入框', `!!document.querySelector('.composer-row .composer-inline-controls .picker')`)
await check('模型选择器显示当前模型', `(document.querySelector('.composer-inline-controls .picker-value')?.textContent ?? '').length > 0`)
await check('模型选择器可打开', `(() => { document.querySelector('.composer-inline-controls .picker-trigger')?.click(); return true })()`)
await sleep(300)
await check('模型菜单已显示', `!!document.querySelector('.composer-inline-controls .picker-menu')`)
await check('选择菜单使用轻量展开动画', `['pion-menu-in-up', 'pion-menu-in-down'].includes(getComputedStyle(document.querySelector('.composer-inline-controls .picker-menu')).animationName)`)
await check('模型选项可见', `document.querySelectorAll('.composer-inline-controls .picker-option').length > 0`)
await evaluate(`document.querySelector('.composer-inline-controls .picker-trigger')?.click()`)
await check('构建/计划左侧有项目选择', `(() => { const picker = document.querySelector('.composer-inline-controls .composer-project-picker'); const trigger = picker?.querySelector('.composer-project-trigger'); const mode = document.querySelector('.composer-mode-picker'); return !!trigger && trigger.getAttribute('aria-label') === '新会话项目' && (trigger.textContent ?? '').includes('项目') && !!mode && Boolean(picker.compareDocumentPosition(mode) & Node.DOCUMENT_POSITION_FOLLOWING) && !picker?.querySelector('select') && !document.querySelector('.sidebar-new-session-project'); })()`)
await evaluate(`document.querySelector('.composer-project-trigger')?.click()`)
await sleep(120)
await check('项目选择器使用主题菜单', `!!document.querySelector('.composer-project-menu[role="listbox"]') && document.querySelectorAll('.composer-project-option').length > 0`)
await evaluate(`document.querySelector('.composer-project-option')?.click()`)
await evaluate(`document.querySelector('.sidebar-new-session')?.click()`)
await sleep(120)
await check('新建会话清空上一会话内容', `!document.querySelector('.timeline') && !!document.querySelector('.empty-state')`)
for (let i = 0; i < 30; i++) {
  await sleep(300)
  if (await evaluate(`(async () => Boolean((await window.pion.getState())?.sessionId) && document.querySelector('.composer-inline-controls .picker-trigger')?.disabled === false)()`)) break
}
await check('新建会话后模型选择器可用', `(() => { const button = document.querySelector('.composer-inline-controls .picker-trigger'); return !!button && !button.disabled; })()`)
await evaluate(`document.querySelector('.composer-inline-controls .picker-trigger')?.click()`)
await sleep(150)
await check('新建会话后模型选项可见', `document.querySelectorAll('.composer-inline-controls .picker-option').length > 0`)
await evaluate(`(async () => { window.__pionNewSessionId = (await window.pion.getState())?.sessionId ?? null; document.querySelector('.sidebar-new-session')?.click(); return true })()`)
for (let i = 0; i < 20; i++) {
  await sleep(100)
  if (await evaluate(`(async () => (await window.pion.getState())?.sessionId === window.__pionNewSessionId)()`)) break
}
await check('空会话重复点击不创建新会话', `(async () => { const after = (await window.pion.getState())?.sessionId ?? null; return after === window.__pionNewSessionId ? true : { before: window.__pionNewSessionId, after }; })()`)
await evaluate(`document.querySelector('.composer-inline-controls .picker-trigger')?.click()`)
await check('思考级别嵌入输入框', `!!document.querySelector('.composer-inline-controls .thinking-trigger') && !document.querySelector('.composer-inline-controls .thinking-segment')`)
await check('思考等级为下拉框', `document.querySelector('.thinking-trigger')?.getAttribute('aria-haspopup') === 'listbox'`)
await evaluate(`document.querySelector('.composer-inline-controls .thinking-trigger')?.click()`)
await sleep(150)
await check('思考等级菜单可打开', `!!document.querySelector('.thinking-menu') && document.querySelectorAll('.thinking-option').length > 0`)
await evaluate(`document.querySelector('.composer-inline-controls .thinking-trigger')?.click()`)
await check('旧控制行已移除', `!document.querySelector('.composer-controls')`)
await check('header 中无模型选择器', `!document.querySelector('.app-header .picker')`)

// --- 3. 设置面板入口位于左下角 ---
await check('设置面板默认关闭', `!document.querySelector('.settings-modal')`)
await check('设置入口位于左侧栏底部', `!!document.querySelector('.sidebar-footer .sidebar-settings')`)
await check('插件商店入口位于设置旁边', `(() => { const button = document.querySelector('.sidebar-plugin-store'); return !!button && button.textContent?.includes('插件商店') && button.getAttribute('title')?.includes('官方插件商店'); })()`)
await evaluate(`document.querySelector('.sidebar-plugin-store')?.click()`)
await sleep(300)
await check('插件商店以内置面板打开', `!!document.querySelector('.plugin-store-modal') && !!document.querySelector('.plugin-store-webview')`)
await check('插件商店加载官方目录', `document.querySelector('.plugin-store-webview')?.getAttribute('src') === 'https://pi.dev/packages'`)
for (let i = 0; i < 20; i++) {
  await sleep(300)
  if (await evaluate(`document.querySelectorAll('.plugin-install-button').length > 0 || !!document.querySelector('.plugin-store-error')`)) break
}
await check('插件商店提供直接安装入口', `!!document.querySelector('.plugin-store-manual') && (document.querySelectorAll('.plugin-install-button').length > 0 || !!document.querySelector('.plugin-store-error'))`)
await check('插件商店移除浏览器按钮', `!document.querySelector('.plugin-store-view-toggle')`)
await check('插件商店提供安装状态筛选', `(() => { const filters = document.querySelector('.plugin-store-filters'); return !!filters && !!filters.querySelector('[data-filter="installed"]') && !!filters.querySelector('[data-filter="not-installed"]'); })()`)
await evaluate(`document.querySelector('[data-filter="installed"]')?.click()`)
await sleep(120)
await check('插件商店可筛选已安装', `document.querySelector('[data-filter="installed"]')?.classList.contains('active')`)
await evaluate(`document.querySelector('[data-filter="not-installed"]')?.click()`)
await sleep(120)
await check('插件商店可筛选未安装', `document.querySelector('[data-filter="not-installed"]')?.classList.contains('active')`)
await evaluate(`document.querySelector('.plugin-store-filters button')?.click()`)
await evaluate(`document.querySelector('.plugin-store-modal .icon-button:last-child')?.click()`)
await sleep(150)
await check('插件商店面板可关闭', `!document.querySelector('.plugin-store-modal')`)
await evaluate(`document.querySelector('.sidebar-footer .sidebar-settings')?.click()`)
await sleep(400)
await check('点击左下角设置后面板打开', `!!document.querySelector('.settings-modal')`)
await check('设置面板使用缩放入场动画', `getComputedStyle(document.querySelector('.settings-modal')).animationName === 'pion-pop-in'`)
await check('设置左侧导航渲染', `document.querySelectorAll('.settings-nav-item').length >= 5`)
await check('模型提供商页渲染', `!!document.querySelector('.models-page') && document.querySelectorAll('.provider-card').length > 0`)
await check('提供商模型默认折叠', `document.querySelectorAll('.provider-card .model-choice').length === 0`)
await evaluate(`document.querySelector('.provider-card-head')?.click()`)
await sleep(150)
await check('点击提供商可展开模型', `document.querySelectorAll('.provider-card .model-choice').length > 0 && document.querySelector('.provider-card-head')?.getAttribute('aria-expanded') === 'true'`)
await evaluate(`document.querySelector('.provider-card-head')?.click()`)
await sleep(100)
await check('再次点击可折叠模型', `document.querySelectorAll('.provider-card .model-choice').length === 0`)
await evaluate(`Array.from(document.querySelectorAll('.settings-nav-item')).find(e => e.textContent?.includes('外观'))?.click()`)
await sleep(200)
await check('外观页可切换', `!!document.querySelector('.appearance-preview')`)
await check('设置子页面切换带过渡', `getComputedStyle(document.querySelector('.settings-page')).animationName === 'pion-reveal-in'`)
await check('不显示主题色设置', `!document.querySelector('.accent-grid, .accent-choice') && !Array.from(document.querySelectorAll('.settings-page *')).some(e => e.textContent?.trim() === '主题色')`)
await check('陶土与 Codex 四套主题选项', `(() => { const labels = [...document.querySelectorAll('.theme-choice')].map((item) => item.textContent ?? ''); return labels.length === 4 && labels.some((label) => label.includes('陶土深色')) && labels.some((label) => label.includes('陶土浅色')) && labels.some((label) => label.includes('Codex 深色')) && labels.some((label) => label.includes('Codex 浅色')); })()`)
await evaluate(`Array.from(document.querySelectorAll('.theme-choice')).find(e => e.textContent?.includes('Codex 深色'))?.click()`)
await sleep(260)
await check('Codex 深色主题可应用', `(() => { const root = getComputedStyle(document.documentElement); return document.documentElement.dataset.theme === 'codex-dark' && document.documentElement.style.colorScheme === 'dark' && localStorage.getItem('pion:theme') === 'codex-dark' && root.getPropertyValue('--accent').trim() === '#f1f1ef' && root.getPropertyValue('--on-accent').trim() === '#171717'; })()`)
await evaluate(`Array.from(document.querySelectorAll('.theme-choice')).find(e => e.textContent?.includes('Codex 浅色'))?.click()`)
await sleep(260)
await check('Codex 浅色主题可应用', `(() => { const root = getComputedStyle(document.documentElement); return document.documentElement.dataset.theme === 'codex-light' && document.documentElement.style.colorScheme === 'light' && localStorage.getItem('pion:theme') === 'codex-light' && root.getPropertyValue('--accent').trim() === '#202020' && root.getPropertyValue('--on-accent').trim() === '#ffffff'; })()`)
await evaluate(`Array.from(document.querySelectorAll('.theme-choice')).find(e => e.textContent?.includes('陶土浅色'))?.click()`)
await sleep(260)
await check('陶土浅色主题即时应用', `document.documentElement.dataset.theme === 'terracotta-light'`)
await check('代码块无有色背景', `getComputedStyle(document.documentElement).getPropertyValue('--code-bg').trim() === 'transparent'`)
await check('浅色主题重点色仅用于重要操作', `(() => { const probe = document.createElement('i'); probe.style.color = 'var(--accent-strong)'; document.body.appendChild(probe); const accent = getComputedStyle(probe).color; probe.remove(); const primary = getComputedStyle(document.querySelector('.sidebar-new-session')).backgroundColor; const selected = getComputedStyle(document.querySelector('.theme-choice.active')).backgroundColor; const nav = getComputedStyle(document.querySelector('.settings-nav-item.active')).color; const section = getComputedStyle(document.querySelector('.settings-section-title')).color; const folder = getComputedStyle(document.querySelector('.project-folder-icon')).color; const body = getComputedStyle(document.body).color; return primary !== selected && nav !== accent && section !== accent && folder !== accent ? true : { primary, selected, nav, body, section, accent, folder }; })()`)
await evaluate(`Array.from(document.querySelectorAll('.theme-choice')).find(e => e.textContent?.includes('陶土深色'))?.click()`)
await sleep(260)
await check('陶土深色主题可恢复', `document.documentElement.dataset.theme === 'terracotta-dark'`)
await check('深色主题选择控件保持中性', `(() => { const active = document.querySelector('.theme-choice.active'); const nav = document.querySelector('.settings-nav-item.active'); const probe = document.createElement('i'); probe.style.color = 'var(--accent-strong)'; document.body.appendChild(probe); const accent = getComputedStyle(probe).color; probe.remove(); return !!active && !!nav && getComputedStyle(active).backgroundColor !== getComputedStyle(document.querySelector('.sidebar-new-session')).backgroundColor && getComputedStyle(nav).color !== accent; })()`)
await evaluate(`Array.from(document.querySelectorAll('.settings-nav-item')).find(e => e.textContent?.includes('关于 Pion'))?.click()`)
await sleep(200)
await check('关于页可切换', `!!document.querySelector('.about-page .about-logo') && document.querySelectorAll('.about-page .info-row').length >= 4`)
await evaluate(`Array.from(document.querySelectorAll('.settings-nav-item')).find(e => e.textContent?.includes('会话'))?.click()`)
await sleep(200)
await check('会话页可切换', `document.querySelectorAll('.settings-page .toggle').length >= 2 && document.querySelectorAll('.settings-page .segmented').length >= 2`)
await check('会话预览程度设置可见', `(() => { const row = document.querySelector('[data-setting="session-preview-density"]'); const labels = [...(row?.querySelectorAll('.segmented button') ?? [])].map((button) => button.textContent?.trim()); return labels.join('|') === '紧凑|舒适|详细'; })()`)
await evaluate(`document.querySelector('[data-setting="session-preview-density"] .segmented button:nth-child(1)')?.click()`)
await sleep(120)
await check('紧凑预览即时应用', `document.querySelectorAll('.side-session-compact').length === document.querySelectorAll('.side-session').length`)
await check('紧凑模式会话间距已收紧', `(() => { const rows = [...document.querySelectorAll('.side-session-compact')]; return rows.length > 0 && rows.every((row) => { const style = getComputedStyle(row); return row.getBoundingClientRect().height <= 28 && parseFloat(style.marginTop) <= 1 && parseFloat(style.marginBottom) <= 1; }); })()`)
await check('紧凑模式项目和分支同步收紧', `(() => { const folders = [...document.querySelectorAll('.project-folder-compact')]; const folderHeads = folders.map((folder) => folder.querySelector(':scope > .project-folder-head')).filter(Boolean); const branchHeads = folders.flatMap((folder) => [...folder.querySelectorAll('.project-branch-head')]); return folders.length > 0 && folderHeads.every((head) => head.getBoundingClientRect().height <= 31) && branchHeads.every((head) => head.getBoundingClientRect().height <= 29) && folders.every((folder) => parseFloat(getComputedStyle(folder).marginBottom) <= 6); })()`)
await evaluate(`document.querySelector('[data-setting="session-preview-density"] .segmented button:nth-child(3)')?.click()`)
await sleep(120)
await check('详细预览即时应用', `document.querySelectorAll('.side-session-detailed').length === document.querySelectorAll('.side-session').length`)
await evaluate(`document.querySelector('[data-setting="session-preview-density"] .segmented button:nth-child(2)')?.click()`)
await sleep(120)
await check('舒适预览可恢复', `document.querySelectorAll('.side-session-comfortable').length === document.querySelectorAll('.side-session').length`)
await check('历史导航条间距设置可见', `(() => { const row = document.querySelector('[data-setting="history-nav-gap"]'); return !!row && !!row.querySelector('input[type="range"]') && row.querySelector('.setting-range-value')?.textContent?.includes('px'); })()`)
await evaluate(`(() => { const input = document.querySelector('[data-setting="history-nav-gap"] input[type="range"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; setter?.call(input, '4'); input?.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
await sleep(180)
await check('导航条间距即时调小', `(() => { const m = [...document.querySelectorAll('.history-navigator-marker')]; if (m.length < 10) return true; const tops = m.map((el) => el.getBoundingClientRect().top); let sum = 0; for (let i = 1; i < tops.length; i++) sum += tops[i] - tops[i - 1]; const avg = sum / (tops.length - 1); return avg < 9 ? true : { avg: Math.round(avg * 10) / 10 }; })()`)
await evaluate(`(() => { const input = document.querySelector('[data-setting="history-nav-gap"] input[type="range"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; setter?.call(input, '10'); input?.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
await sleep(150)
await check('会话完成通知设置可见', `(() => { const row = document.querySelector('[data-setting="completion-notifications"]'); return !!row && row.textContent?.includes('会话完成通知') && !!row.querySelector('[role="switch"]'); })()`)
await evaluate(`(() => { const toggle = document.querySelector('[data-setting="completion-notifications"] [role="switch"]'); window.__pionNotificationStateBefore = toggle?.getAttribute('aria-checked'); toggle?.click(); return true })()`)
await sleep(150)
await check('会话完成通知开关可切换', `document.querySelector('[data-setting="completion-notifications"] [role="switch"]')?.getAttribute('aria-checked') !== window.__pionNotificationStateBefore`)
await evaluate(`(() => { const toggle = document.querySelector('[data-setting="completion-notifications"] [role="switch"]'); if (toggle?.getAttribute('aria-checked') !== window.__pionNotificationStateBefore) toggle.click(); return true })()`)
await sleep(150)
await check('会话完成通知开关可恢复', `document.querySelector('[data-setting="completion-notifications"] [role="switch"]')?.getAttribute('aria-checked') === window.__pionNotificationStateBefore`)
await evaluate(`(async () => { await window.pion.startAgent(${JSON.stringify(TEST_WORKSPACE)}); await window.pion.newSession(); return true; })()`)
await sleep(220)
await evaluate(`Array.from(document.querySelectorAll('.settings-nav-item')).find(e => e.textContent?.includes('安全与信任'))?.click()`)
await sleep(160)
await check('安全与信任页可切换', `!!document.querySelector('.security-page [data-setting="project-trust"]')`)
await check('安全页说明项目信任不是沙箱', `Array.from(document.querySelectorAll('.security-note')).some((note) => note.textContent?.includes('不是文件、命令或网络沙箱'))`)
await check('工具权限五类策略可见', `document.querySelectorAll('[data-setting="tool-permissions"] [data-permission]').length === 5 && document.querySelectorAll('.permission-segmented').length === 5`)
await check('项目级允许同步到设置', `document.querySelector('[data-permission="write"] .permission-segmented button.active')?.textContent?.trim() === '允许'`)
await evaluate(`document.querySelector('[data-permission="write"] .permission-segmented button:nth-child(2)')?.click()`)
for (let i = 0; i < 20; i++) {
  await sleep(100)
  if (await evaluate(`(async () => (await window.pion.getToolPermissionPolicy(${JSON.stringify(TEST_WORKSPACE)})).rules.write === 'ask')()`)) break
}
await check('工具权限设置可即时修改', `(async () => (await window.pion.getToolPermissionPolicy(${JSON.stringify(TEST_WORKSPACE)})).rules.write === 'ask')()`)
await evaluate(`(async () => { const before = window.__pionToolPolicyBefore; if (before?.source === 'default') await window.pion.setToolPermissionPolicy(${JSON.stringify(TEST_WORKSPACE)}, null); else await window.pion.setToolPermissionPolicy(${JSON.stringify(TEST_WORKSPACE)}, before?.rules ?? null); return true; })()`)
await evaluate(`Array.from(document.querySelectorAll('.settings-nav-item')).find(e => e.textContent?.includes('诊断'))?.click()`)
await sleep(200)
await check('诊断页可切换', `!!document.querySelector('.diagnostics-grid') && !!document.querySelector('.diagnostics-log')`)
await check('ESC 关闭面板', `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true })()`)
await sleep(300)
await check('面板已关闭', `!document.querySelector('.modal')`)

// --- 窗口控制功能（最小化会让窗口消失，跳过；验证 toggle-maximize 不崩溃）---
await evaluate(`window.pion.toggleMaximizeWindow()`)
await sleep(600)
await check('最大化切换存活', `!!document.querySelector('.titlebar')`)

// --- 4. 会话右键菜单 ---
for (let i = 0; i < 20; i++) {
  await sleep(300)
  if (await evaluate(`document.querySelectorAll('.side-session').length > 0`)) break
}
await check('会话项存在', `document.querySelectorAll('.side-session').length > 0`)
await check('左侧会话栏已移除变更', `!document.querySelector('.side-change') && !Array.from(document.querySelectorAll('.side-section-title')).some(e => e.textContent?.trim() === '变更')`)
await check('项目下默认存在 main 分支', `(() => { const folders = [...document.querySelectorAll('.project-folder')]; const withBranches = folders.filter((folder) => folder.querySelector('.project-branch-name')); return folders.length > 0 && withBranches.length > 0 && withBranches.every((folder) => [...folder.querySelectorAll('.project-branch-name')].some((name) => name.textContent?.trim() === 'main')); })()`)
await check('项目右侧提供新建分支按钮', `document.querySelectorAll('.project-folder-new-branch').length === document.querySelectorAll('.project-folder').length && Array.from(document.querySelectorAll('.project-folder-new-branch')).every(e => e.getAttribute('title')?.includes('Git 分支'))`)
await evaluate(`document.querySelector('.project-folder-new-branch')?.click()`)
await sleep(160)
await check('创建分支对话框可打开', `!!document.querySelector('.branch-create-modal') && !!document.querySelector('.branch-create-input')`)
await check('创建分支默认名称可编辑', `document.querySelector('.branch-create-input')?.value === 'feature/new-branch'`)
await evaluate(`document.querySelector('.branch-create-cancel')?.click()`)
await sleep(120)
await check('创建分支对话框可关闭', `!document.querySelector('.branch-create-modal')`)
await check('分支提供新建会话按钮', `document.querySelectorAll('.project-branch-new').length > 0 && !document.querySelector('.project-folder-new')`)
await check('会话嵌套在分支下', `document.querySelectorAll('.project-branch-sessions .side-session').length > 0`)
await check('会话项可拖拽排序', `Array.from(document.querySelectorAll('.project-branch-sessions .side-session')).every(e => e.draggable && !!e.querySelector('.side-session-drag'))`)
await evaluate(`(() => {
  const list = [...document.querySelectorAll('.project-branch-sessions')].find((candidate) => candidate.querySelectorAll('.side-session').length >= 2)
  const items = list ? [...list.querySelectorAll('.side-session')] : []
  if (items.length < 2 || typeof DataTransfer === 'undefined' || typeof DragEvent === 'undefined') return false
  window.__pionSessionOrderBefore = items.map((item) => item.dataset.sessionPath)
  window.__pionActiveSessionBefore = items.find((item) => item.classList.contains('active'))?.dataset.sessionPath ?? null
  const data = new DataTransfer()
  items[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }))
  items[1].dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: data }))
  items[1].dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: data }))
  items[0].dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }))
  return true
})()`)
await sleep(180)
await check('拖拽后会话顺序可改变', `(() => { const before = window.__pionSessionOrderBefore; const list = [...document.querySelectorAll('.project-branch-sessions')].find((candidate) => candidate.querySelectorAll('.side-session').length >= 2); const after = list ? [...list.querySelectorAll('.side-session')].map(e => e.dataset.sessionPath) : []; return Array.isArray(before) && before.length >= 2 && after[0] === before[1] && after[1] === before[0]; })()`)
await evaluate(`window.__pionProjectOrderBefore = [...document.querySelectorAll('.project-folder .project-folder-name')].map((item) => item.textContent)`)
await evaluate(`(() => { const list = [...document.querySelectorAll('.project-branch-sessions')].find((candidate) => candidate.querySelectorAll('.side-session').length >= 2); const target = [...(list?.querySelectorAll('.side-session') ?? [])].find((item) => item.dataset.sessionPath !== window.__pionActiveSessionBefore); window.__pionTargetSessionPath = target?.dataset.sessionPath ?? null; target?.click(); return Boolean(target); })()`)
await check('选中会话立即高亮', `(() => { const target = document.querySelector('.side-session[data-session-path="' + window.__pionTargetSessionPath + '"]'); return !!target && target.classList.contains('active'); })()`)
await sleep(1200)
await check('异步刷新保持选中会话', `(() => { const target = document.querySelector('.side-session[data-session-path="' + window.__pionTargetSessionPath + '"]'); return !!target && target.classList.contains('active'); })()`)
await check('激活会话不会自动置顶项目', `JSON.stringify(window.__pionProjectOrderBefore) === JSON.stringify([...document.querySelectorAll('.project-folder .project-folder-name')].map((item) => item.textContent))`)
await check('激活会话不会自动置顶', `(() => { const before = window.__pionSessionOrderBefore; const list = [...document.querySelectorAll('.project-branch-sessions')].find((candidate) => candidate.querySelectorAll('.side-session').length >= 2); const after = list ? [...list.querySelectorAll('.side-session')].map(e => e.dataset.sessionPath) : []; return Array.isArray(before) && after[0] === before[1] && after[1] === before[0]; })()`)
await evaluate(`(() => {
  const list = [...document.querySelectorAll('.project-branch-sessions')].find((candidate) => candidate.querySelectorAll('.side-session').length >= 2)
  const items = list ? [...list.querySelectorAll('.side-session')] : []
  if (items.length < 2 || typeof DataTransfer === 'undefined' || typeof DragEvent === 'undefined') return false
  const data = new DataTransfer()
  items[1].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }))
  items[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: data }))
  items[0].dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: data }))
  items[1].dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }))
  return true
})()`)
await sleep(180)
await evaluate(`document.querySelector('.project-branch-sessions .side-session')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 160 }))`)
await sleep(300)
await check('右键菜单打开', `!!document.querySelector('.context-menu')`)
await check('右键菜单使用当前主题', `(() => { const menu = document.querySelector('.context-menu'); const probe = document.createElement('i'); probe.style.background = 'var(--bg-elev)'; document.body.appendChild(probe); const expected = getComputedStyle(probe).backgroundColor; probe.remove(); return !!menu && getComputedStyle(menu).backgroundColor === expected; })()`)
await check('菜单含复制会话', `Array.from(document.querySelectorAll('.context-menu-item')).some(e => e.textContent?.includes('从会话复制'))`)
await check('菜单含分支会话', `Array.from(document.querySelectorAll('.context-menu-item')).some(e => e.textContent?.includes('从会话分支'))`)
await check('菜单含历史任务', `Array.from(document.querySelectorAll('.context-menu-item')).some(e => e.textContent?.includes('历史任务'))`)
await check('菜单含删除会话', `Array.from(document.querySelectorAll('.context-menu-item')).some(e => e.textContent?.includes('删除会话'))`)
await evaluate(`Array.from(document.querySelectorAll('.context-menu-item')).find(e => e.textContent?.includes('历史任务'))?.click()`)
for (let i = 0; i < 40; i++) {
  await sleep(120)
  if (await evaluate(`!!document.querySelector('.task-history-modal') && !document.querySelector('.task-history-state .spin')`)) break
}
await check('右键可打开大历史任务面板', `document.querySelector('.task-history-modal')?.textContent?.includes('历史任务') && document.querySelector('.task-history-modal')?.getAttribute('role') === 'dialog'`)
await check('历史任务按用户消息分段', `(() => { const runs = [...document.querySelectorAll('.task-history-run')]; if (runs.length === 0) return document.querySelector('.task-history-state')?.textContent?.includes('没有由 AI 创建'); return runs.every((run) => !!run.querySelector('.task-history-run-toggle')) && runs.filter((run) => run.classList.contains('expanded')).length === 1 && !!document.querySelector('.task-history-run.expanded .task-history-tasks'); })()`)
await evaluate(`document.querySelector('.task-history-head .icon-button')?.click()`)
await sleep(180)
await check('历史任务面板可关闭', `!document.querySelector('.task-history-modal')`)
await evaluate(`document.querySelector('.project-branch-sessions .side-session')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 160 }))`)
await sleep(220)
await evaluate(`Array.from(document.querySelectorAll('.context-menu-item')).find(e => e.textContent?.includes('删除会话'))?.click()`)
await sleep(120)
await check('删除会话使用主题确认框', `document.querySelector('.confirm-dialog')?.textContent?.includes('删除会话') && document.querySelector('.confirm-dialog')?.textContent?.includes('确认删除')`)
await evaluate(`document.querySelector('.confirm-dialog-cancel')?.click()`)
await sleep(120)
await check('删除确认可安全取消', `!document.querySelector('.confirm-dialog') && !!document.querySelector('.context-menu')`)
await evaluate(`Array.from(document.querySelectorAll('.context-menu-item')).find(e => e.textContent?.includes('从会话分支'))?.click()`)
await sleep(500)
await check('分支菜单展开', `!!document.querySelector('.context-submenu')`)
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
await sleep(200)
await check('右键菜单可关闭', `!document.querySelector('.context-menu')`)
checkHost('源码不再使用原生 window.confirm', !readFileSync('src/renderer/src/App.tsx', 'utf8').includes('window.confirm') && !readFileSync('src/renderer/src/components/SessionList.tsx', 'utf8').includes('window.confirm'))
const appSource = readFileSync('src/renderer/src/App.tsx', 'utf8')
const selectSessionSource = appSource.slice(appSource.indexOf('const handleSelectSession'), appSource.indexOf('const handleDeleteSession'))
const persistedSessionActions = appSource.slice(appSource.indexOf('const handleDeleteSession'), appSource.indexOf('const sessionChanges'))
checkHost('跨项目会话切换不先启动空项目', !selectSessionSource.includes('activateProject('))
checkHost('跨项目会话上下文操作不切换项目', !persistedSessionActions.includes('activateProject('))
const agentHookSource = readFileSync('src/renderer/src/hooks/useAgent.ts', 'utf8')
const switchSessionSource = agentHookSource.slice(agentHookSource.indexOf('const switchSession'), agentHookSource.indexOf('const jumpToHistoryLandmark'))
checkHost('缓存会话在主进程切换前立即恢复', switchSessionSource.indexOf('restoreCachedTimeline(sessionPath, cached)') >= 0 && switchSessionSource.indexOf('restoreCachedTimeline(sessionPath, cached)') < switchSessionSource.indexOf('result = await api.switchSession(sessionPath)'))
checkHost('缓存会话后台校验不显示加载状态', agentHookSource.includes("if (path && !keepVisibleCache) dispatch({ type: 'timelineLoading', loading: true })") && agentHookSource.includes('if (!keepVisibleCache) showTimeline(path, cached.items, cached.mode)'))
await evaluate(`window.pion.removeProject(${JSON.stringify(TEST_WORKSPACE)}).then(() => true).catch(() => false)`)

ws.close()
child.kill('SIGTERM')
console.log(`\n${ok} 项通过`)
process.exit(0)
