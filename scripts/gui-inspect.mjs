// CDP 检查脚本：连接运行中的 Pion 实例，导出渲染进程内部状态
// 用法: node scripts/gui-inspect.mjs [port]
import { WebSocket } from 'ws'

const PORT = process.argv[2] ?? '9333'
const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
const targets = await res.json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('no page target found')
console.log('target:', page.url.slice(0, 70))

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })

let msgId = 0
const pending = new Map()
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const cdp = (method, params = {}) => new Promise((resolve) => {
  const id = ++msgId
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const res = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  const { result, exceptionDetails } = res.result
  if (exceptionDetails) return `EXCEPTION: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`
  return result.value
}

console.log('location:', await evaluate('location.href'))
console.log('window.pion:', await evaluate('typeof window.pion'))
console.log('#root children:', await evaluate('document.getElementById("root")?.children.length'))
console.log('.sidebar exists:', await evaluate('!!document.querySelector(".sidebar")'))
console.log('.boot-error:', await evaluate('document.querySelector(".boot-error")?.textContent ?? "(none)"'))
console.log('.empty-state:', await evaluate('document.querySelector(".empty-state h2")?.textContent ?? "(none)"'))
console.log('.dot class:', await evaluate('document.querySelector(".sidebar-brand .dot")?.className ?? "(none)"'))
console.log('.banner-error:', await evaluate('document.querySelector(".banner-error")?.textContent ?? "(none)"'))
console.log('side-sections:', await evaluate('Array.from(document.querySelectorAll(".side-section-title")).map(e => e.textContent).join(", ")'))
console.log('projects json:', await evaluate('JSON.stringify(await window.pion.listProjects())'))
console.log('agent state:', await evaluate('JSON.stringify(await window.pion.getState())'))

ws.close()
process.exit(0)
