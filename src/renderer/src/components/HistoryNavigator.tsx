import { useMemo, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import { Clock3 } from 'lucide-react'
import type {
  HistoryLandmark,
  SessionHistoryIndex
} from '../../../shared/types'

const MAX_MARKERS = 180
/** Gaussian falloff: how many neighbours the hover wave reaches. */
const WAVE_SIGMA = 2.4
/** Peak extra width applied to the bar under the cursor. */
const WAVE_BOOST = 1.25

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

/** Dock-magnification style falloff: closest bar grows most, distant bars stay put. */
function waveScale(markerIndex: number, hoverIndex: number | null): number {
  if (hoverIndex === null) return 1
  const distance = Math.abs(markerIndex - hoverIndex)
  return 1 + WAVE_BOOST * Math.exp(-(distance * distance) / (2 * WAVE_SIGMA * WAVE_SIGMA))
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
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const markers = useMemo(
    () => sampleLandmarks(index?.landmarks ?? [], activeEntryId),
    [activeEntryId, index?.landmarks]
  )

  if (!index || index.landmarks.length < 2) return null

  const previewIndex = preview ? markers.findIndex((m) => m.entryId === preview.entryId) : -1
  const previewFraction = previewIndex < 0 || markers.length <= 1
    ? 0
    : previewIndex / (markers.length - 1)

  const jumpNearest = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (busy || event.target !== event.currentTarget) return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1)
    const target = markers[Math.round(ratio * (markers.length - 1))]
    if (target) onJump(target)
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
        onMouseLeave={() => {
          setHoverIndex(null)
          setPreview(null)
        }}
      >
        {markers.map((landmark, markerIndex) => {
          const active = landmark.entryId === activeEntryId
          const scale = waveScale(markerIndex, hoverIndex)
          return (
            <button
              type="button"
              key={landmark.entryId}
              className={`history-navigator-marker${active ? ' active' : ''}`}
              data-entry-id={landmark.entryId}
              data-entry-index={landmark.entryIndex}
              style={{ transform: `scaleX(${scale.toFixed(3)})` }}
              aria-label={`跳到第 ${landmark.ordinal} 条历史消息：${landmark.snippet}`}
              disabled={busy}
              onMouseEnter={() => {
                setHoverIndex(markerIndex)
                setPreview(landmark)
              }}
              onFocus={() => {
                setHoverIndex(markerIndex)
                setPreview(landmark)
              }}
              onBlur={() => {
                setHoverIndex(null)
                setPreview(null)
              }}
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
            top: `${Math.min(Math.max(previewFraction, 0.08), 0.92) * 100}%`
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
