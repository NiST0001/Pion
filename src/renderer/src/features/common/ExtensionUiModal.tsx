import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { CircleHelp, CornerDownLeft, X } from 'lucide-react'
import type { ExtensionUiRequest, ExtensionUiResponse } from '../../../../shared/types'
import { QUESTION_CUSTOM_ANSWER_OPTION, supportsCustomQuestionAnswer } from '../../../../shared/question-answer'
import { containModalTab, isTopmostModalDialog } from '../../utils/dialogFocus'
import { SessionInteractionPanel } from './SessionInteractionPanel'

const MODAL_DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'

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
  active = true,
  onResolve
}: {
  request: ExtensionUiRequest
  queueLength: number
  busy: boolean
  error: string
  active?: boolean
  onResolve(response: ExtensionUiResponse): void
}): ReactElement {
  const titleId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const primaryRef = useRef<HTMLElement>(null)
  const activeRef = useRef(active)
  const busyRef = useRef(busy)
  const onResolveRef = useRef(onResolve)
  const modeFocusRequestRef = useRef<string | null>(null)
  const [value, setValue] = useState(request.prefill ?? '')
  const [customInput, setCustomInput] = useState(false)
  const [, setClock] = useState(0)
  const global = request.scope === 'global'
  const providerAuth = request.source === 'provider-auth'
  const disabled = busy || !active
  const supportsCustomAnswer = supportsCustomQuestionAnswer(request)
  const customAnswer = supportsCustomAnswer && customInput
  activeRef.current = active

  useEffect(() => {
    busyRef.current = busy
    onResolveRef.current = onResolve
  }, [busy, onResolve])

  useEffect(() => {
    setValue(request.prefill ?? '')
  }, [request.id, request.prefill])

  useEffect(() => {
    setCustomInput(false)
    modeFocusRequestRef.current = null
  }, [request.id])

  useEffect(() => {
    if (modeFocusRequestRef.current !== request.id) return
    modeFocusRequestRef.current = null
    const target = primaryRef.current
    if (!disabled && target?.isConnected && !target.closest('[hidden], [inert]') &&
      !document.querySelector(MODAL_DIALOG_SELECTOR)) target.focus({ preventScroll: true })
  }, [customInput, disabled, request.id])

  useEffect(() => {
    if (!active || !request.question || request.timeoutAt === null) return
    const interval = window.setInterval(() => setClock((value) => value + 1), 1_000)
    return () => window.clearInterval(interval)
  }, [active, request.question, request.timeoutAt])

  useEffect(() => {
    if (!active || !global) return
    const dialog = dialogRef.current
    if (!dialog) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => {
      if (activeRef.current && isTopmostModalDialog(dialog)) {
        (primaryRef.current ?? dialog).focus({ preventScroll: true })
      }
    })
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!activeRef.current || !isTopmostModalDialog(dialog)) return
      if (event.key === 'Tab') {
        containModalTab(event, dialog)
        return
      }
      if (event.key !== 'Escape' || busyRef.current || event.isComposing || event.keyCode === 229) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!event.repeat) onResolveRef.current({ cancelled: true })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown, true)
      const canRestore = dialog.isConnected ? isTopmostModalDialog(dialog) :
        !document.querySelector(MODAL_DIALOG_SELECTOR) ||
          isTopmostModalDialog(previousFocus?.closest<HTMLElement>(MODAL_DIALOG_SELECTOR) ?? null)
      if (activeRef.current && canRestore && previousFocus?.isConnected &&
        (document.activeElement === document.body || dialog.contains(document.activeElement))) {
        previousFocus.focus({ preventScroll: true })
      }
    }
  }, [active, global, request.id])

  const resolve = (response: ExtensionUiResponse): void => {
    if (!disabled) onResolve(response)
  }
  const switchAnswerMode = (custom: boolean): void => {
    if (disabled) return
    modeFocusRequestRef.current = request.id
    setCustomInput(custom)
  }
  const submitText = (): void => {
    if (value.trim()) resolve(customAnswer ? { customAnswer: value.trim() } : { value: value.trim() })
  }
  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    submitText()
  }
  const waitLabel = request.question
    ? request.timeoutAt === null ? '不自动超时' : `${Math.max(0, Math.ceil((request.timeoutAt - Date.now()) / 1_000))} 秒后超时`
    : undefined

  const content = (
    <>
      {global && (
        <header className="extension-ui-head">
          <span className="extension-ui-icon"><CircleHelp size={16} /></span>
          <div>
            <span>{providerAuth ? 'Pi 提供商认证' : 'Agent 需要你的选择'}{queueLength > 1 ? ` · 还有 ${queueLength - 1} 项` : ''}</span>
            <h2 id={titleId}>{request.title}</h2>
            {request.question && request.timeoutAt === null && <span>等待回答，不自动超时；仍可取消。</span>}
          </div>
          <button
            type="button"
            aria-label={providerAuth ? '取消提供商认证' : '取消 Agent 交互'}
            disabled={disabled}
            onClick={() => resolve({ cancelled: true })}
          >
            <X size={15} />
          </button>
        </header>
      )}

      <div className="extension-ui-body">
        {!global && waitLabel && <p className="extension-ui-wait">等待回答，{waitLabel}；仍可取消。</p>}
        {request.method === 'select' && !customAnswer && (
          <div className="extension-ui-options" role="listbox" aria-label="可选答案">
            {request.options?.map((option, index) => {
              const parts = optionParts(option)
              return (
                <button
                  ref={index === 0 ? (element) => { primaryRef.current = element } : undefined}
                  type="button"
                  role="option"
                  key={`${index}:${option}`}
                  disabled={disabled}
                  onClick={() => supportsCustomAnswer && option === QUESTION_CUSTOM_ANSWER_OPTION
                    ? switchAnswerMode(true)
                    : resolve({ value: option })}
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

        {(request.method === 'input' || customAnswer) && (
          <input
            ref={(element) => { primaryRef.current = element }}
            type={request.secret ? 'password' : 'text'}
            value={value}
            placeholder={customAnswer ? '输入自定义回答…' : request.placeholder}
            aria-label={request.title}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={active ? onInputKeyDown : undefined}
          />
        )}

        {request.method === 'editor' && (
          <textarea
            ref={(element) => { primaryRef.current = element }}
            value={value}
            placeholder="输入自定义回答…"
            aria-label={request.title}
            disabled={disabled}
            rows={6}
            onChange={(event) => setValue(event.target.value)}
          />
        )}

        {error && <div className="extension-ui-error">{error}</div>}
      </div>

      {(!global || request.method !== 'select') && (
        <footer className="extension-ui-actions">
          {customAnswer && (
            <button type="button" disabled={disabled} onClick={() => switchAnswerMode(false)}>返回选项</button>
          )}
          {!global && request.method === 'confirm' && (
            <button type="button" disabled={disabled} aria-label="取消 Agent 交互" onClick={() => resolve({ cancelled: true })}>
              <X size={12} />取消
            </button>
          )}
          <button
            ref={request.method === 'confirm' ? (element) => { primaryRef.current = element } : undefined}
            type="button"
            aria-label={!global && request.method !== 'confirm' ? '取消 Agent 交互' : undefined}
            disabled={disabled}
            onClick={() => resolve(request.method === 'confirm' ? { confirmed: false } : { cancelled: true })}
          >
            {request.method === 'confirm' ? '否' : '取消'}
          </button>
          {(request.method !== 'select' || customAnswer) && (
            <button
              type="button"
              className="extension-ui-submit"
              disabled={disabled || (request.method !== 'confirm' && !value.trim())}
              onClick={() => request.method === 'confirm' ? resolve({ confirmed: true }) : submitText()}
            >
              {request.method === 'confirm' ? '确认' : <><CornerDownLeft size={12} />提交回答</>}
            </button>
          )}
        </footer>
      )}
    </>
  )

  if (!global) return (
    <SessionInteractionPanel
      active={active}
      backdropClassName="extension-ui-backdrop"
      className={`extension-ui-dialog method-${request.method}`}
      icon={<CircleHelp size={16} />}
      label={`Agent 提问${queueLength > 1 ? ` · 还有 ${queueLength - 1} 项` : ''}`}
      title={request.title}
      meta={waitLabel || error ? <>{waitLabel && <span>{waitLabel}</span>}{error && <span className="session-interaction-error">提交失败</span>}</> : undefined}
    >
      {content}
    </SessionInteractionPanel>
  )

  return (
    <div className="extension-ui-backdrop is-global" hidden={!active} inert={!active}>
      <section
        ref={dialogRef}
        className={`extension-ui-dialog method-${request.method}`}
        role="dialog"
        tabIndex={-1}
        data-modal-layer="141"
        aria-modal={active ? true : undefined}
        aria-labelledby={titleId}
      >
        {content}
      </section>
    </div>
  )
}
