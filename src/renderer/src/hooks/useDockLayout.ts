import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { DOCK_STORAGE_KEY, dockEdgeAt, defaultDockLayout, measureDockLayout, moveDockPanel, readDockLayout, resizeDockSplit } from '../utils/dockLayout'
import type { DockDivider, DockEdge, DockLayout, DockPanel, DockRect } from '../utils/dockLayout'

const MIME = 'application/x-pion-dock-panel'
const SAVE_DELAY = 250
interface DockResize {
  path: string; axis: 'x' | 'y'; start: number; ratio: number; span: number
  pointerId: number; layout: DockLayout; pendingRatio: number | null
}
export function dockRectStyle(rect: DockRect): CSSProperties {
  return { left: `calc(${rect.x * 100}% + 3px)`, top: `calc(${rect.y * 100}% + 3px)`,
    width: `calc(${rect.width * 100}% - 6px)`, height: `calc(${rect.height * 100}% - 6px)` }
}

export function useDockLayout(visible: Record<DockPanel, boolean>) {
  const [layout, setLayout] = useState(readDockLayout)
  const layoutRef = useRef(layout)
  // Only explicit user changes enter this slot; failed/default initial reads stay untouched.
  const pendingSave = useRef<DockLayout | null>(null)
  const saveTimer = useRef<number | null>(null)
  const [dragged, setDragged] = useState<DockPanel | null>(null)
  const [drop, setDrop] = useState<{ panel: DockPanel; edge: DockEdge } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const resizeRef = useRef<DockResize | null>(null)
  const resizeFrame = useRef<number | null>(null)
  const geometry = measureDockLayout(layout, visible)
  const flushSave = useCallback(() => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    saveTimer.current = null
    const snapshot = pendingSave.current
    if (!snapshot) return
    try {
      localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(snapshot))
      pendingSave.current = null
    } catch { /* retain the captured change for the next explicit flush */ }
  }, [])
  const updateLayout = useCallback((next: DockLayout, render = true) => {
    if (next === layoutRef.current) return
    layoutRef.current = next
    if (render) setLayout(next)
    pendingSave.current = next
    // A fixed window bounds the tail even during continuous keyboard/pointer input.
    if (saveTimer.current === null) saveTimer.current = window.setTimeout(flushSave, SAVE_DELAY)
  }, [flushSave])
  const flushResize = useCallback((render = true) => {
    if (resizeFrame.current !== null) window.cancelAnimationFrame(resizeFrame.current)
    resizeFrame.current = null
    const resize = resizeRef.current
    if (!resize || resize.pendingRatio === null) return
    const ratio = resize.pendingRatio
    resize.pendingRatio = null
    if (layoutRef.current !== resize.layout) return
    const next = resizeDockSplit(resize.layout, resize.path, ratio)
    resize.layout = next
    updateLayout(next, render)
  }, [updateLayout])
  const endResize = useCallback((render = true) => {
    flushResize(render)
    resizeRef.current = null
    document.body.classList.remove('pion-resizing-panels')
  }, [flushResize])
  const captureResize = useCallback((event: PointerEvent, schedule = true) => {
    const resize = resizeRef.current
    if (!resize || event.pointerId !== resize.pointerId) return
    const position = resize.axis === 'x' ? event.clientX : event.clientY
    if (!Number.isFinite(position)) return
    const delta = (position - resize.start) / resize.span
    const minimum = Math.min(0.4, 120 / resize.span)
    resize.pendingRatio = Math.max(minimum, Math.min(1 - minimum, resize.ratio + delta))
    if (schedule && resizeFrame.current === null) {
      resizeFrame.current = window.requestAnimationFrame(() => {
        if (resizeRef.current !== resize) return
        resizeFrame.current = null
        flushResize()
      })
    }
  }, [flushResize])
  useEffect(() => {
    const move = (event: PointerEvent) => captureResize(event)
    const end = (event: PointerEvent) => {
      if (event.pointerId !== resizeRef.current?.pointerId) return
      // pointercancel often has zero coordinates; keep its last captured move instead.
      if (event.type === 'pointerup') captureResize(event, false)
      endResize()
      flushSave()
    }
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { endResize(); flushSave(); setDragged(null); setDrop(null) }
    }
    const leave = () => { endResize(); flushSave() }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    window.addEventListener('keydown', cancel)
    window.addEventListener('pagehide', leave)
    return () => {
      endResize(false)
      flushSave()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('keydown', cancel)
      window.removeEventListener('pagehide', leave)
    }
  }, [captureResize, endResize, flushSave])
  const movePanel = (panel: DockPanel, target: DockPanel, edge: DockEdge) => {
    endResize()
    updateLayout(moveDockPanel(layoutRef.current, panel, target, edge))
    setDragged(null); setDrop(null)
  }
  const dropAt = (event: DragEvent<HTMLDivElement | HTMLElement>, panel: DockPanel) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { panel, edge: dockEdgeAt((event.clientX - rect.left) / Math.max(1, rect.width), (event.clientY - rect.top) / Math.max(1, rect.height)) }
  }
  const panelProps = (panel: DockPanel) => ({
    'data-dock-panel': panel,
    'data-dock-dragging': dragged === panel || undefined,
    style: geometry.panels[panel] ? dockRectStyle(geometry.panels[panel]!) : { display: 'none' } as CSSProperties,
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!dragged || !event.dataTransfer.types.includes(MIME)) return
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'
      if (dragged === panel) { setDrop(null); return }
      const next = dropAt(event, panel)
      setDrop((current) => current?.panel === next.panel && current.edge === next.edge ? current : next)
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!dragged || event.dataTransfer.getData(MIME) !== dragged) return
      event.preventDefault(); event.stopPropagation()
      const target = dropAt(event, panel)
      movePanel(dragged, panel, target.edge)
    }
  })
  const dragProps = (panel: DockPanel) => ({
    draggable: true,
    onDragStart: (event: DragEvent) => {
      event.stopPropagation(); event.dataTransfer.setData(MIME, panel)
      event.dataTransfer.effectAllowed = 'move'; setDragged(panel); setDrop(null)
    },
    onDragEnd: () => { setDragged(null); setDrop(null) }
  })
  const dividerProps = ({ path, axis, ratio, rect }: DockDivider) => ({
    tabIndex: 0,
    'aria-orientation': axis === 'x' ? 'vertical' as const : 'horizontal' as const,
    'aria-valuenow': Math.round(ratio * 100), 'aria-valuemin': 8, 'aria-valuemax': 92,
    style: axis === 'x'
      ? { left: `calc(${(rect.x + rect.width * ratio) * 100}% - 3px)`, top: `${rect.y * 100}%`, width: '6px', height: `${rect.height * 100}%` }
      : { left: `${rect.x * 100}%`, top: `calc(${(rect.y + rect.height * ratio) * 100}% - 3px)`, width: `${rect.width * 100}%`, height: '6px' },
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const keys = axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
      if (!keys.includes(event.key)) return
      event.preventDefault()
      endResize()
      const divider = measureDockLayout(layoutRef.current, visible).dividers.find((item) => item.path === path)
      if (divider) updateLayout(resizeDockSplit(layoutRef.current, path, divider.ratio + (event.key === keys[0] ? -0.03 : 0.03)))
    },
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      endResize()
      const root = rootRef.current?.getBoundingClientRect()
      const divider = measureDockLayout(layoutRef.current, visible).dividers.find((item) => item.path === path)
      if (!root || !divider) return
      const span = axis === 'x' ? root.width * divider.rect.width : root.height * divider.rect.height
      if (!Number.isFinite(span) || span <= 0) return
      resizeRef.current = { path, axis, start: axis === 'x' ? event.clientX : event.clientY, ratio: divider.ratio, span,
        pointerId: event.pointerId, layout: layoutRef.current, pendingRatio: null }
      try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* synthetic or already released pointer */ }
      document.body.classList.add('pion-resizing-panels')
    }
  })
  const previewRect = dragged && drop
    ? measureDockLayout(moveDockPanel(layout, dragged, drop.panel, drop.edge), visible).panels[dragged]
    : undefined
  return { rootRef, layout, panelProps, dragProps, dividerProps, movePanel,
    clearDrop: () => setDrop(null),
    dividers: geometry.dividers, dragged, drop,
    previewStyle: previewRect ? dockRectStyle(previewRect) : undefined,
    reset: () => { endResize(); setDragged(null); setDrop(null); updateLayout(defaultDockLayout()) } }
}
