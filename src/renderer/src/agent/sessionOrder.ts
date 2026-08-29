/**
 * 侧栏会话排序的本地持久化（localStorage）。
 *
 * 顺序按项目 cwd 分组保存；未知会话按不可变的创建时间稳定追加，
 * 因此“刚打开”不会把会话顶到最上面。
 */
import type { SessionMeta } from '../../../shared/types'

const SESSION_ORDER_STORAGE_KEY = 'pion:session-order-v2'

type SessionOrderMap = Record<string, string[]>

function readSessionOrderMap(): SessionOrderMap {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(SESSION_ORDER_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) as unknown : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([, paths]) => (
        Array.isArray(paths) && paths.every((path) => typeof path === 'string')
      ))
    ) as SessionOrderMap
  } catch {
    return {}
  }
}

function writeSessionOrderMap(map: SessionOrderMap): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SESSION_ORDER_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // best effort - ordering should never block the agent UI
  }
}

function sessionCreatedTime(session: SessionMeta): number {
  const timestamp = Date.parse(session.timestamp)
  return Number.isFinite(timestamp) ? timestamp : session.mtime
}

export function orderSessions(sessions: SessionMeta[], previous: SessionMeta[] = []): SessionMeta[] {
  if (sessions.length <= 1) return sessions
  const projectCwd = sessions[0]?.projectCwd
  if (!projectCwd) return sessions

  const currentPaths = new Set(sessions.map((session) => session.path))
  const saved = readSessionOrderMap()[projectCwd] ?? []
  const orderedPaths: string[] = []
  const seen = new Set<string>()
  for (const path of [...saved, ...previous.map((session) => session.path)]) {
    if (currentPaths.has(path) && !seen.has(path)) {
      seen.add(path)
      orderedPaths.push(path)
    }
  }

  // Pi returns sessions by last activity. New sessions must not jump to the
  // top merely because they were just opened, so unknown sessions use their
  // immutable creation time and are appended in that stable order.
  const newSessions = sessions
    .filter((session) => !seen.has(session.path))
    .sort((a, b) => sessionCreatedTime(a) - sessionCreatedTime(b) || a.path.localeCompare(b.path))
  for (const session of newSessions) {
    seen.add(session.path)
    orderedPaths.push(session.path)
  }

  const map = new Map(sessions.map((session) => [session.path, session]))
  return orderedPaths.flatMap((path) => {
    const session = map.get(path)
    return session ? [session] : []
  })
}

export function reorderSessionsByPaths(sessions: SessionMeta[], paths: string[]): SessionMeta[] {
  const byPath = new Map(sessions.map((session) => [session.path, session]))
  const ordered = paths.flatMap((path) => {
    const session = byPath.get(path)
    return session ? [session] : []
  })
  const included = new Set(ordered.map((session) => session.path))
  return [...ordered, ...sessions.filter((session) => !included.has(session.path))]
}

export function saveSessionOrder(projectCwd: string, paths: string[]): void {
  const map = readSessionOrderMap()
  map[projectCwd] = [...new Set(paths)]
  writeSessionOrderMap(map)
}
