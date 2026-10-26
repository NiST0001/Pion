import { createInternalDrag } from './internalDrag'

export const SESSION_DRAG_MIME = 'application/x-pion-session'

export interface SessionDragData {
  cwd: string
  path: string
}

const sessionDrag = createInternalDrag<SessionDragData>(
  SESSION_DRAG_MIME,
  (data) => ({ cwd: data.cwd, path: data.path }),
)

export const beginSessionDrag = sessionDrag.begin
export const getSessionDrag = sessionDrag.get
export const endSessionDrag = sessionDrag.end
