import { useLayoutEffect } from 'react'
import type { CSSProperties, RefObject, ReactElement } from 'react'
import type { RunCheckpointStatus } from '../../../../shared/types'
import type { FileChange, TimelineItem } from '../../agent/types'
import type { WorkingStatus } from '../../agent/workingStatus'
import { EmptyState } from '../common/EmptyState'
import { ModifiedFilesCard } from '../review/ModifiedFilesCard'
import { ChatMessage } from './ChatMessage'
import { ToolCallItem } from './ToolCallItem'
import {
  assignPendingLineDelays,
  resetLineRevealClock,
  RevealText
} from '../../utils/screenTextReveal'

export interface ChatTimelineProps {
  /** Display-only transcripts retain the normal chat UI without mutation or media. */
  readOnly?: boolean
  /** Keep the scroll surface mounted and measurable while another transcript is shown. */
  hidden?: boolean
  className?: string
  style?: CSSProperties
  scrollRef: RefObject<HTMLDivElement | null>
  scrollSurfaceRef?: RefObject<HTMLDivElement | null>
  onScroll: () => void
  timeline: TimelineItem[]
  timelineLoading: boolean
  /** Undefined retains compatibility with callers that do not track history acceptance. */
  timelineReady?: boolean
  historySelected?: boolean
  timelineError?: string
  /** Bounded display information, not an invented SDK message/history item. */
  notice?: string
  onReloadHistory?: () => void
  busy: boolean
  starting: boolean
  cwd?: string
  hasSessions: boolean
  canFork: boolean
  onFork: (entryId: string) => void
  canRevert?: boolean
  onRevert?: (entryId: string) => void
  revertDisabledReason?: string
  agentActivity: boolean
  workingStatus: WorkingStatus
  latestRunChanges: FileChange[]
  workspaceChanges?: boolean
  runCheckpoint: RunCheckpointStatus | null
  rollbackBusy: boolean
  rollbackError: string
  onUndo: () => void
  onReview: () => void
  onSelectChange: (change: FileChange) => void
}

export function ChatTimeline({
  readOnly = false,
  hidden = false,
  className,
  style,
  scrollRef,
  scrollSurfaceRef,
  onScroll,
  timeline,
  timelineLoading,
  timelineReady,
  historySelected = false,
  timelineError,
  notice,
  onReloadHistory,
  busy,
  starting,
  cwd,
  hasSessions,
  canFork,
  onFork,
  canRevert,
  onRevert,
  revertDisabledReason,
  agentActivity,
  workingStatus,
  latestRunChanges,
  workspaceChanges,
  runCheckpoint,
  rollbackBusy,
  rollbackError,
  onUndo,
  onReview,
  onSelectChange
}: ChatTimelineProps): ReactElement {
  // A cleared timeline means a session switch; start a fresh waterfall clock.
  useLayoutEffect(() => {
    if (timeline.length === 0) resetLineRevealClock()
  }, [timeline.length])

  // History lines defer their delay to this settle scan: once paging batches
  // quiet down, everything pending is assigned in DOM order as one cascade.
  // Live lines assign themselves at attach and are never pending here.
  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container || hidden) return
    const timer = window.setTimeout(() => assignPendingLineDelays(container), 120)
    return () => window.clearTimeout(timer)
  }, [timeline, scrollRef, hidden])

  return (
    <main className={`chat-scroll${className ? ` ${className}` : ''}`} ref={scrollRef} onScroll={onScroll}
      aria-hidden={hidden || undefined} inert={hidden}
      style={hidden ? { ...style, visibility: 'hidden', pointerEvents: 'none' } : style}>
      <div className="chat-scroll-surface" ref={scrollSurfaceRef}>
      {notice && <div className="compaction-marker" role="note">{notice}</div>}
      {timeline.length === 0 && !busy ? (
        <EmptyState
          cwd={cwd}
          starting={starting}
          loadingHistory={timelineLoading}
          historyError={timelineError}
          historyUnloaded={historySelected && timelineReady === false}
          onReloadHistory={readOnly ? undefined : onReloadHistory}
          hasSessions={hasSessions}
        />
      ) : (
        <div className="timeline">
          {timeline.map((item) =>
            item.kind === 'tool' ? (
              <ToolCallItem key={item.id} tool={item.tool} historical={item.historical} noReveal={item.noReveal} readOnly={readOnly} />
            ) : item.kind === 'compaction' ? (
              <div key={item.id} className={`compaction-marker${item.historical ? ' history-reveal' : ''}`}>
                {item.historical ? <RevealText text={item.summary} mode="history" /> : item.summary}
              </div>
            ) : (
              <ChatMessage
                key={item.id}
                item={item}
                readOnly={readOnly}
                canFork={canFork}
                onFork={onFork}
                canRevert={canRevert}
                onRevert={onRevert}
                revertDisabledReason={revertDisabledReason}
              />
            )
          )}
          {agentActivity && (
            <div className="row row-agent-working">
              <span className="agent-working-text" role="status" aria-live="polite" aria-atomic="true">
                <span>{workingStatus.label}</span>
                {workingStatus.face && <span className="agent-working-face" aria-hidden="true">{workingStatus.face}</span>}
              </span>
            </div>
          )}
          {!readOnly && !busy
            && (workspaceChanges || runCheckpoint?.state !== 'rolled-back')
            && latestRunChanges.length > 0
            && (
              <ModifiedFilesCard
                changes={latestRunChanges}
                workspace={workspaceChanges}
                cwd={cwd}
                canUndo={Boolean(
                  runCheckpoint?.state === 'ready'
                  && runCheckpoint.hasChanges
                )}
                undoBusy={rollbackBusy}
                error={rollbackError}
                onUndo={onUndo}
                onReview={onReview}
                onSelect={onSelectChange}
              />
            )}
        </div>
      )}
      </div>
    </main>
  )
}
