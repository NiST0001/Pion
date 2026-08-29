import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, KeyboardEvent, ReactElement, ReactNode } from 'react'
import { ArrowUp, Hammer, ImagePlus, ListTodo, Square, X } from 'lucide-react'
import type { AgentMode, ImageContent, SlashCommandInfo } from '../../../shared/types'

function fileToImageContent(file: File): Promise<ImageContent> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('无法读取剪贴板图像'))
        return
      }
      const separator = result.indexOf(',')
      if (separator < 0) {
        reject(new Error('剪贴板图像格式无效'))
        return
      }
      resolve({
        type: 'image',
        data: result.slice(separator + 1),
        mimeType: file.type || 'image/png'
      })
    }
    reader.onerror = () => reject(new Error('无法读取剪贴板图像'))
    reader.readAsDataURL(file)
  })
}

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
  onSend: (text: string, images: ImageContent[]) => void
  onQueue: (text: string, images: ImageContent[]) => void
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
  const [pendingImages, setPendingImages] = useState<ImageContent[]>([])
  const [imageError, setImageError] = useState('')
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

  const appendImage = useCallback((image: ImageContent): void => {
    if (!image.data || !image.mimeType.startsWith('image/')) {
      setImageError('剪贴板中没有可用的图像')
      return
    }
    setPendingImages((current) => [...current, image])
    setImageError('')
  }, [])

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const imageItem = Array.from(event.clipboardData.items)
      .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
    const file = imageItem?.getAsFile()
    if (file) {
      event.preventDefault()
      setImageError('')
      void fileToImageContent(file)
        .then(appendImage)
        .catch((error: unknown) => {
          setImageError(error instanceof Error ? error.message : '无法读取剪贴板图像')
        })
      return
    }

    // Electron/Linux may expose an image through the native clipboard without
    // adding an image item to ClipboardEvent. Keep normal text paste intact and
    // use the main-process fallback in parallel.
    const hasText = event.clipboardData.getData('text/plain').length > 0
    void window.pion.readClipboardImage()
      .then((image) => {
        if (image) appendImage(image)
      })
      .catch((error: unknown) => {
        if (!hasText) setImageError(error instanceof Error ? error.message : '无法读取剪贴板图像')
      })
  }, [appendImage])

  const removeImage = useCallback((index: number): void => {
    setPendingImages((current) => current.filter((_, imageIndex) => imageIndex !== index))
  }, [])

  const clearImages = useCallback((): void => {
    setPendingImages([])
    setImageError('')
  }, [])

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
    if ((text === '' && pendingImages.length === 0) || disabled) return
    onSend(text, pendingImages)
    clearValue()
    clearImages()
  }, [value, pendingImages, disabled, onSend, clearValue, clearImages])

  const queue = useCallback(() => {
    const text = value.trim()
    if ((text === '' && pendingImages.length === 0) || disabled) return
    onQueue(text, pendingImages)
    clearValue()
    clearImages()
  }, [value, pendingImages, disabled, onQueue, clearValue, clearImages])

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

    if (
      event.key === 'Tab' &&
      event.ctrlKey &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault()
      if (!disabled && !busy) onModeChange(mode === 'build' ? 'plan' : 'build')
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
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && (value.trim() !== '' || pendingImages.length > 0)) {
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
                ? '计划模式：描述要探索和设计的目标… (↑↓ 编辑历史 / Tab 排队 / Ctrl+Tab 切换模式 / Enter 直接发送)'
                : '描述任务… (↑↓ 编辑历史 / Tab 排队 / Ctrl+Tab 切换模式 / Enter 直接发送)'}
            disabled={disabled}
            aria-autocomplete="list"
            aria-controls="slash-command-menu"
            rows={1}
            onChange={(event) => {
              resetHistoryNavigation()
              setValue(event.target.value)
              autoSize(event.target)
            }}
            onPaste={handlePaste}
            onKeyDown={handleKeyDown}
            aria-keyshortcuts="ArrowUp ArrowDown Control+Tab"
          />
          {(pendingImages.length > 0 || imageError) && (
            <div className="composer-attachments" aria-label="待发送图像">
              <div className="composer-attachment-list">
                {pendingImages.map((image, index) => (
                  <div className="composer-attachment" key={`${image.mimeType}:${index}`}>
                    <img
                      src={`data:${image.mimeType};base64,${image.data}`}
                      alt={`待发送图像 ${index + 1}`}
                    />
                    <button
                      type="button"
                      className="composer-attachment-remove"
                      title="移除图像"
                      aria-label={`移除第 ${index + 1} 张图像`}
                      onClick={() => removeImage(index)}
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
                <span className="composer-attachment-label">
                  <ImagePlus size={13} />
                  {pendingImages.length} 张图像待发送
                </span>
              </div>
              {imageError && <span className="composer-attachment-error">{imageError}</span>}
            </div>
          )}
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
          disabled={disabled || (value.trim() === '' && pendingImages.length === 0)}
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
