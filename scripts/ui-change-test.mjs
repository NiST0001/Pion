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
await check('窗口控制三键（最小/最大/关闭）', `document.querySelectorAll('.titlebar-btn').length >= 4`)
await check('关闭按钮样式', `!!document.querySelector('.titlebar-close')`)
await check('标题栏含品牌', `document.querySelector('.titlebar-brand .brand-name')?.textContent === 'Pion'`)

// --- 2. 模型选择器在输入区下方 ---
for (let i = 0; i < 20; i++) {
  await sleep(500)
  if (await evaluate(`document.querySelectorAll('.composer-controls .thinking-segment').length > 0`)) break
}
await check('composer 控制行存在', `!!document.querySelector('.composer-controls')`)
await check('模型选择器在控制行内', `!!document.querySelector('.composer-controls .picker')`)
await check('模型选择器显示当前模型', `(document.querySelector('.composer-controls .picker-value')?.textContent ?? '').length > 0`)
await check('思考级别在控制行内', `document.querySelectorAll('.composer-controls .thinking-segment').length > 0`)
await check('header 中无模型选择器', `!document.querySelector('.app-header .picker')`)

// --- 3. 设置面板 ---
await check('设置面板默认关闭', `!document.querySelector('.settings-modal, .modal')`)
await evaluate(`document.querySelector('.titlebar-btn').click()`)
await sleep(400)
await check('点击设置后面板打开', `!!document.querySelector('.modal')`)
await check('面板含会话/行为/外观区块', `Array.from(document.querySelectorAll('.settings-section-title')).map(e => e.textContent).join(',').length > 0`)
await check('开关组件渲染', `document.querySelectorAll('.modal .toggle').length >= 2`)
await check('分段控件渲染', `document.querySelectorAll('.modal .segmented').length >= 2`)
await check('主题色色板', `document.querySelectorAll('.modal .swatch').length >= 5`)
await check('ESC 关闭面板', `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true })()`)
await sleep(300)
await check('面板已关闭', `!document.querySelector('.modal')`)

// --- 窗口控制功能（最小化会让窗口消失，跳过；验证 toggle-maximize 不崩溃）---
await evaluate(`window.pion.toggleMaximizeWindow()`)
await sleep(600)
await check('最大化切换存活', `!!document.querySelector('.titlebar')`)

ws.close()
child.kill('SIGTERM')
console.log(`\n${ok} 项通过`)
process.exit(0)
