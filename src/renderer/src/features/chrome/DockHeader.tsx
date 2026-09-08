import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeftRight, Ellipsis, GripVertical, PanelBottom, PanelLeft, PanelRight, PanelTop, X } from 'lucide-react'
import type { DragEvent } from 'react'
import { DOCK_EDGES, DOCK_EDGE_LABELS, DOCK_LABELS } from '../../utils/dockLayout'
import type { DockEdge, DockPanel } from '../../utils/dockLayout'

const EDGE_ICONS = { left: PanelLeft, right: PanelRight, top: PanelTop, bottom: PanelBottom, center: ArrowLeftRight }
export function DockHeader({ panel, targets, onMove, onClose, dragProps }: {
  panel: DockPanel
  targets: DockPanel[]
  onMove: (target: DockPanel, edge: DockEdge) => void
  onClose?: () => void
  dragProps: { draggable: boolean; onDragStart: (event: DragEvent) => void; onDragEnd: () => void }
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const title = DOCK_LABELS[panel]
  const close = () => { setOpen(false); buttonRef.current?.focus({ preventScroll: true }) }
  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !menuRef.current) return
    const button = buttonRef.current.getBoundingClientRect()
    const menu = menuRef.current.getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(button.right - menu.width, window.innerWidth - menu.width - 8)),
      top: Math.max(8, button.bottom + menu.height + 8 < window.innerHeight ? button.bottom + 6 : button.top - menu.height - 6) })
    menuRef.current.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !buttonRef.current?.contains(event.target)) setOpen(false)
    }
    const resize = () => setOpen(false)
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', resize)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize) }
  }, [open])
  return <div className="dock-header">
    <div className="dock-grip" {...dragProps} title={`拖动${title}到其他面板边缘分栏，放到中央交换位置`}
      onDragStart={(event) => { setOpen(false); dragProps.onDragStart(event) }}>
      <GripVertical size={12} className="dock-grip-icon" /><span>{title}</span>
    </div>
    <div className="dock-header-actions">
      <button ref={buttonRef} type="button" className="dock-header-button" aria-label={`${title}布局`} title="调整布局"
        aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? menuId : undefined} onClick={() => setOpen((value) => !value)}><Ellipsis size={15} /></button>
      {onClose && <button type="button" className="dock-header-button" aria-label={`隐藏${title}面板`} title={`隐藏${title}`} onClick={onClose}><X size={13} /></button>}
    </div>
    {open && createPortal(<div ref={menuRef} id={menuId} className="dock-layout-menu" role="dialog" aria-label={`${title}布局选项`}
      style={position} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}
      onBlur={(event) => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== buttonRef.current) setOpen(false) }}>
      <div className="dock-layout-menu-heading">移动{title}<span>选择目标与方向</span></div>
      {targets.filter((target) => target !== panel).map((target) => <div className="dock-layout-target" key={target}>
        <span>{DOCK_LABELS[target]}</span>
        <div>{DOCK_EDGES.map((edge) => {
          const Icon = EDGE_ICONS[edge]
          const label = edge === 'center' ? `与${DOCK_LABELS[target]}交换位置` : `放到${DOCK_LABELS[target]}${DOCK_EDGE_LABELS[edge]}`
          return <button key={edge} type="button" title={label} aria-label={label} onClick={() => { onMove(target, edge); close() }}><Icon size={15} /></button>
        })}</div>
      </div>)}
      {targets.every((target) => target === panel) && <p>先打开其他面板，再调整分栏。</p>}
      <div className="dock-layout-menu-hint">也可直接拖动标题，在任意面板边缘分栏</div>
    </div>, document.body)}
  </div>
}
