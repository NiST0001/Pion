import { GripVertical, X } from 'lucide-react'
import type { DragEvent } from 'react'
import { DOCK_SLOTS } from '../../utils/dockLayout'
import type { DockSlot } from '../../utils/dockLayout'
const LABELS: Record<DockSlot, string> = { left: '左侧', center: '中间', right: '右侧', bottom: '底部' }

export function DockHeader({ title, slot, onMove, onClose, dragProps }: {
  title: string
  slot: DockSlot
  onMove: (slot: DockSlot) => void
  onClose?: () => void
  dragProps: { draggable: boolean; onDragStart: (event: DragEvent) => void; onDragEnd: () => void }
}) {
  return <div className="dock-header">
    <span className="dock-grip" {...dragProps} title={`拖动${title}到其他面板以交换位置`}>
      <GripVertical size={13} /><span>{title}</span>
    </span>
    <select aria-label={`${title}停靠位置`} value={slot} onChange={(event) => onMove(event.target.value as DockSlot)}>
      {DOCK_SLOTS.map((key) => <option key={key} value={key}>{LABELS[key]}</option>)}
    </select>
    {onClose && <button type="button" className="icon-button" aria-label={`隐藏${title}面板`} onClick={onClose}><X size={13} /></button>}
  </div>
}
