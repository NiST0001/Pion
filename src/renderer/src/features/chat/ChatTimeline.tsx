import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, RefObject, ReactElement } from 'react'
import type { RunCheckpointStatus } from '../../../../shared/types'
import type { FileChange, TimelineItem } from '../../agent/types'
import type { WorkingStatus } from '../../agent/workingStatus'
import { EmptyState } from '../common/EmptyState'
import { ModifiedFilesCard } from '../review/ModifiedFilesCard'
import { ReviewRevealText } from '../review/ReviewRevealText'
import { ChatMessage } from './ChatMessage'
import { ToolCallItem } from './ToolCallItem'
import { ToolActivityHeader } from './ToolActivityHeader'
import { DisclosureRevealGate } from '../common/DisclosureRevealGate'
import { groupToolActivity, summarizeToolActivity, type ToolTimelineItem } from '../../agent/toolActivityGroups'
import { assignLineRevealDelay, SCREEN_TEXT_REVEAL_LINE_CLASS, SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS } from '../../utils/screenTextReveal'
import { watchLineReveals } from '../../utils/lineReveal'

export interface ChatTimelineProps {
  /** Real selected transcript identity; not a backend-readiness or content revision. */
  scopeKey?: string
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

// Keep already opened tool cards mounted when the outer group collapses.
// Flat sibling keys prevent prepend/merged groups from reparenting their DOM.
function ToolActivityItem({ item, visible, readOnly }: { item: ToolTimelineItem; visible: boolean; readOnly: boolean }) {
  const mounted = useRef(false)
  // Only a wrapper first seen closed participates in the user's first reveal.
  // Passive history additions to an already open group are already reading,
  // not a new expansion; don't start a new cascade above its displayed tail.
  const initiallyCollapsed = useRef(!visible).current
  const [present, setPresent] = useState(visible)
  useLayoutEffect(() => {
    if (visible) { mounted.current = true; setPresent(true); return }
    if (!present) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setPresent(false)
      return
    }
    // Keep the closing layout until grid/margins finish (180ms). Cleanup on
    // reopen/unmount prevents a previous close from hiding the new disclosure.
    const timer = window.setTimeout(() => setPresent(false), 200)
    return () => window.clearTimeout(timer)
  }, [visible, present])
  return <div className="tool-activity-item" data-open={visible}
    hidden={!visible && !present} inert={!visible} aria-hidden={!visible || undefined}>
    <div className="tool-activity-inner">
      <DisclosureRevealGate open={visible}>
        {(visible || mounted.current) && <ToolCallItem tool={item.tool} historical={item.historical} noReveal={item.noReveal}
          initialHeaderReveal={initiallyCollapsed ? 'history' : item.historical ? 'static' : undefined} readOnly={readOnly} />}
      </DisclosureRevealGate>
    </div>
  </div>
}

export function ChatTimeline({
  scopeKey,
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
  const scope = scopeKey ?? cwd ?? ''
  const previousGroups = useRef<{ scope: string; groups: { key: string; ids: Set<string> }[] }>({ scope, groups: [] })
  const [expandedGroups, setExpandedGroups] = useState<{ scope: string; keys: Set<string> }>({ scope, keys: new Set() })
  const groups = useMemo(() => {
    const previous = previousGroups.current.scope === scope ? previousGroups.current.groups : []
    const used = new Set<string>()
    return groupToolActivity(timeline).map(group => {
      const ids = new Set(group.items.map(item => item.tool.id))
      const retained = previous.find(old => !used.has(old.key) && [...old.ids].some(id => ids.has(id)))
      const key = retained?.key ?? `group:${scope}:${group.items[0].tool.id}:${group.items[0].id}`
      used.add(key)
      return { ...group, key, ids }
    })
  }, [timeline, scope])
  useLayoutEffect(() => { previousGroups.current = { scope, groups } }, [groups, scope])
  useEffect(() => {
    // Open-state storage is limited to the current mounted window, not history.
    const visible = new Set(groups.map(group => group.key))
    setExpandedGroups(previous => {
      const keys = previous.scope === scope ? new Set([...previous.keys].filter(key => visible.has(key))) : new Set<string>()
      return previous.scope === scope && keys.size === previous.keys.size ? previous : { scope, keys }
    })
  }, [groups, scope])
  const groupsByStart = new Map(groups.map(group => [group.firstIndex, group]))
  const groupByIndex = new Map<number, typeof groups[number]>()
  for (const group of groups) for (let index = group.firstIndex; index <= group.lastIndex; index++) groupByIndex.set(index, group)
  const toggleGroup = (key: string) => setExpandedGroups(previous => {
    const keys = previous.scope === scope ? new Set(previous.keys) : new Set<string>()
    if (keys.has(key)) keys.delete(key)
    else keys.add(key)
    return { scope, keys }
  })

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container || hidden) return
    // Initial admission waits for RAF, after parent navigation/layout effects.
    // Mutations merge history and live rows on this viewport's own clock.
    return watchLineReveals(container)
  }, [scope, scrollRef, hidden])

  return (
    <main className={`chat-scroll${className ? ` ${className}` : ''}`} ref={scrollRef} onScroll={onScroll}
      data-line-reveal-owner="true" data-line-reveal-scope={scope} aria-hidden={hidden || undefined} inert={hidden}
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
          {timeline.flatMap((item, index) => {
            if (item.kind === 'tool') {
              const group = groupByIndex.get(index)!
              const open = expandedGroups.scope === scope && expandedGroups.keys.has(group.key)
              const nodes = [<ToolActivityItem key={`tool:${scope}:${item.id}`} item={item} visible={open} readOnly={readOnly} />]
              if (groupsByStart.has(index)) nodes.unshift(<ToolActivityHeader key={group.key}
                summary={summarizeToolActivity(group.items)} open={open} onToggle={() => toggleGroup(group.key)}
                historical={group.items[0].historical} noReveal={group.items[0].noReveal} />)
              return nodes
            }
            return item.kind === 'compaction' ? (
              <div key={item.id}
                ref={item.historical && !item.noReveal ? assignLineRevealDelay : undefined}
                className={`compaction-marker${item.historical && !item.noReveal ? ` history-reveal ${SCREEN_TEXT_REVEAL_LINE_CLASS} ${SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS}` : ''}`}>
                {item.historical && !item.noReveal ? <ReviewRevealText text={item.summary} mode="history" /> : item.summary}
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
          })}
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
