import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { CircleHelp, CornerDownLeft, X } from 'lucide-react'
import type { ExtensionUiRequest, ExtensionUiResponse } from '../../../../shared/types'
import { containModalTab, isTopmostModalDialog } from '../../utils/dialogFocus'

function optionParts(option: string): { label: string; description?: string } {
  const divider = option.indexOf(' — ')
  return divider < 0
    ? { label: option }
    : { label: option.slice(0, divider), description: option.slice(divider + 3) }
}

export function ExtensionUiModal({
  request,
  queueLength,
  busy,
  error,
  onResolve
}: {
  request: ExtensionUiRequest
  queueLength: number
  busy: boolean
  error: string
  onResolve(response: ExtensionUiResponse): void
}): ReactElement {
  const dialogRef = useRef<HTMLElement>(null)
  const primaryRef = useRef<HTMLElement>(null)
  const busyRef = useRef(busy)
  const onResolveRef = useRef(onResolve)
  const [value, setValue] = useState(request.prefill ?? '')

  useEffect(() => {
    busyRef.current = busy
    onResolveRef.current = onResolve
  }, [busy, onResolve])

  useEffect(() => {
    setValue(request.prefill ?? '')
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => primaryRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent): void => {
      const dialog = dialogRef.current
      if (!dialog || !isTopmostModalDialog(dialog)) return
      if (event.key === 'Tab') {
        containModalTab(event, dialog)
        return
      }
      if (event.key !== 'Escape' || busyRef.current) return
      event.preventDefault()
      event.stopImmediatePropagation()
      onResolveRef.current({ cancelled: true })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown, true)
      previousFocus?.focus()
    }
  }, [request.id, request.prefill])

  const submitText = (): void => {
    if (!busy && value.trim()) onResolve({ value: value.trim() })
  }
  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    submitText()
  }

  const providerAuth = request.source === 'provider-auth'

  return (
    <div className={`extension-ui-backdrop${request.scope === 'global' ? ' is-global' : ''}`}>
      <section
        ref={dialogRef}
        className={`extension-ui-dialog method-${request.method}`}
        role="dialog"
        tabIndex={-1}
        data-modal-layer={request.scope === 'global' ? '141' : '31'}
        aria-modal="true"
        aria-labelledby="extension-ui-title"
      >
        <header className="extension-ui-head">
          <span className="extension-ui-icon"><CircleHelp size={16} /></span>
          <div>
            <span>{providerAuth ? 'Pi 提供商认证' : 'Agent 需要你的选择'}{queueLength > 1 ? ` · 还有 ${queueLength - 1} 项` : ''}</span>
            <h2 id="extension-ui-title">{request.title}</h2>
          </div>
          <button
            type="button"
            aria-label={providerAuth ? '取消提供商认证' : '取消 Agent 交互'}
            disabled={busy}
            onClick={() => onResolve({ cancelled: true })}
          >
            <X size={15} />
          </button>
        </header>

        <div className="extension-ui-body">
          {request.method === 'select' && (
            <div className="extension-ui-options" role="listbox" aria-label="可选答案">
              {request.options?.map((option, index) => {
                const parts = optionParts(option)
                return (
                  <button
                    ref={index === 0 ? (element) => { primaryRef.current = element } : undefined}
                    type="button"
                    role="option"
                    key={`${index}:${option}`}
                    disabled={busy}
                    onClick={() => onResolve({ value: option })}
                  >
                    <strong>{parts.label}</strong>
                    {parts.description && <span>{parts.description}</span>}
                  </button>
                )
              })}
            </div>
          )}

          {request.method === 'confirm' && (
            <div className="extension-ui-confirm-message">{request.message}</div>
          )}

          {request.method === 'input' && (
            <input
              ref={(element) => { primaryRef.current = element }}
              type={request.secret ? 'password' : 'text'}
              value={value}
              placeholder={request.placeholder}
              aria-label={request.title}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={onInputKeyDown}
            />
          )}

          {request.method === 'editor' && (
            <textarea
              ref={(element) => { primaryRef.current = element }}
              value={value}
              placeholder="输入自定义回答…"
              aria-label={request.title}
              disabled={busy}
              rows={6}
              onChange={(event) => setValue(event.target.value)}
            />
          )}

          {error && <div className="extension-ui-error">{error}</div>}
        </div>

        {request.method !== 'select' && (
          <footer className="extension-ui-actions">
            <button
              ref={request.method === 'confirm' ? (element) => { primaryRef.current = element } : undefined}
              type="button"
              disabled={busy}
              onClick={() => (
                request.method === 'confirm'
                  ? onResolve({ confirmed: false })
                  : onResolve({ cancelled: true })
              )}
            >
              {request.method === 'confirm' ? '否' : '取消'}
            </button>
            <button
              type="button"
              className="extension-ui-submit"
              disabled={busy || (request.method !== 'confirm' && !value.trim())}
              onClick={() => request.method === 'confirm'
                ? onResolve({ confirmed: true })
                : submitText()}
            >
              {request.method === 'confirm' ? '确认' : <><CornerDownLeft size={12} />提交回答</>}
            </button>
          </footer>
        )}
      </section>
    </div>
  )
}
