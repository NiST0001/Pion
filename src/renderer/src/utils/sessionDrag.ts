export const SESSION_DRAG_MIME = 'application/x-pion-session'

export interface SessionDragData {
  cwd: string
  path: string
}

interface SessionDragReceipt {
  data: SessionDragData
  payload: string
  owner: object
  isCurrent: () => boolean
}

// Renderer-local UI lifecycle receipt, with no authentication or OS isolation role.
let activeDrag: SessionDragReceipt | null = null

export function beginSessionDrag(
  transfer: Pick<DataTransfer, 'setData'>,
  data: SessionDragData,
  owner: object,
  isCurrent: () => boolean,
): boolean {
  activeDrag = null
  try {
    if (!isCurrent()) return false
    const snapshot = { cwd: data.cwd, path: data.path }
    const payload = JSON.stringify({ version: 1, ...snapshot })
    transfer.setData(SESSION_DRAG_MIME, payload)
    activeDrag = { data: snapshot, payload, owner, isCurrent }
    return true
  } catch {
    return false
  }
}

export function getSessionDrag(
  transfer: Pick<DataTransfer, 'types' | 'getData'>,
  cwd: string,
  phase: 'over' | 'drop',
): SessionDragData | null {
  const receipt = activeDrag
  // Consume before validation, including rejected drops and throwing callbacks.
  if (phase === 'drop') activeDrag = null
  if (!receipt) return null
  try {
    if (!transfer.types.includes(SESSION_DRAG_MIME)
      || receipt.data.cwd !== cwd
      || !receipt.isCurrent()) return null
    // Native dragover uses protected mode: only the MIME list is available.
    if (phase === 'drop' && transfer.getData(SESSION_DRAG_MIME) !== receipt.payload) return null
    return { ...receipt.data }
  } catch {
    return null
  }
}

export function endSessionDrag(owner: object): void {
  if (activeDrag?.owner === owner) activeDrag = null
}
