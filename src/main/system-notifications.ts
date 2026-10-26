import { posix } from 'node:path'
import type { ToolPermissionCategory, ToolPermissionRequest, ToolPermissionRisk } from '../shared/types'

export interface NotificationSessionContext {
  sessionName?: string
  sessionId?: string
}

export interface SessionCompletionNotice extends NotificationSessionContext {
  cwd: string
  sessionPath?: string
  /** Only the owning run's final reply, selected by the caller. */
  summary?: string
  durationMs?: number
  toolCount?: number
}

const CATEGORY_LABELS: Record<ToolPermissionCategory, string> = {
  read: '读取文件', write: '写入文件', shell: '执行命令', network: '网络访问', external: '外部工具'
}
const RISK_LABELS: Record<ToolPermissionRisk, string> = {
  'outside-workspace': '项目目录外', 'sensitive-path': '敏感路径', 'destructive-command': '高风险命令'
}

function truncate(text: string, limit: number): string {
  const points = Array.from(text)
  return points.length > limit ? `${points.slice(0, limit - 1).join('')}…` : text
}

/** Display cleanup only; ordinary text can still contain private information. */
export function notificationText(text: string | undefined, limit = 60): string {
  if (!text) return ''
  const bounded = text.slice(0, 4096)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ud800-\udfff]/gu, ' ')
    .replace(/<(audio|video|picture)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/<\/?(?:img|audio|video|source|picture|track)\b[^>]*(?:>|$)/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\bdata:[^,\s<>"']*,[^\s<>"']*/gi, '')
    .replace(/(?:\*\*|__|~~|`{1,3})/g, '')
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return truncate(bounded, limit)
}

/** Display only: accept either separator style without resolving or assigning ownership. */
function displayBasename(path: string | undefined): string {
  return path ? notificationText(posix.basename(path.slice(-4096).replace(/\\/g, '/'))) : ''
}

function sessionLines(context: NotificationSessionContext, sessionPath?: string): string[] {
  const lines = [`会话：${notificationText(context.sessionName) || '未命名'}`]
  const id = Array.from(notificationText(context.sessionId)).slice(0, 8).join('')
  const file = displayBasename(sessionPath)
  if (id) lines.push(`SDK短ID：${id}`)
  else if (file) lines.push(`会话文件：${file}`)
  return lines
}

/** Match the conversation's whole-second elapsed display without a renderer dependency. */
function durationText(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return undefined
  if (durationMs < 1000) return '<1秒'
  const seconds = Math.floor(durationMs / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return `${hours ? `${hours}小时` : ''}${minutes ? `${minutes}分` : ''}${remainder ? `${remainder}秒` : ''}`
}

function timeoutClock(timeoutAt: number): string | undefined {
  if (!Number.isFinite(timeoutAt) || timeoutAt <= 0) return undefined
  const date = new Date(timeoutAt)
  if (!Number.isFinite(date.getTime())) return undefined
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0')).join(':')
}

export function formatSessionCompletionNotification(info: SessionCompletionNotice): { title: string; body: string } {
  const lines = [
    `项目/工作树：${displayBasename(info.cwd) || '未命名'}`,
    ...sessionLines(info, info.sessionPath)
  ]
  const summary = notificationText(info.summary, 180)
  if (summary) lines.push(`回复摘要：${summary}`)
  const duration = durationText(info.durationMs)
  if (duration) lines.push(`本轮耗时：${duration}`)
  if (info.toolCount !== undefined && Number.isSafeInteger(info.toolCount) && info.toolCount >= 0) {
    lines.push(`本轮工具调用：${info.toolCount}次`)
  }
  return { title: 'Pion · 输出完成', body: truncate(lines.join('\n'), 600) }
}

export function formatToolPermissionNotification(
  request: ToolPermissionRequest,
  context: NotificationSessionContext = {}
): { title: string; body: string } {
  const categories = Object.entries(CATEGORY_LABELS)
    .filter(([category]) => Array.isArray(request.policyCategories) && request.policyCategories.includes(category as ToolPermissionCategory))
    .map(([, label]) => label)
  const lines = [
    `项目/工作树：${displayBasename(request.cwd) || '未命名'}`,
    ...sessionLines(context, request.sessionPath),
    `工具：${notificationText(request.toolName) || '未命名'}`,
    `类别：${categories.length ? categories.join('、') : CATEGORY_LABELS[request.category]}`
  ]
  const risks = Object.entries(RISK_LABELS).filter(([risk]) => request.risks.includes(risk as ToolPermissionRisk))
    .map(([, label]) => label)
  if (risks.length) lines.push(`风险：${risks.join('、')}`)
  if (request.subagent) lines.push('来源：子代理')
  const summary = notificationText(request.summary, 180)
  if (summary) lines.push(`请求摘要：${summary}`)
  const clock = timeoutClock(request.timeoutAt)
  if (clock) lines.push(`本地到期：${clock}`)
  return {
    title: 'Pion · 需要批准',
    body: `${truncate(lines.join('\n'), 600)}\n点击返回 Pion 确认`
  }
}
