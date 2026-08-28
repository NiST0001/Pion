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
await check('左上角会话栏开关', `!!document.querySelector('.titlebar-panel-btn')`)
await check('右上角文件审查栏开关', `!!document.querySelector('.titlebar-review-btn')`)
await check('左侧会话栏默认打开', `!!document.querySelector('.sidebar')`)
await check('侧栏含新建会话按钮', `!!document.querySelector('.sidebar-new-session') && document.querySelector('.sidebar-new-session')?.textContent?.includes('新建会话')`)
await check('侧栏含技能与工具按钮', `!!document.querySelector('.sidebar-tools-button') && document.querySelector('.sidebar-tools-button')?.textContent?.includes('技能与工具')`)
await check('侧栏搜索为直接输入框', `document.querySelector('.sidebar-search input')?.tagName === 'INPUT' && document.querySelector('.sidebar-search input')?.getAttribute('placeholder') === '搜索会话'`)
await evaluate(`(() => { const input = document.querySelector('.sidebar-search input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; setter?.call(input, '__no_matching_session__'); input?.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
await sleep(120)
await check('搜索输入可筛选项目会话', `document.querySelectorAll('.project-folder-sessions .side-session').length === 0 && document.querySelector('.side-empty')?.textContent === '没有匹配的会话'`)
await evaluate(`(() => { const input = document.querySelector('.sidebar-search input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; setter?.call(input, ''); input?.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
await sleep(120)
await evaluate(`document.querySelector('.sidebar-tools-button')?.click()`)
await sleep(120)
await check('技能与工具面板可展开', `!!document.querySelector('.sidebar-tools-panel')`)
await evaluate(`document.querySelector('.sidebar-tools-button')?.click()`)
await sleep(80)
await check('技能与工具面板可收起', `!document.querySelector('.sidebar-tools-panel')`)
await evaluate(`document.querySelector('.titlebar-panel-btn')?.click()`)
await sleep(150)
await check('左上角按钮可关闭会话栏', `!document.querySelector('.sidebar')`)
await evaluate(`document.querySelector('.titlebar-panel-btn')?.click()`)
await sleep(150)
await check('左上角按钮可重新打开会话栏', `!!document.querySelector('.sidebar')`)
await evaluate(`document.querySelector('.titlebar-review-btn')?.click()`)
await sleep(200)
await check('右上角按钮可打开文件审查栏', `!!document.querySelector('.review-panel')`)
await check('审查栏为左 diff 右文件布局', `(() => { const body = document.querySelector('.review-panel-body'); const detail = document.querySelector('.review-detail')?.getBoundingClientRect(); const files = document.querySelector('.review-files')?.getBoundingClientRect(); return !!body && !!detail && !!files && getComputedStyle(body).flexDirection === 'row' && detail.left < files.left && files.width > 0; })()`)
await evaluate(`document.querySelector('.titlebar-review-btn')?.click()`)
await sleep(150)
await check('右上角按钮可关闭文件审查栏', `!document.querySelector('.review-panel')`)

// --- 2. 模型选择器与输入框融为一体 ---
for (let i = 0; i < 20; i++) {
  await sleep(500)
  if (await evaluate(`document.querySelectorAll('.composer-inline-controls .thinking-segment').length > 0`)) break
}
await check('composer 输入框存在', `!!document.querySelector('.composer-row textarea')`)
await check('任务面板默认展开', `document.querySelector('.task-panel-toggle')?.getAttribute('aria-expanded') === 'true' && !!document.querySelector('.task-panel-list')`)
await check('任务面板显示七条并露出第八条', `(() => { const list = document.querySelector('.task-panel-list')?.getBoundingClientRect(); const items = document.querySelectorAll('.task-item'); if (!list || items.length < 8) return false; const eighth = items[7].getBoundingClientRect(); return eighth.top < list.bottom && eighth.bottom > list.bottom && (document.querySelector('.task-panel-list')?.scrollHeight ?? 0) > (document.querySelector('.task-panel-list')?.clientHeight ?? 0); })()`)
await check('任务面板位于输入框上方', `(() => { const panel = document.querySelector('.task-panel'); const composer = document.querySelector('.composer'); return !!panel && !!composer && Boolean(panel.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING); })()`)
await check('第八条使用底部渐变遮罩', `getComputedStyle(document.querySelector('.task-panel-list'), '::after').backgroundImage.includes('gradient')`)
await evaluate(`(() => { const list = document.querySelector('.task-panel-list'); if (!list) return false; list.scrollTop = list.scrollHeight; return true })()`)
await sleep(80)
await check('任务面板可滚轮查看后续任务', `(() => { const list = document.querySelector('.task-panel-list'); return !!list && list.scrollTop > 0 && list.scrollTop + list.clientHeight >= list.scrollHeight; })()`)
await evaluate(`(() => { const list = document.querySelector('.task-panel-list'); if (list) list.scrollTop = 0; return true })()`)
await evaluate(`document.querySelector('.task-panel-toggle')?.click()`)
await sleep(100)
await check('任务面板可收起', `document.querySelector('.task-panel-toggle')?.getAttribute('aria-expanded') === 'false' && !document.querySelector('.task-panel-list')`)
await evaluate(`document.querySelector('.task-panel-toggle')?.click()`)
await sleep(100)
await check('任务面板可重新展开', `document.querySelector('.task-panel-toggle')?.getAttribute('aria-expanded') === 'true' && !!document.querySelector('.task-panel-list')`)
await check('快捷键提示含上下键历史编辑', `document.querySelector('.composer-row textarea')?.getAttribute('placeholder')?.includes('↑↓ 编辑历史') && document.querySelector('.composer-row textarea')?.getAttribute('aria-keyshortcuts') === 'ArrowUp ArrowDown'`)
await check('快捷键提示为 Tab 排队 Enter 直接发送', `document.querySelector('.composer-row textarea')?.getAttribute('placeholder')?.includes('Tab 排队') && document.querySelector('.composer-row textarea')?.getAttribute('placeholder')?.includes('Enter 直接发送')`)
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
await check('不显示主题色设置', `!document.querySelector('.accent-grid, .accent-choice') && !Array.from(document.querySelectorAll('.settings-page *')).some(e => e.textContent?.trim() === '主题色')`)
await check('陶土深浅主题选项', `document.querySelectorAll('.theme-choice').length === 2 && document.querySelector('.theme-choice')?.textContent?.includes('陶土')`)
await evaluate(`Array.from(document.querySelectorAll('.theme-choice')).find(e => e.textContent?.includes('陶土浅色'))?.click()`)
await sleep(120)
await check('陶土浅色主题即时应用', `document.documentElement.dataset.theme === 'terracotta-light'`)
await evaluate(`Array.from(document.querySelectorAll('.theme-choice')).find(e => e.textContent?.includes('陶土深色'))?.click()`)
await sleep(120)
await check('陶土深色主题可恢复', `document.documentElement.dataset.theme === 'terracotta-dark'`)
await evaluate(`Array.from(document.querySelectorAll('.settings-nav-item')).find(e => e.textContent?.includes('关于 Pion'))?.click()`)
await sleep(200)
await check('关于页可切换', `!!document.querySelector('.about-page .about-logo') && document.querySelectorAll('.about-page .info-row').length >= 4`)
await evaluate(`Array.from(document.querySelectorAll('.settings-nav-item')).find(e => e.textContent?.includes('会话'))?.click()`)
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
await check('项目以文件夹形式包含会话', `document.querySelectorAll('.project-folder').length > 0 && document.querySelectorAll('.project-folder-sessions .side-session').length > 0`)
await evaluate(`document.querySelector('.project-folder-sessions .side-session')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 160 }))`)
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
