import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { DOCK_STORAGE_KEY, dockEdgeAt, defaultDockLayout, measureDockLayout, moveDockPanel, readDockLayout, resizeDockSplit } from '../utils/dockLayout'
import type { DockDivider, DockEdge, DockPanel, DockRect } from '../utils/dockLayout'

const MIME = 'application/x-pion-dock-panel'
export function dockRectStyle(rect: DockRect): CSSProperties {
  return { left: `calc(${rect.x * 100}% + 3px)`, top: `calc(${rect.y * 100}% + 3px)`,
    width: `calc(${rect.width * 100}% - 6px)`, height: `calc(${rect.height * 100}% - 6px)` }
}

export function useDockLayout(visible: Record<DockPanel, boolean>) {
  const [layout, setLayout] = useState(readDockLayout)
  const [dragged, setDragged] = useState<DockPanel | null>(null)
  const [drop, setDrop] = useState<{ panel: DockPanel; edge: DockEdge } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const resizeRef = useRef<{ path: string; axis: 'x' | 'y'; start: number; ratio: number; span: number } | null>(null)
  const geometry = measureDockLayout(layout, visible)
  const endResize = () => { resizeRef.current = null; document.body.classList.remove('pion-resizing-panels') }
  useEffect(() => {
    try { localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(layout)) } catch { /* best effort */ }
  }, [layout])
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const resize = resizeRef.current
      if (!resize) return
      const delta = ((resize.axis === 'x' ? event.clientX : event.clientY) - resize.start) / resize.span
      const minimum = Math.min(0.4, 120 / resize.span)
      const ratio = Math.max(minimum, Math.min(1 - minimum, resize.ratio + delta))
      setLayout((current) => resizeDockSplit(current, resize.path, ratio))
    }
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { endResize(); setDragged(null); setDrop(null) }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', endResize)
    window.addEventListener('pointercancel', endResize)
    window.addEventListener('keydown', cancel)
    return () => {
      endResize()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', endResize)
      window.removeEventListener('pointercancel', endResize)
      window.removeEventListener('keydown', cancel)
    }
  }, [])
  const movePanel = (panel: DockPanel, target: DockPanel, edge: DockEdge) => {
    endResize()
    setLayout((current) => moveDockPanel(current, panel, target, edge))
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
      setLayout((current) => resizeDockSplit(current, path, ratio + (event.key === keys[0] ? -0.03 : 0.03)))
    },
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      const root = rootRef.current?.getBoundingClientRect()
      if (!root) return
      const span = axis === 'x' ? root.width * rect.width : root.height * rect.height
      if (span <= 0) return
      resizeRef.current = { path, axis, start: axis === 'x' ? event.clientX : event.clientY, ratio, span }
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
    reset: () => { endResize(); setDragged(null); setDrop(null); setLayout(defaultDockLayout()) } }
}
