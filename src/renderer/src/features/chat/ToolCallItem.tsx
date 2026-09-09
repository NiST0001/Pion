import { memo, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import {
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
import {
  assignLineRevealDelay,
  type TextRevealMode,
  SCREEN_TEXT_REVEAL_LINE_CLASS,
  SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS,
  SCREEN_TEXT_REVEAL_LINE_LIVE_CLASS
} from '../../utils/screenTextReveal'
import { DiffView } from '../review/DiffView'
import { ReviewRevealText } from '../review/ReviewRevealText'
import { AnimatedDisclosure } from '../common/AnimatedDisclosure'

const TOOL_LABELS: Record<string, string> = {
  read: '读取',
  write: '写入',
  edit: '编辑',
  bash: '终端',
  powershell: '终端',
  grep: '搜索内容',
  find: '查找文件',
  ls: '目录',
  pion_task: '任务',
  pion_ask_user: '提问',
  pion_subagents: '子 Agent'
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

// Mount only inside the disclosure and memoize actual body inputs separately
// from header/status updates. Closed details do no body segmentation or
// diff-row parsing; the header's full-diff counts are cached separately.
const ToolDetails = memo(function ToolDetails({ name, diff, command, outputText, writeContent, mode }: {
  name: string; diff?: string; command?: string; outputText?: string; writeContent?: string; mode?: TextRevealMode
}) {
  const text = (value: string) => mode ? <ReviewRevealText text={value} mode={mode} /> : value
  return <div className="tool-body" data-live-output="tool-body">
    {diff && <DiffView diff={diff} dense reveal={mode === 'history'} />}
    {(name === 'bash' || name === 'powershell') && command && (
      <pre className="tool-command">{mode === 'history' ? text(`$ ${command}`) : `$ ${command}`}</pre>
    )}
    {outputText && !diff && <pre className="tool-output">{text(truncate(outputText, 4000))}</pre>}
    {name === 'write' && writeContent && <pre className="tool-output">{text(truncate(writeContent, 4000))}</pre>}
    {!diff && !outputText && !writeContent && <div className="tool-empty"><FolderOpen size={13} />{text('无输出')}</div>}
  </div>
})

export const ToolCallItem = memo(function ToolCallItem({ tool, historical, noReveal }: { tool: ToolItem; historical?: boolean; noReveal?: boolean }): ReactElement {
  const [open, setOpen] = useState(false)
  const revealSuppressed = noReveal === true
  const isEdit = tool.name === 'edit' && Boolean(tool.diff)
  const isWrite = tool.name === 'write'
  const isShell = tool.name === 'bash' || tool.name === 'powershell'
  const label = TOOL_LABELS[tool.name] ?? tool.name

  const stats = useMemo(() => tool.diff ? diffStats(tool.diff) : null, [tool.diff])
  const liveOutput = tool.live === true && !historical

  return (
    <div className={`tool-call tool-${tool.status}${historical ? ' history-reveal' : ''}`}>
      <button
        className={`tool-head${revealSuppressed ? '' : ` ${SCREEN_TEXT_REVEAL_LINE_CLASS} ${historical ? SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS : SCREEN_TEXT_REVEAL_LINE_LIVE_CLASS}`}`}
        data-live-output="tool-head"
        ref={revealSuppressed ? undefined : assignLineRevealDelay}
        onClick={() => setOpen((v) => !v)}
        type="button"
        aria-expanded={open}
        aria-label={`${open ? '收起' : '展开'}${label}工具详情`}
      >
        <span className="tool-chevron"><ChevronRight size={14} /></span>
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

      <AnimatedDisclosure open={open}>
        <ToolDetails name={tool.name} diff={tool.diff} command={tool.command}
          outputText={tool.outputText} writeContent={tool.writeContent}
          mode={revealSuppressed ? undefined : historical ? 'history' : liveOutput ? 'live' : undefined} />
      </AnimatedDisclosure>
    </div>
  )
})
