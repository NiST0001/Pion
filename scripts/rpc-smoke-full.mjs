// RPC 扩展冒烟测试：验证 Pion 新功能依赖的全部桥接路径
// - getEntries / getTree（时间线重建、分支树）
// - getAvailableModels / getAvailableThinkingLevels（模型切换器）
// - newSession / fork / switchSession（会话管理与分叉）
// - SessionManager.list（项目会话列表）
import { RpcClient, getPackageDir, SessionManager } from '@earendil-works/pi-coding-agent'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cliPath = join(getPackageDir(), 'dist', 'cli.js')
// 未指定 cwd 时使用平台临时目录（Windows 上没有 /tmp）
const cwd = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'pion-rpc-smoke-full-'))
const cleanupCwd = !process.argv[2]
console.log(`[smoke] cwd: ${cwd}`)

// --- 1. SessionManager.list（不经子进程） ---
const sessions = await SessionManager.list(cwd)
console.log(`[smoke] SessionManager.list: ${sessions.length} 个会话`)
for (const s of sessions.slice(0, 3)) {
  console.log(
    `  - ${s.id.slice(0, 8)} msgs=${s.messageCount} name=${s.name ?? '-'} first=${(s.firstMessage ?? '').slice(0, 40)}`
  )
}

// --- 2. RPC 子进程链路 ---
const client = new RpcClient({ cliPath, cwd })
client.onEvent((e) => {
  const t = e.type
  if (t === 'agent_settled' || t === 'session_start' || t.startsWith('extension_')) return
  console.log(`[event] ${t}`)
})

await client.start()
console.log('[smoke] agent started')

const state = await client.getState()
console.log(`[smoke] state: model=${state.model?.id} streaming=${state.isStreaming} session=${state.sessionId?.slice(0, 8)}`)

const entries = await client.getEntries()
console.log(`[smoke] getEntries: ${entries.entries.length} 条, leafId=${entries.leafId?.slice(0, 8) ?? null}`)
const userEntries = entries.entries.filter((e) => e.type === 'message' && e.message?.role === 'user')
console.log(`[smoke]   其中用户消息 ${userEntries.length} 条`)
if (userEntries.length > 0) {
  const tree = await client.getTree()
  const countTree = (nodes) => nodes.reduce((n, x) => n + 1 + countTree(x.children), 0)
  console.log(`[smoke] getTree: ${countTree(tree.tree)} 个节点`)
}

const models = await client.getAvailableModels()
console.log(`[smoke] models: ${models.length} 个 (${[...new Set(models.map((m) => m.provider))].join(', ')})`)

const levels = await client.getAvailableThinkingLevels()
console.log(`[smoke] thinking levels: ${levels.join(' / ')}`)

// --- 3. fork 链路（若有用户消息可分叉） ---
if (userEntries.length > 0) {
  const target = userEntries[userEntries.length - 1]
  console.log(`[smoke] fork at ${target.id.slice(0, 8)} ...`)
  const forkResult = await client.fork(target.id)
  console.log(`[smoke] fork -> cancelled=${forkResult.cancelled} text="${forkResult.text?.slice(0, 50)}"`)
  const after = await client.getEntries()
  console.log(`[smoke] fork 后 entries: ${after.entries.length} 条 (之前 ${entries.entries.length})`)
  const afterState = await client.getState()
  console.log(`[smoke] fork 后 session: ${afterState.sessionId?.slice(0, 8)} (之前 ${state.sessionId?.slice(0, 8)})`)
}

// --- 4. newSession ---
await client.newSession()
const fresh = await client.getEntries()
console.log(`[smoke] newSession 后 entries: ${fresh.entries.length} 条`)

await client.stop()
console.log('[smoke] done ✓')
if (cleanupCwd) rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
