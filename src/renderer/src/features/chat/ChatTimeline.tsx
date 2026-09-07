import { useLayoutEffect } from 'react'
import type { RefObject, ReactElement } from 'react'
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
  scrollRef: RefObject<HTMLDivElement | null>
  onScroll: () => void
  timeline: TimelineItem[]
  timelineLoading: boolean
  busy: boolean
  starting: boolean
  cwd?: string
  hasSessions: boolean
  canFork: boolean
  onFork: (entryId: string) => void
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
  scrollRef,
  onScroll,
  timeline,
  timelineLoading,
  busy,
  starting,
  cwd,
  hasSessions,
  canFork,
  onFork,
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
    if (!container) return
    const timer = window.setTimeout(() => assignPendingLineDelays(container), 120)
    return () => window.clearTimeout(timer)
  }, [timeline, scrollRef])

  return (
    <main className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
      {timeline.length === 0 && !busy ? (
        <EmptyState
          cwd={cwd}
          starting={starting}
          loadingHistory={timelineLoading}
          hasSessions={hasSessions}
        />
      ) : (
        <div className="timeline">
          {timeline.map((item) =>
            item.kind === 'tool' ? (
              <ToolCallItem key={item.id} tool={item.tool} historical={item.historical} noReveal={item.noReveal} />
            ) : item.kind === 'compaction' ? (
              <div key={item.id} className={`compaction-marker${item.historical ? ' history-reveal' : ''}`}>
                {item.historical ? <RevealText text={item.summary} mode="history" /> : item.summary}
              </div>
            ) : (
              <ChatMessage
                key={item.id}
                item={item}
                canFork={canFork}
                onFork={onFork}
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
          {!busy
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
    </main>
  )
}
