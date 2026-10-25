import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Check, X } from 'lucide-react'
import { containModalTab, isTopmostModalDialog } from '../../utils/dialogFocus'

export type CommandDialogEntry = {
  id: string
  label: string
  detail?: string
  selected?: boolean
  disabled?: boolean
}

export interface CommandDialogProps {
  open: boolean
  requestId: number
  title: string
  description?: string
  entries?: CommandDialogEntry[]
  text?: string
  loading?: boolean
  error?: string
  busy?: boolean
  searchPlaceholder?: string
  initialQuery?: string
  onSelect?: (id: string) => void
  onClose: () => void
}

const MAX_VISIBLE_ENTRIES = 200
const MODAL_DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'

/** Presentation only: IDs are opaque, text is never interpreted, and filtering is local. */
export function CommandDialog({
  open,
  requestId,
  title,
  description,
  entries,
  text,
  loading = false,
  error,
  busy = false,
  searchPlaceholder = '搜索名称或说明…',
  initialQuery = '',
  onSelect,
  onClose
}: CommandDialogProps): ReactElement | null {
  const [search, setSearch] = useState({ requestId, query: initialQuery, page: 0 })
  // A streaming update (including initialQuery changes) must not reset a user's search.
  const query = search.requestId === requestId ? search.query : initialQuery
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return (entries ?? []).filter((entry) => !needle ||
      entry.label.toLocaleLowerCase().includes(needle) ||
      entry.detail?.toLocaleLowerCase().includes(needle))
  }, [entries, query])
  const lastPage = Math.max(0, Math.ceil(filtered.length / MAX_VISIBLE_ENTRIES) - 1)
  const page = Math.min(search.requestId === requestId ? search.page : 0, lastPage)
  // Persist the clamp so a shorter directory cannot revive an old page when it grows again.
  if (search.requestId !== requestId || search.page !== page) setSearch({ requestId, query, page })
  const pageStart = page * MAX_VISIBLE_ENTRIES
  const visibleEntries = filtered.slice(pageStart, pageStart + MAX_VISIBLE_ENTRIES)
  const dialogRef = useRef<HTMLElement>(null)
  const entriesRef = useRef<HTMLUListElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const controlsRef = useRef({ busy, onClose })
  const composingRef = useRef<HTMLInputElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()
  const searchId = useId()
  const entriesId = useId()

  useLayoutEffect(() => {
    controlsRef.current = { busy, onClose }
  }, [busy, onClose])

  useLayoutEffect(() => {
    // Reset only this result viewport; never scroll an ancestor, the document or chat.
    if (open && entriesRef.current) entriesRef.current.scrollTop = 0
  }, [open, requestId, query, page])

  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (!dialog) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!isTopmostModalDialog(dialog)) return
      if (event.key === 'Tab') {
        if (document.activeElement === dialog) {
          // The dialog itself is not a tab stop, even though it contains the active element.
          const focusable = dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')
          const target = event.shiftKey ? focusable[focusable.length - 1] : focusable[0]
          event.preventDefault()
          target?.focus({ preventScroll: true })
        } else {
          containModalTab(event, dialog)
        }
        // Keep Tab away from lower modals and Composer, including before initial focus.
        event.stopImmediatePropagation()
        return
      }
      if (event.key !== 'Escape' && event.key !== 'Enter') return
      event.stopImmediatePropagation()
      if (event.isComposing || event.keyCode === 229 ||
        (composingRef.current !== null && composingRef.current === searchRef.current)) return
      // Consume the key before a callback can close the portal and restore Composer focus.
      event.preventDefault()
      if (event.repeat) return
      if (event.key === 'Escape') {
        if (!controlsRef.current.busy) controlsRef.current.onClose()
        return
      }
      if (!(event.target instanceof Element) || !dialog.contains(event.target)) return
      const button = event.target === searchRef.current
        ? dialog.querySelector<HTMLButtonElement>('[data-command-entry]:not(:disabled)')
        : event.target.closest('button')
      if (button instanceof HTMLButtonElement && !button.disabled) button.click()
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      composingRef.current = null
      window.removeEventListener('keydown', handleKeyDown, true)
      // A new request keeps this opening's restore target; a newer modal owns its focus.
      const canRestore = dialog.isConnected
        ? isTopmostModalDialog(dialog)
        : !document.querySelector(MODAL_DIALOG_SELECTOR) ||
          isTopmostModalDialog(previousFocus?.closest<HTMLElement>(MODAL_DIALOG_SELECTOR) ?? null)
      if (canRestore && previousFocus?.isConnected &&
        (document.activeElement === document.body || dialog.contains(document.activeElement))) {
        previousFocus.focus({ preventScroll: true })
      }
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (!dialog) return
    const activeAtRequest = document.activeElement
    const frame = requestAnimationFrame(() => {
      if (!isTopmostModalDialog(dialog)) return
      // Respect focus the user moved within the new content before this frame.
      if (dialog.contains(document.activeElement) && document.activeElement !== activeAtRequest) return
      const target = searchRef.current ?? (closeRef.current?.disabled ? null : closeRef.current) ?? dialog
      target.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [open, requestId])

  if (!open) return null

  const close = (): void => {
    if (!busy && isTopmostModalDialog(dialogRef.current)) onClose()
  }

  const changePage = (offset: number): void => {
    if (busy || loading || !isTopmostModalDialog(dialogRef.current)) return
    const nextPage = Math.min(lastPage, Math.max(0, page + offset))
    if (nextPage === page) return
    // The pressed pager may become disabled. Keep focus on a stable, local control.
    searchRef.current?.focus({ preventScroll: true })
    setSearch({ requestId, query, page: nextPage })
  }

  return createPortal(
    <div
      className="command-dialog-backdrop"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        event.stopPropagation()
        if (event.target !== event.currentTarget) return
        event.preventDefault()
        close()
      }}
    >
      <section
        ref={dialogRef}
        className="command-dialog"
        role="dialog"
        tabIndex={-1}
        data-modal-layer="320"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        aria-busy={loading || busy}
      >
        <header className="command-dialog-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <button
            ref={closeRef}
            type="button"
            className="command-dialog-close"
            aria-label={`关闭${title}`}
            disabled={busy}
            onClick={close}
          ><X size={16} aria-hidden="true" /></button>
        </header>
        <div className="command-dialog-body">
          {entries !== undefined && (
            <label className="command-dialog-search" htmlFor={searchId}>
              <span>搜索</span>
              <input
                ref={searchRef}
                id={searchId}
                type="search"
                value={query}
                placeholder={searchPlaceholder}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setSearch({ requestId, query: event.target.value, page: 0 })}
                onCompositionStart={(event) => { composingRef.current = event.currentTarget }}
                onCompositionEnd={() => { composingRef.current = null }}
              />
            </label>
          )}
          {error && <p className="command-dialog-error" role="alert">{error}</p>}
          {(loading || busy) && <p className="command-dialog-status" role="status">{loading ? '正在加载…' : '处理中…'}</p>}
          {entries !== undefined && (
            <>
              {visibleEntries.length > 0 ? (
                <ul ref={entriesRef} id={entriesId} className="command-dialog-entries" aria-label="可选项">
                  {visibleEntries.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className="command-dialog-entry"
                        data-command-entry=""
                        aria-label={entry.detail ? `${entry.label} ${entry.detail}` : entry.label}
                        aria-pressed={entry.selected === true}
                        disabled={busy || loading || entry.disabled || !onSelect}
                        onClick={() => {
                          if (!busy && !loading && !entry.disabled && onSelect && isTopmostModalDialog(dialogRef.current)) {
                            onSelect(entry.id)
                          }
                        }}
                      >
                        <span className="command-dialog-entry-copy">
                          <strong>{entry.label}</strong>
                          {entry.detail && <span>{entry.detail}</span>}
                        </span>
                        {entry.selected && <span className="command-dialog-current" aria-hidden="true"><Check size={13} />当前</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : !loading && <p className="command-dialog-status" role="status">{query.trim() ? '没有匹配的项目。' : '暂无可选项目。'}</p>}
              {filtered.length > 0 && (
                <nav className="command-dialog-pagination" aria-label="候选项分页">
                  <button
                    type="button"
                    className="command-dialog-page"
                    aria-controls={entriesId}
                    disabled={busy || loading || page === 0}
                    onClick={() => changePage(-1)}
                  >上一页</button>
                  <span className="command-dialog-range" aria-live="polite" aria-atomic="true">
                    第 {pageStart + 1}–{pageStart + visibleEntries.length} 项，共 {filtered.length} 项
                  </span>
                  <button
                    type="button"
                    className="command-dialog-page"
                    aria-controls={entriesId}
                    disabled={busy || loading || page === lastPage}
                    onClick={() => changePage(1)}
                  >下一页</button>
                </nav>
              )}
            </>
          )}
          {text !== undefined && <pre className="command-dialog-text" role="region" aria-label="命令信息" tabIndex={0}>{text}</pre>}
        </div>
      </section>
    </div>,
    document.body
  )
}
