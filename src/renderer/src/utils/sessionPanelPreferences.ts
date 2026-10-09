export type SessionPanelKind = 'task' | 'queue'

function stateKey(kind: SessionPanelKind, sessionKey: string): string {
  return `pion:session-${kind}-panel-state:${encodeURIComponent(sessionKey)}`
}

/** Keep the existing task-collapsed / queue-expanded defaults and storage keys. */
export function loadPanelExpanded(kind: SessionPanelKind, sessionKey: string): boolean {
  const fallback = kind === 'queue'
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(stateKey(kind, sessionKey))
    const saved: unknown = raw === null ? undefined : JSON.parse(raw)
    return typeof saved === 'boolean' ? saved : fallback
  } catch {
    return fallback
  }
}

export function savePanelExpanded(kind: SessionPanelKind, sessionKey: string, expanded: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(stateKey(kind, sessionKey), JSON.stringify(expanded))
  } catch {
    // Best effort: neither storage nor key encoding failures may block the UI.
  }
}
