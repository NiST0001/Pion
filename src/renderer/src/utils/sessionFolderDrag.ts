import { createInternalDrag } from './internalDrag'

export const SESSION_FOLDER_DRAG_MIME = 'application/x-pion-session-folder'

export interface SessionFolderDragData {
  cwd: string
  id: string
  parentId?: string
}

const sessionFolderDrag = createInternalDrag<SessionFolderDragData>(
  SESSION_FOLDER_DRAG_MIME,
  (data) => ({ cwd: data.cwd, id: data.id, ...(data.parentId ? { parentId: data.parentId } : {}) }),
)

export const beginSessionFolderDrag = sessionFolderDrag.begin
export const getSessionFolderDrag = sessionFolderDrag.get
export const endSessionFolderDrag = sessionFolderDrag.end
