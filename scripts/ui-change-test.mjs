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
  if (await evaluate(`document.querySelector('.dot-running, .dot-ready') !== null`)) break
}

await check('启动时后端未启动', `!!document.querySelector('.dot-ready')`)
await evaluate(`(() => { const input = document.querySelector('.composer-row textarea'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; setter?.call(input, '/plan exit'); input?.dispatchEvent(new Event('input', { bubbles: true })); input?.focus(); return true })()`)
await sleep(80)
await evaluate(`document.querySelector('.send-button')?.click()`)
await sleep(1200)
await check('发送任务后启动后端', `!!document.querySelector('.dot-running')`)
await check('会话历史按窗口读取', `(async()=>{const page=await window.pion.getEntriesPage(undefined, 2); return !!page && page.entries.length <= 2 && page.total >= page.entries.length})()`)

// --- 1. 无边框标题栏 ---
await check('标题栏存在', `!!document.querySelector('.titlebar')`)
await check('旧 header 已移除', `!document.querySelector('.app-header')`)
await check('窗口控制三键（最小/最大/关闭）', `document.querySelectorAll('.titlebar-btn').length >= 3`)
await check('关闭按钮样式', `!!document.querySelector('.titlebar-close')`)
await check('标题栏含品牌', `document.querySelector('.titlebar-brand .brand-name')?.textContent === 'Pion'`)
await check('左上角会话栏开关', `!!document.querySelector('.titlebar-panel-btn')`)
await check('右上角文件审查栏开关', `!!document.querySelector('.titlebar-review-btn')`)
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
await check('搜索输入可筛选项目会话', `document.querySelectorAll('.project-folder-sessions .side-session').length === 0 && document.querySelector('.side-empty')?.textContent === '没有匹配的会话'`)
await evaluate(`(() => { const input = document.querySelector('.sidebar-search input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; setter?.call(input, ''); input?.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
await sleep(120)
await evaluate(`document.querySelector('.sidebar-tools-button')?.click()`)
await sleep(220)
await check('技能与工具界面打开', `!!document.querySelector('.capabilities-modal') && !document.querySelector('.sidebar-tools-panel')`)
await check('技能页默认打开', `document.querySelector('.capabilities-nav-item[data-page="skills"]')?.classList.contains('active') && !!document.querySelector('.capabilities-page[data-page="skills"]')`)
await check('技能列表已渲染', `document.querySelectorAll('.skill-card').length > 0`)
await evaluate(`document.querySelector('.capabilities-nav-item[data-page="tools"]')?.click()`)
await sleep(80)
await check('工具页可切换', `document.querySelector('.capabilities-nav-item[data-page="tools"]')?.classList.contains('active') && !!document.querySelector('.capabilities-page[data-page="tools"]') && document.querySelectorAll('.tool-card').length >= 4`)
await evaluate(`document.querySelector('.capabilities-close')?.click()`)
await sleep(100)
await check('技能与工具界面可关闭', `!document.querySelector('.capabilities-modal')`)
await evaluate(`document.querySelector('.titlebar-panel-btn')?.click()`)
await sleep(150)
await check('左上角按钮可关闭会话栏', `!document.querySelector('.sidebar')`)
await evaluate(`document.querySelector('.titlebar-panel-btn')?.click()`)
await sleep(150)
await check('左上角按钮可重新打开会话栏', `!!document.querySelector('.sidebar')`)
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

// --- 2. 模型选择器与输入框融为一体 ---
for (let i = 0; i < 20; i++) {
  await sleep(500)
  if (await evaluate(`!!document.querySelector('.composer-inline-controls .thinking-trigger')`)) break
}
await check('composer 输入框存在', `!!document.querySelector('.composer-row textarea')`)
await check('当前会话后端已复用', `!!document.querySelector('.dot-running')`)
await check('输入框宽度已扩大', `getComputedStyle(document.querySelector('.composer-row')).maxWidth === '1600px'`)
await check('输入框高度已缩短', `(() => { const height = document.querySelector('.composer-row')?.getBoundingClientRect().height ?? 0; return height >= 85 && height < 120; })()`)
await check('任务面板已移除', `!document.querySelector('.task-panel')`)
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
await evaluate(`(() => { const input = document.querySelector('.composer-row textarea'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; setter?.call(input, '/'); input?.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
await sleep(180)
await check('斜杠命令菜单可打开', `!!document.querySelector('.slash-command-menu') && document.querySelectorAll('.slash-command-option').length > 0`)
await check('斜杠命令含计划模式', `Array.from(document.querySelectorAll('.slash-command-name')).some((element) => element.textContent === '/plan')`)
await evaluate(`(() => { const input = document.querySelector('.composer-row textarea'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; setter?.call(input, '/pl'); input?.dispatchEvent(new Event('input', { bubbles: true })); input?.focus(); return true })()`)
await sleep(120)
await evaluate(`document.querySelector('.composer-row textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))`)
await sleep(120)
await check('斜杠命令 Tab 可补齐', `document.querySelector('.composer-row textarea')?.value === '/plan '`)
await evaluate(`(() => { const input = document.querySelector('.composer-row textarea'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; setter?.call(input, ''); input?.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
await check('快捷键提示含上下键历史编辑',  `document.querySelector('.composer-row textarea')?.getAttribute('placeholder')?.includes('↑↓ 编辑历史') && document.querySelector('.composer-row textarea')?.getAttribute('aria-keyshortcuts') === 'ArrowUp ArrowDown'`)
await check('快捷键提示为 Tab 排队 Enter 直接发送', `document.querySelector('.composer-row textarea')?.getAttribute('placeholder')?.includes('Tab 排队') && document.querySelector('.composer-row textarea')?.getAttribute('placeholder')?.includes('Enter 直接发送')`)
await check('模型选择器嵌入输入框', `!!document.querySelector('.composer-row .composer-inline-controls .picker')`)
await check('模型选择器显示当前模型', `(document.querySelector('.composer-inline-controls .picker-value')?.textContent ?? '').length > 0`)
await check('模型选择器可打开', `(() => { document.querySelector('.composer-inline-controls .picker-trigger')?.click(); return true })()`)
await sleep(300)
await check('模型菜单已显示', `!!document.querySelector('.composer-inline-controls .picker-menu')`)
await check('模型选项可见', `document.querySelectorAll('.composer-inline-controls .picker-option').length > 0`)
await check('思考级别嵌入输入框', `!!document.querySelector('.composer-inline-controls .thinking-trigger') && !document.querySelector('.composer-inline-controls .thinking-segment')`)
await check('思考等级为下拉框', `document.querySelector('.thinking-trigger')?.getAttribute('aria-haspopup') === 'listbox'`)
await evaluate(`document.querySelector('.composer-inline-controls .thinking-trigger')?.click()`)
await sleep(150)
await check('思考等级菜单可打开', `!!document.querySelector('.thinking-menu') && document.querySelectorAll('.thinking-option').length > 0`)
await evaluate(`document.querySelector('.composer-inline-controls .thinking-trigger')?.click()`)
await check('旧控制行已移除', `!document.querySelector('.composer-controls')`)
await check('header 中无模型选择器', `!document.querySelector('.app-header .picker')`)

// --- 3. 设置面板入口位于左下角 ---
await check('设置面板默认关闭', `!document.querySelector('.settings-modal, .modal')`)
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
await check('插件商店提供直接安装入口', `!!document.querySelector('.plugin-store-manual') && document.querySelectorAll('.plugin-install-button').length > 0`)
await evaluate(`document.querySelector('.plugin-store-view-toggle')?.click()`)
await sleep(120)
await check('插件商店可切换内置浏览器', `document.querySelector('.plugin-store-browser:not(.is-hidden)') !== null`)
await evaluate(`document.querySelector('.plugin-store-view-toggle')?.click()`)
await sleep(120)
await evaluate(`document.querySelector('.plugin-store-modal .icon-button:last-child')?.click()`)
await sleep(150)
await check('插件商店面板可关闭', `!document.querySelector('.plugin-store-modal')`)
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
await check('左侧会话栏已移除变更', `!document.querySelector('.side-change') && !Array.from(document.querySelectorAll('.side-section-title')).some(e => e.textContent?.trim() === '变更')`)
await check('项目下默认存在 main 分支', `document.querySelectorAll('.project-folder').length > 0 && document.querySelectorAll('.project-branch-name').length > 0 && Array.from(document.querySelectorAll('.project-branch-name')).every(e => e.textContent?.trim() === 'main')`)
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
