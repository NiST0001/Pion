import { useEffect, useRef, useState } from 'react'
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  WheelEvent as ReactWheelEvent
} from 'react'
import { Clock3 } from 'lucide-react'
import type {
  HistoryLandmark,
  SessionHistoryIndex
} from '../../../../shared/types'

const EMPTY_LANDMARKS: HistoryLandmark[] = []
const MARKER_HEIGHT = 3
const TRACK_VERTICAL_PADDING = 12
/** Radius (in bars) the hover curve reaches; beyond it bars keep their base width. */
const WAVE_RADIUS = 5
/** Peak extra width applied to the bar under the cursor. */
const WAVE_BOOST = 3.2

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

/** Match the reference curve: a sharp peak, then a fast smooth decay. */
function waveScale(markerIndex: number, hoverIndex: number | null): number {
  if (hoverIndex === null) return 1
  const distance = Math.abs(markerIndex - hoverIndex)
  if (distance >= WAVE_RADIUS) return 1
  const edgeTaper = Math.sqrt(1 - distance / WAVE_RADIUS)
  const falloff = Math.exp(-0.78 * distance) * edgeTaper
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
  /** Maximum number of history bars mounted in the visible wheel-scroll window. */
  maxVisible?: number
  onJump: (landmark: HistoryLandmark) => void
}

export function HistoryNavigator({
  index,
  activeEntryId,
  busy,
  gap = 10,
  maxVisible = 40,
  onJump
}: HistoryNavigatorProps): ReactElement | null {
  const landmarks = index?.landmarks ?? EMPTY_LANDMARKS
  const configuredLimit = clamp(Math.round(maxVisible), 2, 120)
  const [preview, setPreview] = useState<HistoryLandmark | null>(null)
  const [previewTop, setPreviewTop] = useState(50)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [availableHeight, setAvailableHeight] = useState(0)
  const [windowStart, setWindowStart] = useState(() => Math.max(0, landmarks.length - configuredLimit))
  const [wheelMotion, setWheelMotion] = useState<{
    nonce: number
    offset: number
  } | null>(null)
  const navigatorRef = useRef<HTMLElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const previousSessionPathRef = useRef<string | undefined>(undefined)
  const previousLandmarkCountRef = useRef(landmarks.length)
  const windowStartRef = useRef(windowStart)
  const wheelSequenceRef = useRef(0)
  const scrubbingRef = useRef(false)
  const lastScrubJumpRef = useRef(0)
  const lastScrubEntryRef = useRef<string | null>(null)

  useEffect(() => {
    const navigator = navigatorRef.current
    if (!navigator) return
    const updateHeight = (): void => setAvailableHeight(navigator.clientHeight)
    updateHeight()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateHeight)
      return () => window.removeEventListener('resize', updateHeight)
    }
    const observer = new ResizeObserver(updateHeight)
    observer.observe(navigator)
    return () => observer.disconnect()
  }, [index?.sessionPath, landmarks.length >= 2])

  const fittedLimit = availableHeight > 0
    ? Math.max(2, Math.floor((availableHeight - TRACK_VERTICAL_PADDING + gap) / (MARKER_HEIGHT + gap)))
    : configuredLimit
  const visibleLimit = Math.min(configuredLimit, fittedLimit)
  const maximumWindowStart = Math.max(0, landmarks.length - visibleLimit)

  useEffect(() => {
    const sessionPath = index?.sessionPath
    const sessionChanged = previousSessionPathRef.current !== sessionPath
    const previousCount = previousLandmarkCountRef.current
    const activeIndex = activeEntryId
      ? landmarks.findIndex((landmark) => landmark.entryId === activeEntryId)
      : -1

    // Programmatic positioning should not replay a wheel-only scroll transition.
    setWheelMotion(null)
    setWindowStart((current) => {
      const clampedCurrent = clamp(current, 0, maximumWindowStart)
      let next = clampedCurrent
      if (sessionChanged) {
        next = activeIndex >= 0
          ? clamp(activeIndex - Math.floor(visibleLimit / 2), 0, maximumWindowStart)
          : maximumWindowStart
      } else if (
        activeIndex >= 0
        && (activeIndex < clampedCurrent || activeIndex >= clampedCurrent + visibleLimit)
      ) {
        next = clamp(activeIndex - Math.floor(visibleLimit / 2), 0, maximumWindowStart)
      } else {
        const previousMaximum = Math.max(0, previousCount - visibleLimit)
        if (landmarks.length > previousCount && clampedCurrent >= previousMaximum) {
          next = maximumWindowStart
        }
      }
      windowStartRef.current = next
      return next
    })

    previousSessionPathRef.current = sessionPath
    previousLandmarkCountRef.current = landmarks.length
  }, [activeEntryId, index?.sessionPath, landmarks, maximumWindowStart, visibleLimit])

  if (!index || landmarks.length < 2) return null

  const visibleStart = clamp(windowStart, 0, maximumWindowStart)
  const markers = landmarks.slice(visibleStart, visibleStart + visibleLimit)
  const markerPitch = MARKER_HEIGHT + gap
  const trackHeight = TRACK_VERTICAL_PADDING
    + markers.length * MARKER_HEIGHT
    + Math.max(0, markers.length - 1) * gap
  const hasBefore = visibleStart > 0
  const hasAfter = visibleStart + markers.length < landmarks.length

  /** Map against the bars' rendered span, not the full-height rail. */
  const nearestIndexAt = (clientY: number): number => {
    const track = trackRef.current
    if (!track) return 0
    const elements = track.querySelectorAll<HTMLElement>('.history-navigator-marker')
    if (elements.length < 2) return 0
    const firstRect = elements[0].getBoundingClientRect()
    const lastRect = elements[elements.length - 1].getBoundingClientRect()
    const firstCenter = firstRect.top + firstRect.height / 2
    const lastCenter = lastRect.top + lastRect.height / 2
    const renderedSpan = lastCenter - firstCenter
    if (renderedSpan <= 0) return 0
    const ratio = clamp((clientY - firstCenter) / renderedSpan, 0, 1)
    return Math.round(ratio * (elements.length - 1))
  }

  const showMarkerPreview = (markerIndex: number): void => {
    const landmark = markers[markerIndex]
    if (!landmark) return
    setHoverIndex(markerIndex)
    setPreview(landmark)
    const navigator = navigatorRef.current
    const bar = trackRef.current?.querySelectorAll<HTMLElement>('.history-navigator-marker')[markerIndex]
    if (navigator && bar) {
      const navigatorRect = navigator.getBoundingClientRect()
      const barRect = bar.getBoundingClientRect()
      const center = barRect.top + barRect.height / 2 - navigatorRect.top
      setPreviewTop(clamp(center / Math.max(navigatorRect.height, 1), 0.08, 0.92))
    }
  }

  /** Hover follows the cursor anywhere on the rail — gaps between bars count too. */
  const hoverAt = (clientY: number): void => {
    showMarkerPreview(nearestIndexAt(clientY))
  }

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    if ((!hasBefore && !hasAfter) || event.deltaY === 0) return
    event.preventDefault()
    event.stopPropagation()
    const direction: -1 | 1 = event.deltaY > 0 ? 1 : -1
    const current = clamp(windowStartRef.current, 0, maximumWindowStart)
    const canMove = direction > 0 ? current < maximumWindowStart : current > 0
    if (!canMove) return

    const rawSteps = event.deltaMode === 2
      ? visibleLimit
      : event.deltaMode === 1
        ? Math.abs(event.deltaY)
        : Math.abs(event.deltaY) / 36
    const requestedSteps = clamp(Math.max(1, Math.round(rawSteps)), 1, visibleLimit)
    const next = clamp(current + direction * requestedSteps, 0, maximumWindowStart)
    const movedSteps = next - current
    windowStartRef.current = next
    setWindowStart(next)
    setWheelMotion({
      nonce: ++wheelSequenceRef.current,
      offset: movedSteps * markerPitch
    })
    setHoverIndex(null)
    setPreview(null)
  }

  const handleTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (busy) return
    scrubbingRef.current = true
    lastScrubJumpRef.current = 0
    lastScrubEntryRef.current = null
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic pointer events used by tests do not own a native pointer.
    }
    hoverAt(event.clientY)
  }

  const handleTrackPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    hoverAt(event.clientY)
    if (!scrubbingRef.current || busy) return
    const now = Date.now()
    if (now - lastScrubJumpRef.current < 200) return
    const landmark = markers[nearestIndexAt(event.clientY)]
    if (!landmark || landmark.entryId === lastScrubEntryRef.current) return
    lastScrubJumpRef.current = now
    lastScrubEntryRef.current = landmark.entryId
    onJump(landmark)
  }

  const handleTrackPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const wasScrubbing = scrubbingRef.current
    scrubbingRef.current = false
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // The pointer may already have been released by the platform.
    }
    if (wasScrubbing && !busy) {
      const landmark = markers[nearestIndexAt(event.clientY)]
      if (landmark && landmark.entryId !== lastScrubEntryRef.current) onJump(landmark)
    }
    lastScrubEntryRef.current = null
  }

  return (
    <aside
      ref={navigatorRef}
      className={`history-navigator${busy ? ' busy' : ''}${hoverIndex !== null ? ' wave-active' : ''}`}
      aria-label="会话历史快速导航"
    >
      <div
        ref={trackRef}
        className={`history-navigator-track${hasBefore ? ' has-before' : ''}${hasAfter ? ' has-after' : ''}`}
        role="presentation"
        style={{ height: `${trackHeight}px` } as CSSProperties}
        onWheel={handleWheel}
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handleTrackPointerMove}
        onPointerUp={handleTrackPointerUp}
        onPointerCancel={() => {
          scrubbingRef.current = false
          lastScrubEntryRef.current = null
        }}
        onMouseLeave={() => {
          if (scrubbingRef.current) return
          setHoverIndex(null)
          setPreview(null)
        }}
      >
        <div
          key={`${index.sessionPath}:${wheelMotion?.nonce ?? 'steady'}`}
          className={`history-navigator-strip${wheelMotion ? ' wheel-scrolling' : ''}`}
          style={{
            gap: `${gap}px`,
            '--history-divider-offset': `${gap / 2}px`,
            '--history-wheel-offset': `${wheelMotion?.offset ?? 0}px`
          } as CSSProperties}
        >
          {markers.map((landmark, markerIndex) => {
            const active = landmark.entryId === activeEntryId
            const scale = waveScale(markerIndex, hoverIndex)
            const globalMarkerIndex = visibleStart + markerIndex
            const hasGroupDivider = (globalMarkerIndex + 1) % 5 === 0
              && globalMarkerIndex < landmarks.length - 1
            return (
              <div
                key={landmark.entryId}
                className={`history-navigator-marker-slot${hasGroupDivider ? ' has-group-divider' : ''}`}
                data-group-divider={hasGroupDivider ? 'true' : undefined}
              >
                <button
                  type="button"
                  className={`history-navigator-marker${active ? ' active' : ''}${markerIndex === hoverIndex ? ' hovered' : ''}`}
                  data-entry-id={landmark.entryId}
                  data-entry-index={landmark.entryIndex}
                  style={{ transform: `scaleX(${scale.toFixed(3)})` }}
                  aria-label={`跳到第 ${landmark.ordinal} 条历史消息：${landmark.snippet}`}
                  disabled={busy}
                  onFocus={() => showMarkerPreview(markerIndex)}
                  onBlur={() => {
                    setHoverIndex(null)
                    setPreview(null)
                  }}
                  onClick={(event) => {
                    event.stopPropagation()
                    // Pointer activation is handled by the rail's pointer-up logic so
                    // dragging can begin on a bar. detail=0 preserves keyboard and
                    // programmatic activation without issuing a duplicate jump.
                    if (event.detail === 0) onJump(landmark)
                  }}
                />
              </div>
            )
          })}
        </div>
      </div>

      <span className="history-navigator-range" aria-live="polite">
        当前显示第 {markers[0]?.ordinal ?? 0} 至 {markers.at(-1)?.ordinal ?? 0} 条，共 {landmarks.length} 条；在导航条上滚动鼠标滚轮可浏览更多。
      </span>

      {preview && (
        <div
          className="history-navigator-preview"
          style={{ top: `${previewTop * 100}%` } as CSSProperties}
          role="tooltip"
        >
          <strong>{preview.snippet}</strong>
          {preview.responseSnippet && <p>{preview.responseSnippet}</p>}
          <small>
            <span>第 {preview.ordinal} / {landmarks.length} 条</span>
            {formatLandmarkTime(preview.timestamp) && (
              <span><Clock3 size={10} /> {formatLandmarkTime(preview.timestamp)}</span>
            )}
          </small>
        </div>
      )}
    </aside>
  )
}
