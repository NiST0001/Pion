import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FilePenLine,
  FilePlus2,
  FolderOpen,
  Loader2,
  TerminalSquare,
  Wrench,
  XCircle
} from 'lucide-react'
import type { ToolItem } from '../../agent/types'
import { diffStats } from '../../agent/timeline'
import { armHistoryRevealRow } from '../../utils/historyReveal'
import {
  appendedCharacterCount,
  assignLineRevealDelay,
  assignPendingLineDelays,
  characterCount,
  RevealText,
  SCREEN_TEXT_REVEAL_LINE_CLASS,
  SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS,
  SCREEN_TEXT_REVEAL_LINE_LIVE_CLASS
} from '../../utils/screenTextReveal'
import { DiffView } from '../review/DiffView'

const TOOL_LABELS: Record<string, string> = {
  read: '读取',
  write: '写入',
  edit: '编辑',
  bash: '终端',
  powershell: '终端',
  grep: '搜索内容',
  find: '查找文件',
  ls: '目录',
  pion_task: '任务'
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

export function ToolCallItem({ tool, historical, noReveal }: { tool: ToolItem; historical?: boolean; noReveal?: boolean }): ReactElement {
  const [open, setOpen] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const revealSuppressed = noReveal === true
  const previousOpenRef = useRef(false)
  const isEdit = tool.name === 'edit' && Boolean(tool.diff)
  const isWrite = tool.name === 'write'
  const isShell = tool.name === 'bash' || tool.name === 'powershell'
  const label = TOOL_LABELS[tool.name] ?? tool.name

  const stats = tool.diff ? diffStats(tool.diff) : null
  const liveOutput = tool.live === true && !historical
  const previousBodyTextRef = useRef('')
  const bodyText = truncate(tool.outputText ?? tool.writeContent ?? '', 4000)
  const bodyRevealCount = liveOutput
    ? open && !previousOpenRef.current
      ? characterCount(bodyText)
      : appendedCharacterCount(previousBodyTextRef.current, bodyText)
    : 0

  useLayoutEffect(() => {
    previousBodyTextRef.current = bodyText
    previousOpenRef.current = open
  }, [bodyText, open])

  useLayoutEffect(() => {
    if (!historical || !open) return
    const row = rowRef.current
    const container = row?.closest<HTMLElement>('.chat-scroll')
    if (!row || !container) return
    const frame = window.requestAnimationFrame(() => {
      assignPendingLineDelays(container)
      armHistoryRevealRow(row, container)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [historical, open])

  return (
    <div ref={rowRef} className={`tool-call tool-${tool.status}${historical ? ' history-reveal' : ''}`}>
      <button
        className={`tool-head${revealSuppressed ? '' : ` ${SCREEN_TEXT_REVEAL_LINE_CLASS} ${historical ? SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS : SCREEN_TEXT_REVEAL_LINE_LIVE_CLASS}`}`}
        data-live-output="tool-head"
        ref={revealSuppressed ? undefined : assignLineRevealDelay}
        onClick={() => setOpen((v) => !v)}
        type="button"
        aria-expanded={open}
        aria-label={`${open ? '收起' : '展开'}${label}工具详情`}
      >
        <span className="tool-chevron">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        <span className={`tool-icon ${tool.status === 'running' ? 'spin' : ''}`}>
          {tool.status === 'running' ? (
            <Loader2 size={14} />
          ) : tool.status === 'error' ? (
            <XCircle size={14} />
          ) : isEdit ? (
            <FilePenLine size={14} />
          ) : isWrite ? (
            <FilePlus2 size={14} />
          ) : isShell ? (
            <TerminalSquare size={14} />
          ) : (
            <Wrench size={14} />
          )}
        </span>
        <span className="tool-name">{label}</span>
        {tool.path && (
          <code className="tool-path" title={tool.path}>
            {tool.path}
          </code>
        )}
        {!tool.path && tool.command && (
          <code className="tool-path">{truncate(tool.command, 80)}</code>
        )}
        {stats && (
          <span className="tool-stats">
            <span className="stat-add">+{stats.additions}</span>
            <span className="stat-del">−{stats.deletions}</span>
          </span>
        )}
        {tool.status === 'running' && (
          <span className="tool-running-label">
            执行中…
          </span>
        )}
      </button>

      {open && (
        <div className="tool-body" data-live-output="tool-body">
          {tool.diff && <DiffView diff={tool.diff} dense reveal={Boolean(historical)} />}
          {isShell && tool.command && (
            <pre className="tool-command">{historical
              ? <RevealText text={`$ ${tool.command}`} mode="history" />
              : `$ ${tool.command}`}</pre>
          )}
          {tool.outputText && !tool.diff && (
            <pre className="tool-output">{historical
              ? <RevealText text={truncate(tool.outputText, 4000)} mode="history" />
              : liveOutput
                ? <RevealText text={truncate(tool.outputText, 4000)} mode="live" revealCount={bodyRevealCount} />
                : truncate(tool.outputText, 4000)}</pre>
          )}
          {isWrite && tool.writeContent && (
            <pre className="tool-output">{historical
              ? <RevealText text={truncate(tool.writeContent, 4000)} mode="history" />
              : liveOutput
                ? <RevealText text={truncate(tool.writeContent, 4000)} mode="live" revealCount={bodyRevealCount} />
                : truncate(tool.writeContent, 4000)}</pre>
          )}
          {!tool.diff && !tool.outputText && !tool.writeContent && (
            <div className="tool-empty">
              <FolderOpen size={13} />
              {historical ? <RevealText text="无输出" mode="history" /> : '无输出'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
