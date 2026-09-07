import { useState } from 'react'
import type { ReactNode } from 'react'

const MIME = 'application/x-pion-sidebar-order'
const PREFIX = 'pion:sidebar-order:'

function readOrder(scope: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PREFIX + scope) ?? '[]')
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []
  } catch { return [] }
}

export function orderedKeys(keys: string[], saved: string[]): string[] {
  const available = new Set(keys)
  return [...new Set([...saved.filter((key) => available.has(key)), ...keys])]
}

export function moveSidebarKey(keys: string[], source: string, target: string): string[] {
  const from = keys.indexOf(source)
  const to = keys.indexOf(target)
  if (from < 0 || to < 0 || from === to) return keys
  const next = [...keys]
  next.splice(from, 1)
  next.splice(to, 0, source)
  return next
}

/** Drag only marked headers. Distinct scope payloads isolate nested lists. */
export function SortableSidebarGroup<T>({ scope, kind, items, allKeys, getKey, children }: {
  scope: string
  kind: 'project' | 'branch'
  items: T[]
  allKeys: string[]
  getKey: (item: T) => string
  children: (item: T) => ReactNode
}) {
  const [saved, setSaved] = useState(() => readOrder(scope))
  const [dragged, setDragged] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const keys = orderedKeys(allKeys, saved)
  const byKey = new Map(items.map((item) => [getKey(item), item]))
  const clear = () => { setDragged(null); setOver(null) }
  return <>{keys.map((key) => {
    const item = byKey.get(key)
    if (!item) return null
    return <div key={key}
      className={`sidebar-sort-item${dragged === key ? ' is-dragging' : ''}${over === key ? ' is-drop-target' : ''}`}
      onDragStart={(event) => {
        const header = (event.target as HTMLElement).closest('[data-sidebar-drag-kind]')
        if (header?.getAttribute('data-sidebar-drag-kind') !== kind) return
        event.stopPropagation()
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(MIME, JSON.stringify({ scope, key }))
        setDragged(key)
      }}
      onDragOver={(event) => {
        if (!dragged || !event.dataTransfer.types.includes(MIME)) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        setOver(key === dragged ? null : key)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null)
      }}
      onDrop={(event) => {
        if (!dragged) return
        event.preventDefault()
        event.stopPropagation()
        try {
          const payload = JSON.parse(event.dataTransfer.getData(MIME))
          if (payload.scope !== scope || payload.key !== dragged) return
          const next = moveSidebarKey(keys, dragged, key)
          setSaved(next)
          try { localStorage.setItem(PREFIX + scope, JSON.stringify(next)) } catch { /* best effort */ }
        } catch { /* foreign drag payload */ }
        finally { clear() }
      }}
      onDragEnd={(event) => { if (dragged) { event.stopPropagation(); clear() } }}
    >{children(item)}</div>
  })}</>
}
