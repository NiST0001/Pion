// UI 变更验证：无边框标题栏 / 模型选择器位置 / 设置面板
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = '9344'
const child = spawn('node_modules/electron/dist/electron', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'ignore', 'ignore']
})
process.on('exit', () => { try { child.kill('SIGKILL') } catch {} })

async function getPage() {
  for (let i = 0; i < 30; i++) {
    await sleep(500)
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

// 等待 agent 运行
for (let i = 0; i < 40; i++) {
  await sleep(500)
  if (await evaluate(`document.querySelector('.dot-running') !== null`)) break
}

// --- 1. 无边框标题栏 ---
await check('标题栏存在', `!!document.querySelector('.titlebar')`)
await check('旧 header 已移除', `!document.querySelector('.app-header')`)
await check('窗口控制三键（最小/最大/关闭）', `document.querySelectorAll('.titlebar-btn').length >= 3`)
await check('关闭按钮样式', `!!document.querySelector('.titlebar-close')`)
await check('标题栏含品牌', `document.querySelector('.titlebar-brand .brand-name')?.textContent === 'Pion'`)

// --- 2. 模型选择器与输入框融为一体 ---
for (let i = 0; i < 20; i++) {
  await sleep(500)
  if (await evaluate(`document.querySelectorAll('.composer-inline-controls .thinking-segment').length > 0`)) break
}
await check('composer 输入框存在', `!!document.querySelector('.composer-row textarea')`)
await check('模型选择器嵌入输入框', `!!document.querySelector('.composer-row .composer-inline-controls .picker')`)
await check('模型选择器显示当前模型', `(document.querySelector('.composer-inline-controls .picker-value')?.textContent ?? '').length > 0`)
await check('模型选择器可打开', `(() => { document.querySelector('.composer-inline-controls .picker-trigger')?.click(); return true })()`)
await sleep(300)
await check('模型菜单已显示', `!!document.querySelector('.composer-inline-controls .picker-menu')`)
await check('模型选项可见', `document.querySelectorAll('.composer-inline-controls .picker-option').length > 0`)
await check('思考级别嵌入输入框', `document.querySelectorAll('.composer-inline-controls .thinking-segment').length > 0`)
await evaluate(`document.querySelector('.composer-inline-controls .picker-trigger')?.click()`)
await check('旧控制行已移除', `!document.querySelector('.composer-controls')`)
await check('header 中无模型选择器', `!document.querySelector('.app-header .picker')`)

// --- 3. 设置面板入口位于左下角 ---
await check('设置面板默认关闭', `!document.querySelector('.settings-modal, .modal')`)
await check('设置入口位于左侧栏底部', `!!document.querySelector('.sidebar-footer .sidebar-settings')`)
await evaluate(`document.querySelector('.sidebar-footer .sidebar-settings')?.click()`)
await sleep(400)
await check('点击左下角设置后面板打开', `!!document.querySelector('.settings-modal')`)
await check('设置左侧导航渲染', `document.querySelectorAll('.settings-nav-item').length >= 5`)
await check('模型提供商页渲染', `!!document.querySelector('.models-page') && document.querySelectorAll('.provider-card').length > 0`)
await check('设置页模型列表渲染', `document.querySelectorAll('.model-choice').length > 0`)
await evaluate(`Array.from(document.querySelectorAll('.settings-nav-item')).find(e => e.textContent?.includes('外观'))?.click()`)
await sleep(200)
await check('外观页可切换', `!!document.querySelector('.appearance-preview') && document.querySelectorAll('.accent-choice').length >= 5`)
await evaluate(`Array.from(document.querySelectorAll('.settings-nav-item')).find(e => e.textContent?.includes('关于 Pion'))?.click()`)
await sleep(200)
await check('关于页可切换', `!!document.querySelector('.about-page .about-logo') && document.querySelectorAll('.about-page .info-row').length >= 4`)
await evaluate(`Array.from(document.querySelectorAll('.settings-nav-item')).find(e => e.textContent?.trim() === '会话压缩与消息行为' || e.textContent?.includes('会话'))?.click()`)
await sleep(200)
await check('会话页可切换', `document.querySelectorAll('.settings-page .toggle').length >= 2 && document.querySelectorAll('.settings-page .segmented').length >= 2`)
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
await evaluate(`document.querySelector('.side-session')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 160 }))`)
await sleep(300)
await check('右键菜单打开', `!!document.querySelector('.context-menu')`)
await check('菜单含复制会话', `Array.from(document.querySelectorAll('.context-menu-item')).some(e => e.textContent?.includes('从会话复制'))`)
await check('菜单含分支会话', `Array.from(document.querySelectorAll('.context-menu-item')).some(e => e.textContent?.includes('从会话分支'))`)
await check('菜单含删除会话', `Array.from(document.querySelectorAll('.context-menu-item')).some(e => e.textContent?.includes('删除会话'))`)
await evaluate(`Array.from(document.querySelectorAll('.context-menu-item')).find(e => e.textContent?.includes('从会话分支'))?.click()`)
await sleep(500)
await check('分支菜单展开', `!!document.querySelector('.context-submenu')`)
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
await sleep(200)
await check('右键菜单可关闭', `!document.querySelector('.context-menu')`)

ws.close()
child.kill('SIGTERM')
console.log(`\n${ok} 项通过`)
process.exit(0)
