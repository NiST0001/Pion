import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import { ArrowUp, Hammer, ListTodo, Square } from 'lucide-react'
import type { AgentMode, SlashCommandInfo } from '../../../shared/types'

interface ComposerProps {
  busy: boolean
  queued: { steering: number; followUp: number }
  disabled: boolean
  prefill: string
  /** 当前会话中的用户消息，按时间顺序用于上下键导航。 */
  history: string[]
  /** 输入框底部、工作模式左侧的项目选择器 */
  projectSelector?: ReactNode
  /** 嵌入输入框底部的控制区（模型/思考级别选择器等） */
  controls?: ReactNode
  commands: SlashCommandInfo[]
  mode: AgentMode
  onModeChange: (mode: AgentMode) => void
  onSend: (text: string) => void
  onQueue: (text: string) => void
  onAbort: () => void
}

export function Composer({
  busy,
  queued,
  disabled,
  prefill,
  history,
  projectSelector,
  controls,
  commands,
  mode,
  onModeChange,
  onSend,
  onQueue,
  onAbort
}: ComposerProps): ReactElement {
  const [value, setValue] = useState('')
  const [commandIndex, setCommandIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const historyIndexRef = useRef<number | null>(null)
  const historyDraftRef = useRef('')

  const resetHistoryNavigation = useCallback((): void => {
    historyIndexRef.current = null
    historyDraftRef.current = ''
  }, [])

  useEffect(() => {
    if (prefill) {
      resetHistoryNavigation()
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
    setValue('')
    resetHistoryNavigation()
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }, [resetHistoryNavigation])

  const slashMatch = value.match(/^\s*\/([^\s]*)$/)
  const slashQuery = slashMatch?.[1].toLocaleLowerCase() ?? null
  const commandOptions = slashQuery === null
    ? []
    : commands.filter((command) => command.name.toLocaleLowerCase().startsWith(slashQuery)).slice(0, 8)
  const showCommandMenu = !disabled && commandOptions.length > 0
  const activeCommandIndex = Math.min(commandIndex, Math.max(0, commandOptions.length - 1))

  useEffect(() => {
    setCommandIndex(0)
  }, [slashQuery])

  const submit = useCallback(() => {
    const text = value.trim()
    if (text === '' || disabled) return
    onSend(text)
    clearValue()
  }, [value, disabled, onSend, clearValue])

  const queue = useCallback(() => {
    const text = value.trim()
    if (text === '' || disabled) return
    onQueue(text)
    clearValue()
  }, [value, disabled, onQueue, clearValue])

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
      selectSlashCommand(activeCommandIndex)
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
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && value.trim() !== '') {
      event.preventDefault()
      queue()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  const autoSize = (element: HTMLTextAreaElement): void => {
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`
  }

  const selectSlashCommand = (index: number): void => {
    const command = commandOptions[index]
    if (!command) return
    resetHistoryNavigation()
    const nextValue = `/${command.name} `
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

  const sourceLabel = (source: SlashCommandInfo['source']): string => {
    if (source === 'skill') return '技能'
    if (source === 'prompt') return '提示词'
    return '扩展'
  }

  const queuedTotal = queued.steering + queued.followUp

  return (
    <footer className="composer">
      <div className={`composer-row composer-mode-${mode}`}>
        <div className="composer-input-main">
          {showCommandMenu && (
            <div id="slash-command-menu" className="slash-command-menu" role="listbox" aria-label="斜杠命令">
              <div className="slash-command-heading">斜杠命令</div>
              {commandOptions.map((command, index) => (
                <button
                  type="button"
                  key={`${command.source}:${command.name}`}
                  className={`slash-command-option${index === activeCommandIndex ? ' active' : ''}`}
                  role="option"
                  aria-selected={index === activeCommandIndex}
                  title={command.description || `执行 /${command.name}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectSlashCommand(index)}
                >
                  <span className="slash-command-name">/{command.name}</span>
                  <span className="slash-command-description">{command.description || '无描述'}</span>
                  <span className="slash-command-source">{sourceLabel(command.source)}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={value}
            placeholder={disabled
              ? 'agent 未运行…'
              : mode === 'plan'
                ? '计划模式：描述要探索和设计的目标… (↑↓ 编辑历史 / Tab 排队 / Enter 直接发送)'
                : '描述任务… (↑↓ 编辑历史 / Tab 排队 / Enter 直接发送)'}
            disabled={disabled}
            aria-autocomplete="list"
            aria-controls="slash-command-menu"
            rows={1}
            onChange={(event) => {
              resetHistoryNavigation()
              setValue(event.target.value)
              autoSize(event.target)
            }}
            onKeyDown={handleKeyDown}
            aria-keyshortcuts="ArrowUp ArrowDown"
          />
          <div className="composer-inline-controls">
            {projectSelector}
            <div className="composer-mode-picker" role="group" aria-label="工作模式">
              <button
                type="button"
                data-mode="build"
                className={`composer-mode-option${mode === 'build' ? ' active' : ''}`}
                aria-pressed={mode === 'build'}
                disabled={disabled || busy}
                title="构建模式：允许修改项目文件"
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
                disabled={disabled || busy}
                title="计划模式：只读探索并制定实现方案"
                onClick={() => onModeChange('plan')}
              >
                <ListTodo size={12} />
                <span>计划</span>
              </button>
            </div>
            {controls}
          </div>
        </div>
        <button
          className="send-button"
          onClick={submit}
          disabled={disabled || value.trim() === ''}
          title="Enter 直接发送"
        >
          <ArrowUp size={16} />
        </button>
      </div>
      {busy && (
        <div className="composer-status-row">
          <div className="composer-status-right">
            <span className="pulse status-run">● 运行中</span>
            {queuedTotal > 0 && (
              <span className="queued">排队 {queuedTotal} 条（转向注入）</span>
            )}
            <button className="ghost-button stop-button" onClick={onAbort}>
              <Square size={11} /> 停止
            </button>
          </div>
        </div>
      )}
    </footer>
  )
}
