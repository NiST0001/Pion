import { useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { Clock3 } from 'lucide-react'
import type {
  HistoryLandmark,
  SessionHistoryIndex
} from '../../../shared/types'

const MAX_MARKERS = 180
/** Radius (in bars) the hover wave reaches; beyond it bars keep their base width. */
const WAVE_RADIUS = 5
/** Peak extra width applied to the bar under the cursor. */
const WAVE_BOOST = 2.6

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

/** Concave spike: the hovered bar stands far above its neighbours,
    and the falloff accelerates away from the peak. */
function waveScale(markerIndex: number, hoverIndex: number | null): number {
  if (hoverIndex === null) return 1
  const distance = Math.abs(markerIndex - hoverIndex)
  if (distance >= WAVE_RADIUS) return 1
  const falloff = Math.pow(1 - distance / WAVE_RADIUS, 2.2)
  return 1 + WAVE_BOOST * falloff
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
  /** Vertical gap between bars, px (user-adjustable in settings). */
  gap?: number
  onJump: (landmark: HistoryLandmark) => void
}

export function HistoryNavigator({
  index,
  activeEntryId,
  busy,
  gap = 10,
  onJump
}: HistoryNavigatorProps): ReactElement | null {
  const [preview, setPreview] = useState<HistoryLandmark | null>(null)
  const [previewTop, setPreviewTop] = useState(50)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const scrubbingRef = useRef(false)
  const lastScrubJumpRef = useRef(0)
  const markers = useMemo(
    () => sampleLandmarks(index?.landmarks ?? [], activeEntryId),
    [activeEntryId, index?.landmarks]
  )

  if (!index || index.landmarks.length < 2) return null

  const nearestIndexAt = (clientY: number): number => {
    const track = trackRef.current
    if (!track) return 0
    const rect = track.getBoundingClientRect()
    const ratio = Math.min(Math.max((clientY - rect.top) / Math.max(rect.height, 1), 0), 1)
    return Math.round(ratio * (markers.length - 1))
  }

  /** Hover follows the cursor anywhere on the rail — gaps between bars count too. */
  const hoverAt = (clientY: number): void => {
    const markerIndex = nearestIndexAt(clientY)
    const landmark = markers[markerIndex]
    if (!landmark) return
    setHoverIndex(markerIndex)
    setPreview(landmark)
    const track = trackRef.current
    const bar = track?.querySelectorAll('.history-navigator-marker')[markerIndex]
    if (track && bar) {
      const trackRect = track.getBoundingClientRect()
      const barRect = bar.getBoundingClientRect()
      const center = barRect.top + barRect.height / 2 - trackRect.top
      setPreviewTop(Math.min(Math.max(center / Math.max(trackRect.height, 1), 0.08), 0.92))
    }
  }

  const handleTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (busy || event.target !== event.currentTarget) return
    scrubbingRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    hoverAt(event.clientY)
  }

  const handleTrackPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    hoverAt(event.clientY)
    if (!scrubbingRef.current || busy) return
    const now = Date.now()
    if (now - lastScrubJumpRef.current < 200) return
    lastScrubJumpRef.current = now
    const landmark = markers[nearestIndexAt(event.clientY)]
    if (landmark) onJump(landmark)
  }

  const handleTrackPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (scrubbingRef.current && !busy) {
      const landmark = markers[nearestIndexAt(event.clientY)]
      if (landmark) onJump(landmark)
    }
    scrubbingRef.current = false
  }

  return (
    <aside
      className={`history-navigator${busy ? ' busy' : ''}`}
      aria-label="会话历史快速导航"
    >
      <div
        ref={trackRef}
        className="history-navigator-track"
        role="presentation"
        style={{ gap: `${gap}px` }}
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handleTrackPointerMove}
        onPointerUp={handleTrackPointerUp}
        onPointerCancel={() => { scrubbingRef.current = false }}
        onMouseLeave={() => {
          if (scrubbingRef.current) return
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
              onMouseEnter={(event) => {
                setHoverIndex(markerIndex)
                setPreview(landmark)
                const track = event.currentTarget.parentElement
                if (track) {
                  const trackRect = track.getBoundingClientRect()
                  const barRect = event.currentTarget.getBoundingClientRect()
                  const center = barRect.top + barRect.height / 2 - trackRect.top
                  setPreviewTop(Math.min(Math.max(center / Math.max(trackRect.height, 1), 0.08), 0.92))
                }
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
          style={{ top: `${previewTop * 100}%` } as CSSProperties}
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
