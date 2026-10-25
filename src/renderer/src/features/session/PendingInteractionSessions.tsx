import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { CircleHelp } from 'lucide-react'
import type { ExtensionUiRequest, SessionMeta, ToolPermissionRequest } from '../../../../shared/types'

export interface PendingInteractionSessionsProps {
  toolPermissionRequests: readonly ToolPermissionRequest[]
  extensionUiRequests: readonly ExtensionUiRequest[]
  sessionsByProject: Readonly<Record<string, readonly SessionMeta[]>>
  sessions?: readonly SessionMeta[]
  onSelectSession: (cwd: string, path: string) => void
}

interface PendingSession {
  cwd: string
  path: string
  fallback: string
  questions: Set<string>
  permissions: Set<string>
}

export function PendingInteractionSessions({
  toolPermissionRequests, extensionUiRequests, sessionsByProject, sessions = [], onSelectSession
}: PendingInteractionSessionsProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const focusFirst = useRef(false)
  const id = useId()
  const targets = new Map<string, PendingSession>()
  const add = (request: ToolPermissionRequest | ExtensionUiRequest, kind: 'questions' | 'permissions', fallback: string) => {
    if (!request.cwd.trim() || !request.sessionPath?.trim()) return
    const key = JSON.stringify([request.cwd, request.sessionPath])
    let target = targets.get(key)
    if (!target) {
      target = { cwd: request.cwd, path: request.sessionPath, fallback, questions: new Set(), permissions: new Set() }
      targets.set(key, target)
    }
    if (!target.fallback.trim()) target.fallback = fallback
    target[kind].add(request.id)
  }
  for (const request of extensionUiRequests) {
    if (request.scope !== 'global' && request.source !== 'provider-auth') add(request, 'questions', request.title)
  }
  for (const request of toolPermissionRequests) add(request, 'permissions', request.summary)

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      if (root.current?.contains(document.activeElement)) {
        event.preventDefault()
        event.stopPropagation()
        trigger.current?.focus({ preventScroll: true })
      }
      setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  useLayoutEffect(() => {
    if (open && focusFirst.current) {
      focusFirst.current = false
      list.current?.querySelector<HTMLButtonElement>('button')?.focus()
    }
  }, [open])

  return (
    <div
      className="pending-interaction-jump"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="sidebar-settings pending-interaction-trigger"
        data-pending={targets.size > 0}
        aria-label={`待处理请求（${targets.size}个会话）`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(value => !value)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return
          event.preventDefault()
          if (open) list.current?.querySelector<HTMLButtonElement>('button')?.focus()
          else {
            focusFirst.current = true
            setOpen(true)
          }
        }}
      >
        <CircleHelp size={16} aria-hidden="true" />
        <span className="pending-interaction-label">待处理请求</span>
        <span className="pending-interaction-count">{targets.size}</span>
      </button>
      {open && (
        <div id={id} className="pending-interaction-popover" role="region" aria-label="待处理请求会话" ref={list}>
          {targets.size === 0 ? <div className="pending-interaction-empty">暂无待处理请求</div> : (
            <div className="pending-interaction-list">
              {Array.from(targets, ([key, target]) => {
                const meta = sessionsByProject[target.cwd]?.find(session => session.path === target.path
                  && (!session.projectCwd || session.projectCwd === target.cwd))
                  ?? sessions.find(session => session.projectCwd === target.cwd && session.path === target.path)
                const title = meta?.name?.trim() || meta?.preview?.trim() || target.fallback.trim()
                  || target.path.split(/[\\/]/).filter(Boolean).pop() || target.path
                return (
                  <button
                    key={key}
                    type="button"
                    className="pending-interaction-session"
                    onClick={() => {
                      setOpen(false)
                      onSelectSession(target.cwd, target.path)
                    }}
                  >
                    <span className="pending-interaction-title" title={title}>{title}</span>
                    <span className="pending-interaction-cwd" title={target.cwd}>{target.cwd}</span>
                    <span className="pending-interaction-kinds">
                      {target.questions.size > 0 && <span>提问 {target.questions.size}</span>}
                      {target.permissions.size > 0 && <span>权限 {target.permissions.size}</span>}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
