import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import { ArrowUp, AtSign, Hammer, ListTodo, ShieldAlert, Square } from 'lucide-react'
import type { AgentMode, ImageContent, SlashCommandInfo } from '../../../../shared/types'

import { buildReferenceMessage, REFERENCE_TRIGGER_RE } from './composerReferences'
import { ComposerAttachments } from './ComposerAttachments'
import { ReferenceMenu, SlashCommandMenu } from './ComposerMenus'
import { useComposerReferences } from './useComposerReferences'

interface ComposerProps {
  busy: boolean
  /** No workspace is available, so even drafting is unavailable. */
  disabled: boolean
  /** The draft stays editable while the backend/trust gate is preparing. */
  sendDisabled: boolean
  prefill: string
  /** 当前会话中的用户消息，按时间顺序用于上下键导航。 */
  history: string[]
  /** 输入框底部、工作模式左侧的项目选择器 */
  projectSelector?: ReactNode
  /** 嵌入输入框底部的控制区（模型/思考级别选择器等） */
  controls?: ReactNode
  commands: SlashCommandInfo[]
  /** Latest model request pressure for the selected session's context window. */
  contextPressure?: number
  contextTokens?: number
  contextWindow?: number
  /** Renderer-owned commands that stay available while the Agent backend prepares. */
  localCommandNames?: string[]
  mode: AgentMode
  /** Session auto-approves every tool-permission prompt. */
  yolo?: boolean
  onYoloDisable?: () => void
  onModeChange: (mode: AgentMode) => void
  onSend: (text: string, images: ImageContent[]) => void
  onQueue: (text: string, images: ImageContent[]) => void
  onAbort: () => void
}

export function Composer({
  busy,
  disabled,
  sendDisabled,
  prefill,
  history,
  projectSelector,
  controls,
  commands,
  contextPressure,
  contextTokens,
  contextWindow,
  localCommandNames = [],
  mode,
  yolo = false,
  onYoloDisable,
  onModeChange,
  onSend,
  onQueue,
  onAbort
}: ComposerProps): ReactElement {
  const [value, setValue] = useState('')
  const [commandIndex, setCommandIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const valueRef = useRef('')
  const historyIndexRef = useRef<number | null>(null)
  const historyDraftRef = useRef('')
  const {
    pendingReferences,
    pendingImages,
    referenceError,
    readingReferences,
    fileInputRef,
    handlePaste,
    handleFileInputChange,
    handleDrop,
    removeReference,
    clearReferences,
    openReferencePicker,
    insertReferenceToken
  } = useComposerReferences({ valueRef, setValue, textareaRef })

  useEffect(() => {
    valueRef.current = value
  }, [value])

  const resetHistoryNavigation = useCallback((): void => {
    historyIndexRef.current = null
    historyDraftRef.current = ''
  }, [])

  useEffect(() => {
    if (prefill) {
      resetHistoryNavigation()
      valueRef.current = prefill
      setValue(prefill)
      textareaRef.current?.focus()
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto'
          textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`
        }
      })
    }
  }, [prefill, resetHistoryNavigation])

  const moveHistory = useCallback(
    (direction: 'up' | 'down'): boolean => {
      if (history.length === 0) return false
      const currentIndex = historyIndexRef.current
      let nextIndex: number

      if (direction === 'up') {
        if (currentIndex === null) {
          historyDraftRef.current = value
          nextIndex = history.length - 1
        } else if (currentIndex > 0) {
          nextIndex = currentIndex - 1
        } else {
          return true
        }
      } else {
        if (currentIndex === null) return false
        if (currentIndex < history.length - 1) {
          nextIndex = currentIndex + 1
        } else {
          historyIndexRef.current = null
          valueRef.current = historyDraftRef.current
          setValue(historyDraftRef.current)
          requestAnimationFrame(() => {
            const element = textareaRef.current
            if (!element) return
            element.focus()
            element.setSelectionRange(element.value.length, element.value.length)
          })
          return true
        }
      }

      historyIndexRef.current = nextIndex
      const nextValue = history[nextIndex]
      valueRef.current = nextValue
      setValue(nextValue)
      requestAnimationFrame(() => {
        const element = textareaRef.current
        if (!element) return
        element.focus()
        element.setSelectionRange(nextValue.length, nextValue.length)
      })
      return true
    },
    [history, value]
  )

  const clearValue = useCallback((): void => {
    valueRef.current = ''
    setValue('')
    resetHistoryNavigation()
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }, [resetHistoryNavigation])

  const autoSize = (element: HTMLTextAreaElement): void => {
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`
  }

  const referenceMatch = value.match(REFERENCE_TRIGGER_RE)
  const referenceQuery = referenceMatch?.[2].toLocaleLowerCase() ?? null
  const referenceOptions = referenceQuery === null
    ? []
    : pendingReferences.filter((reference) => reference.name.toLocaleLowerCase().includes(referenceQuery)).slice(0, 8)

  const slashMatch = value.match(/^\s*\/([^\s]*)$/)
  const slashQuery = slashMatch?.[1].toLocaleLowerCase() ?? null
  const commandOptions = slashQuery === null
    ? []
    : commands.filter((command) => command.name.toLocaleLowerCase().startsWith(slashQuery)).slice(0, 12)
  const showCommandMenu = !disabled && commandOptions.length > 0
  const showReferenceMenu = !disabled && !showCommandMenu && referenceMatch !== null
  const invokedCommandName = value.trim().match(/^\/([^\s]+)(?:\s+[\s\S]*)?$/)?.[1]?.toLocaleLowerCase()
  const localCommandReady = Boolean(invokedCommandName && localCommandNames.includes(invokedCommandName))
  const activeCommandIndex = Math.min(commandIndex, Math.max(0, commandOptions.length - 1))
  const contextPercent = contextPressure === undefined
    ? null
    : Math.round(Math.max(0, Math.min(contextPressure, 1)) * 100)
  const contextLabel = contextPercent === null
    ? '上下文占用尚不可用'
    : `当前会话上下文已使用 ${contextPercent}%${contextTokens !== undefined && contextWindow
      ? `（${Math.round(contextTokens).toLocaleString()} / ${Math.round(contextWindow).toLocaleString()} tokens）`
      : ''}`

  useEffect(() => {
    setCommandIndex(0)
  }, [slashQuery])

  const submit = useCallback(() => {
    const text = value.trim()
    if ((text === '' && pendingReferences.length === 0) || disabled || readingReferences || (sendDisabled && !localCommandReady)) return
    onSend(
      localCommandReady ? text : buildReferenceMessage(text, pendingReferences),
      localCommandReady ? [] : pendingImages
    )
    clearValue()
    if (!localCommandReady) clearReferences()
  }, [value, pendingReferences, pendingImages, disabled, readingReferences, sendDisabled, localCommandReady, onSend, clearValue, clearReferences])

  const queue = useCallback(() => {
    const text = value.trim()
    if ((text === '' && pendingReferences.length === 0) || disabled || readingReferences || (sendDisabled && !localCommandReady)) return
    if (localCommandReady) onSend(text, [])
    else onQueue(buildReferenceMessage(text, pendingReferences), pendingImages)
    clearValue()
    if (!localCommandReady) clearReferences()
  }, [
    value,
    pendingReferences,
    pendingImages,
    disabled,
    readingReferences,
    sendDisabled,
    localCommandReady,
    onSend,
    onQueue,
    clearValue,
    clearReferences
  ])

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (showCommandMenu && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      setCommandIndex((current) => {
        const last = commandOptions.length - 1
        if (last < 0) return 0
        return event.key === 'ArrowDown'
          ? Math.min(current + 1, last)
          : Math.max(current - 1, 0)
      })
      return
    }

    if (
      showCommandMenu &&
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault()
      if (localCommandReady) submit()
      else selectSlashCommand(activeCommandIndex)
      return
    }

    // An @ reference menu is only a suggestion. Enter keeps its normal send
    // behavior; the picker opens only through an explicit click.

    if (
      event.key === 'Tab' &&
      event.ctrlKey &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault()
      if (!disabled && !sendDisabled && !busy) onModeChange(mode === 'build' ? 'plan' : 'build')
      return
    }

    const historyDirection = event.key === 'ArrowUp' ? 'up' : event.key === 'ArrowDown' ? 'down' : null
    const atHistoryBoundary = historyDirection === 'up'
      ? event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0
      : historyDirection === 'down'
        ? event.currentTarget.selectionStart === event.currentTarget.value.length &&
          event.currentTarget.selectionEnd === event.currentTarget.value.length
        : false
    if (
      historyDirection &&
      atHistoryBoundary &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.nativeEvent.isComposing &&
      moveHistory(historyDirection)
    ) {
      event.preventDefault()
      return
    }
    if (
      showCommandMenu &&
      event.key === 'Tab' &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault()
      selectSlashCommand(activeCommandIndex)
      return
    }
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && (value.trim() !== '' || pendingReferences.length > 0)) {
      event.preventDefault()
      queue()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  const selectSlashCommand = (index: number): void => {
    const command = commandOptions[index]
    if (!command) return
    resetHistoryNavigation()
    const nextValue = `/${command.name} `
    valueRef.current = nextValue
    setValue(nextValue)
    setCommandIndex(0)
    requestAnimationFrame(() => {
      const element = textareaRef.current
      if (!element) return
      autoSize(element)
      element.focus()
      element.setSelectionRange(nextValue.length, nextValue.length)
    })
  }

  return (
    <footer className="composer">
      <div className={`composer-row composer-mode-${mode}`}>
        <div className="composer-input-main">
          {showReferenceMenu && (
            <ReferenceMenu
              references={referenceOptions}
              onOpenPicker={openReferencePicker}
              onInsertToken={insertReferenceToken}
            />
          )}
          {showCommandMenu && (
            <SlashCommandMenu
              commands={commandOptions}
              activeIndex={activeCommandIndex}
              onSelect={selectSlashCommand}
            />
          )}
          <textarea
            ref={textareaRef}
            value={value}
            placeholder={disabled
              ? '请选择项目目录…'
              : sendDisabled
                ? 'Agent 正在准备，可先输入任务…'
                : mode === 'plan'
                ? '计划模式：只读收集资料并整理方案，不修改文件或创建任务… (↑↓ 编辑历史 / Tab 排队 / Ctrl+Tab 切换模式 / Enter 直接发送)'
                : '描述任务… (↑↓ 编辑历史 / Tab 排队 / Ctrl+Tab 切换模式 / Enter 直接发送)'}
            disabled={disabled}
            aria-autocomplete="list"
            aria-controls={showCommandMenu ? 'slash-command-menu' : showReferenceMenu ? 'reference-menu' : undefined}
            rows={1}
            onChange={(event) => {
              resetHistoryNavigation()
              valueRef.current = event.target.value
              setValue(event.target.value)
              autoSize(event.target)
            }}
            onPaste={handlePaste}
            onDragOver={(event) => {
              if (event.dataTransfer.files.length > 0) event.preventDefault()
            }}
            onDrop={handleDrop}
            onKeyDown={handleKeyDown}
            aria-keyshortcuts="ArrowUp ArrowDown Control+Tab"
          />
          <input
            ref={fileInputRef}
            className="composer-reference-input"
            type="file"
            accept="image/*,text/*,.bash,.c,.cc,.cfg,.conf,.cpp,.cs,.css,.csv,.dockerfile,.env,.gitignore,.go,.graphql,.gql,.h,.hpp,.htm,.html,.ini,.java,.js,.json,.jsonc,.jsx,.kt,.less,.lock,.log,.markdown,.md,.mdx,.mjs,.mts,.patch,.php,.py,.rb,.rs,.sass,.scss,.sh,.sql,.svelte,.swift,.toml,.ts,.tsx,.txt,.vue,.xml,.yaml,.yml,.zsh"
            multiple
            tabIndex={-1}
            aria-label="选择图像或参考文件"
            onChange={handleFileInputChange}
          />
          {(pendingReferences.length > 0 || referenceError || readingReferences) && (
            <ComposerAttachments
              references={pendingReferences}
              pendingImages={pendingImages}
              reading={readingReferences}
              error={referenceError}
              onRemove={removeReference}
            />
          )}
          <div className="composer-inline-controls">
            <button
              type="button"
              className="composer-reference-trigger"
              disabled={disabled || readingReferences}
              aria-label="添加图像或参考文件"
              title="添加 @ 图像或文本参考文件"
              onMouseDown={(event) => event.preventDefault()}
              onClick={openReferencePicker}
            >
              <AtSign size={13} />
              <span>参考</span>
            </button>
            {projectSelector}
            <div className="composer-mode-picker" role="group" aria-label="工作模式">
              <button
                type="button"
                data-mode="build"
                className={`composer-mode-option${mode === 'build' ? ' active' : ''}`}
                aria-pressed={mode === 'build'}
                disabled={disabled || sendDisabled || busy}
                title={mode === 'plan' ? '确认方案后切回构建模式（不会自动执行）' : '构建模式：允许修改项目文件'}
                onClick={() => onModeChange('build')}
              >
                <Hammer size={12} />
                <span>构建</span>
              </button>
              <button
                type="button"
                data-mode="plan"
                className={`composer-mode-option${mode === 'plan' ? ' active' : ''}`}
                aria-pressed={mode === 'plan'}
                disabled={disabled || sendDisabled || busy}
                title="计划模式：只读收集资料并制定方案，不修改文件或创建任务"
                onClick={() => onModeChange('plan')}
              >
                <ListTodo size={12} />
                <span>计划</span>
              </button>
            </div>
            {yolo && (
              <button
                type="button"
                className="composer-yolo-badge"
                title="YOLO 模式已开启：自动批准本会话所有工具权限请求，点击关闭"
                onClick={() => onYoloDisable?.()}
              >
                <ShieldAlert size={12} />
                <span>YOLO</span>
              </button>
            )}
            {controls}
          </div>
        </div>
        <div
          className={`send-button-context${contextPercent !== null && contextPercent >= 80 ? ' pressure-high' : ''}`}
          title={contextLabel}
        >
          <svg
            className="send-context-ring"
            viewBox="0 0 48 48"
            role={contextPercent === null ? undefined : 'progressbar'}
            aria-label={contextPercent === null ? undefined : contextLabel}
            aria-valuemin={contextPercent === null ? undefined : 0}
            aria-valuemax={contextPercent === null ? undefined : 100}
            aria-valuenow={contextPercent ?? undefined}
          >
            <circle className="send-context-track" cx="24" cy="24" r="22" pathLength="100" />
            {contextPercent !== null && (
              <circle
                className="send-context-progress"
                cx="24"
                cy="24"
                r="22"
                pathLength="100"
                style={{ strokeDashoffset: 100 - contextPercent }}
              />
            )}
          </svg>
          <button
            className={`send-button${busy ? ' stop-mode' : ''}`}
            onClick={busy ? onAbort : submit}
            disabled={!busy && (disabled || readingReferences || (sendDisabled && !localCommandReady) || (value.trim() === '' && pendingReferences.length === 0))}
            aria-label={busy ? '停止当前会话' : '发送消息 · Enter 直接发送'}
            title={busy
              ? `停止当前会话 · ${contextLabel}`
              : `${sendDisabled && !localCommandReady ? 'Agent 正在准备，输入内容会保留' : 'Enter 直接发送'} · ${contextLabel}`}
          >
            {busy
              ? <Square size={14} fill="currentColor" strokeWidth={0} />
              : <ArrowUp size={16} />}
          </button>
        </div>
      </div>
    </footer>
  )
}
