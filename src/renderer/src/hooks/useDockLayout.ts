import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, PointerEvent as ReactPointerEvent } from 'react'
import { DOCK_PANELS, DOCK_STORAGE_KEY, moveDockPanel, normalizeDockLayout, readDockLayout } from '../utils/dockLayout'
import type { DockPanel, DockSlot } from '../utils/dockLayout'

const MIME = 'application/x-pion-dock-panel'
export function useDockLayout(visible: Record<DockPanel, boolean>) {
  const [layout, setLayout] = useState(readDockLayout)
  const [dragged, setDragged] = useState<DockPanel | null>(null)
  const [dropTarget, setDropTarget] = useState<DockPanel | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const resizeRef = useRef<{ axis: 'left' | 'right' | 'bottom'; start: number; size: number } | null>(null)
  useEffect(() => {
    try { localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(layout)) } catch { /* best effort */ }
  }, [layout])
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const resize = resizeRef.current
      const rect = rootRef.current?.getBoundingClientRect()
      if (!resize || !rect) return
      const coordinate = resize.axis === 'bottom' ? event.clientY : event.clientX
      const delta = (coordinate - resize.start) * (resize.axis === 'left' ? 1 : -1)
      const max = resize.axis === 'bottom' ? rect.height * 0.7 : rect.width * 0.4
      const value = Math.max(160, Math.min(max, resize.size + delta))
      setLayout((current) => ({ ...current, [resize.axis]: value }))
    }
    const end = () => { resizeRef.current = null; document.body.classList.remove('pion-resizing-panels') }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      end()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [])
  const occupied = (slot: DockSlot) => DOCK_PANELS.some((panel) => visible[panel] && layout.slots[panel] === slot)
  const left = occupied('left')
  const right = occupied('right')
  const center = occupied('center')
  const bottom = occupied('bottom')
  const movePanel = (panel: DockPanel, slot: DockSlot) => setLayout((current) => moveDockPanel(current, panel, slot))
  const rootStyle = {
    '--dock-left': `${layout.left}px`, '--dock-right': `${layout.right}px`, '--dock-bottom': `${layout.bottom}px`,
    '--dock-divider-bottom': bottom ? `min(${layout.bottom}px, 70%)` : '0px',
    gridTemplateColumns: `${left ? center || right ? 'min(var(--dock-left), 40%)' : 'minmax(0, 1fr)' : '0px'} ${center ? 'minmax(0, 1fr)' : '0px'} ${right ? center ? 'min(var(--dock-right), 40%)' : 'minmax(0, 1fr)' : '0px'}`,
    gridTemplateRows: `${left || center || right ? 'minmax(0, 1fr)' : '0px'} ${bottom ? left || center || right ? 'min(var(--dock-bottom), 70%)' : 'minmax(0, 1fr)' : '0px'}`
  } as CSSProperties
  const panelProps = (panel: DockPanel) => ({
    'data-dock-panel': panel,
    style: { gridArea: layout.slots[panel], display: visible[panel] ? undefined : 'none' } as CSSProperties,
    onDragOver: (event: DragEvent) => {
      if (!dragged || !event.dataTransfer.types.includes(MIME)) return
      event.preventDefault(); event.stopPropagation(); setDropTarget(panel)
    },
    onDrop: (event: DragEvent) => {
      if (!dragged || event.dataTransfer.getData(MIME) !== dragged) return
      event.preventDefault(); event.stopPropagation()
      movePanel(dragged, layout.slots[panel]); setDragged(null); setDropTarget(null)
    }
  })
  const dragProps = (panel: DockPanel) => ({
    draggable: true,
    onDragStart: (event: DragEvent) => {
      event.stopPropagation(); event.dataTransfer.setData(MIME, panel)
      event.dataTransfer.effectAllowed = 'move'; setDragged(panel)
    },
    onDragEnd: () => { setDragged(null); setDropTarget(null) }
  })
  const resizeProps = (axis: 'left' | 'right' | 'bottom') => ({
    tabIndex: 0,
    'aria-valuenow': Math.round(layout[axis]),
    'aria-valuemin': 160,
    onKeyDown: (event: import('react').KeyboardEvent<HTMLDivElement>) => {
      const directions = axis === 'bottom' ? ['ArrowDown', 'ArrowUp'] : axis === 'left' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowRight', 'ArrowLeft']
      const direction = directions.indexOf(event.key)
      if (direction < 0) return
      event.preventDefault()
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const max = axis === 'bottom' ? rect.height * 0.7 : rect.width * 0.4
      setLayout((current) => ({ ...current, [axis]: Math.max(160, Math.min(max, current[axis] + (direction ? 20 : -20))) }))
    },
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const actual = axis === 'bottom' ? Math.min(layout.bottom, rect.height * 0.7)
        : Math.min(layout[axis], rect.width * 0.4)
      resizeRef.current = { axis, start: axis === 'bottom' ? event.clientY : event.clientX, size: actual }
      document.body.classList.add('pion-resizing-panels')
    }
  })
  return { rootRef, rootStyle, layout, panelProps, dragProps, resizeProps, movePanel,
    dropTarget, left: left && (center || right), right: right && center, bottom: bottom && (left || center || right),
    reset: () => setLayout(normalizeDockLayout(null)) }
}
