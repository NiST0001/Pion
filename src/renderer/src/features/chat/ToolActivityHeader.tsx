import { memo, useRef, type ReactElement } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  assignLineRevealDelay,
  SCREEN_TEXT_REVEAL_LINE_CLASS,
  SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS,
  SCREEN_TEXT_REVEAL_LINE_LIVE_CLASS
} from '../../utils/screenTextReveal'

export interface ToolActivityHeaderProps {
  summary: { label: string; total: number; running: number; errors: number }
  open: boolean
  onToggle: () => void
  historical?: boolean
  noReveal?: boolean
}

export const ToolActivityHeader = memo(function ToolActivityHeader({
  summary, open, onToggle, historical, noReveal
}: ToolActivityHeaderProps): ReactElement {
  // Freeze the original reveal mode: older prepend/history backfill must not
  // restart a mounted live row, and an initially static row never gains motion.
  const initialMode = useRef(noReveal ? undefined : historical ? 'history' : 'live').current
  const mode = noReveal ? undefined : initialMode
  // The complete row joins the shared waterfall once; count updates keep DOM.
  return <button
    type="button"
    className={`tool-activity-header${mode ? ` ${SCREEN_TEXT_REVEAL_LINE_CLASS} ${mode === 'history' ? SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS : SCREEN_TEXT_REVEAL_LINE_LIVE_CLASS}` : ''}`}
    ref={mode ? assignLineRevealDelay : undefined}
    aria-expanded={open}
    aria-label={`${open ? '收起' : '展开'}工具调用（${summary.total}次）`}
    title={`${summary.label}；当前连续工具调用记录，文件按原始路径去重，含尝试/失败，不是Git净变动或文件修改成功保证`}
    onClick={onToggle}
  >
    <ChevronRight className="tool-activity-chevron" size={14} aria-hidden="true" />
    <span className="tool-activity-caption">{summary.label}</span>
    {summary.running > 0 && <span className="tool-activity-running">执行中</span>}
    {summary.errors > 0 && <span className="tool-activity-errors">{summary.errors}项失败</span>}
  </button>
})
