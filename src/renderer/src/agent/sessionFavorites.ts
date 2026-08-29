/**
 * 侧栏会话收藏的本地持久化（localStorage）。
 *
 * 收藏只保存会话绝对路径，不把会话内容复制到 renderer 设置中；因此
 * 收藏项会随着会话列表刷新自动显示最新标题和预览。
 */
import type { SessionMeta } from '../../../shared/types'

const SESSION_FAVORITES_STORAGE_KEY = 'pion:session-favorites-v1'

export function readFavoriteSessionPaths(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(SESSION_FAVORITES_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) as unknown : []
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.filter((path): path is string => typeof path === 'string' && path.length > 0))]
  } catch {
    return []
  }
}

export function saveFavoriteSessionPaths(paths: string[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SESSION_FAVORITES_STORAGE_KEY, JSON.stringify([...new Set(paths)]))
  } catch {
    // best effort - favorites should never block the agent UI
  }
}

export function orderFavoriteSessions(
  sessions: SessionMeta[],
  favoritePaths: string[]
): SessionMeta[] {
  const byPath = new Map(sessions.map((session) => [session.path, session]))
  return favoritePaths.flatMap((path) => {
    const session = byPath.get(path)
    return session ? [session] : []
  })
}
