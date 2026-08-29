import { useMemo, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import { Clock3 } from 'lucide-react'
import type {
  HistoryLandmark,
  SessionHistoryIndex
} from '../../../shared/types'

const MAX_MARKERS = 180

function sampleLandmarks(
  landmarks: HistoryLandmark[],
  activeEntryId?: string
): HistoryLandmark[] {
  if (landmarks.length <= MAX_MARKERS) return landmarks
  const sampled = new Map<string, HistoryLandmark>()
  for (let index = 0; index < MAX_MARKERS; index++) {
    const sourceIndex = Math.round(index * (landmarks.length - 1) / (MAX_MARKERS - 1))
    const landmark = landmarks[sourceIndex]
    sampled.set(landmark.entryId, landmark)
  }
  const active = activeEntryId
    ? landmarks.find((landmark) => landmark.entryId === activeEntryId)
    : undefined
  if (active) sampled.set(active.entryId, active)
  return [...sampled.values()].sort((a, b) => a.entryIndex - b.entryIndex)
}

function markerPosition(landmark: HistoryLandmark, totalEntries: number): number {
  return totalEntries <= 1 ? 0 : landmark.entryIndex / (totalEntries - 1)
}

function formatLandmarkTime(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

interface HistoryNavigatorProps {
  index: SessionHistoryIndex | null
  activeEntryId?: string
  busy: boolean
  onJump: (landmark: HistoryLandmark) => void
}

export function HistoryNavigator({
  index,
  activeEntryId,
  busy,
  onJump
}: HistoryNavigatorProps): ReactElement | null {
  const [preview, setPreview] = useState<HistoryLandmark | null>(null)
  const markers = useMemo(
    () => sampleLandmarks(index?.landmarks ?? [], activeEntryId),
    [activeEntryId, index?.landmarks]
  )

  if (!index || index.landmarks.length < 2) return null

  const jumpNearest = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (busy || event.target !== event.currentTarget) return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1)
    const targetIndex = ratio * Math.max(index.totalEntries - 1, 0)
    const nearest = index.landmarks.reduce((best, landmark) => (
      Math.abs(landmark.entryIndex - targetIndex) < Math.abs(best.entryIndex - targetIndex)
        ? landmark
        : best
    ))
    onJump(nearest)
  }

  return (
    <aside
      className={`history-navigator${busy ? ' busy' : ''}`}
      aria-label="会话历史快速导航"
    >
      <div
        className="history-navigator-track"
        role="presentation"
        onClick={jumpNearest}
      >
        {markers.map((landmark) => {
          const position = markerPosition(landmark, index.totalEntries)
          const active = landmark.entryId === activeEntryId
          return (
            <button
              type="button"
              key={landmark.entryId}
              className={`history-navigator-marker${active ? ' active' : ''}`}
              data-entry-id={landmark.entryId}
              data-entry-index={landmark.entryIndex}
              style={{ top: `${position * 100}%` }}
              aria-label={`跳到第 ${landmark.ordinal} 条历史消息：${landmark.snippet}`}
              disabled={busy}
              onMouseEnter={() => setPreview(landmark)}
              onMouseLeave={() => setPreview((current) => current?.entryId === landmark.entryId ? null : current)}
              onFocus={() => setPreview(landmark)}
              onBlur={() => setPreview(null)}
              onClick={(event) => {
                event.stopPropagation()
                onJump(landmark)
              }}
            />
          )
        })}
      </div>

      {preview && (
        <div
          className="history-navigator-preview"
          style={{
            top: `${Math.min(
              Math.max(markerPosition(preview, index.totalEntries), 0.08),
              0.92
            ) * 100}%`
          } as CSSProperties}
          role="tooltip"
        >
          <strong>{preview.snippet}</strong>
          {preview.responseSnippet && <p>{preview.responseSnippet}</p>}
          <small>
            <span>第 {preview.ordinal} / {index.landmarks.length} 条</span>
            {formatLandmarkTime(preview.timestamp) && (
              <span><Clock3 size={10} /> {formatLandmarkTime(preview.timestamp)}</span>
            )}
          </small>
        </div>
      )}
    </aside>
  )
}
