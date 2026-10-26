/** Display-only organization; never changes SDK session files or Agent lifecycle. */
export interface SessionFolder {
  id: string
  cwd: string
  name: string
  parentId?: string
  collapsed?: boolean
}

export interface SessionPlacement {
  cwd: string
  path: string
  folderId?: string
  archived?: boolean
  title?: string
}

export interface SessionOrganization {
  version: 1
  revision: number
  folders: SessionFolder[]
  sessions: SessionPlacement[]
}

export type SessionOrganizationChange =
  | { type: 'createFolder'; id: string; cwd: string; name: string; parentId?: string }
  | { type: 'renameFolder'; id: string; name: string }
  | { type: 'moveFolder'; id: string; parentId?: string }
  | { type: 'deleteFolder'; id: string }
  | { type: 'setFolderCollapsed'; id: string; collapsed: boolean }
  | { type: 'setSession'; cwd: string; path: string; folderId?: string | null; archived?: boolean; title?: string }

export function sessionPlacementKey(cwd: string, path: string): string {
  return JSON.stringify([cwd, path])
}

function invalid(): never { throw new Error('会话分组参数无效') }

/** Copy data descriptors only; unknown keys, accessors and exotic objects are rejected. */
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return invalid()
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) return invalid()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!descriptor.enumerable || !('value' in descriptor)) return invalid()
    result[key] = descriptor.value
  }
  return result
}

function text(value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string' || value.includes('\0') || (!allowEmpty && !value.trim())) return invalid()
  return value
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalid()
  return value
}

function items<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) return invalid()
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !('value' in descriptor)) return invalid()
    return parse(descriptor.value)
  })
}

function folder(value: unknown): SessionFolder {
  const raw = fields(value, ['id', 'cwd', 'name', 'parentId', 'collapsed'])
  return {
    id: text(raw.id), cwd: text(raw.cwd), name: text(raw.name),
    ...('parentId' in raw ? { parentId: text(raw.parentId) } : {}),
    ...('collapsed' in raw ? { collapsed: bool(raw.collapsed) } : {})
  }
}

function placement(value: unknown): SessionPlacement {
  const raw = fields(value, ['cwd', 'path', 'folderId', 'archived', 'title'])
  return {
    cwd: text(raw.cwd), path: text(raw.path),
    ...('folderId' in raw ? { folderId: text(raw.folderId) } : {}),
    ...('archived' in raw ? { archived: bool(raw.archived) } : {}),
    ...('title' in raw ? { title: text(raw.title, true) } : {})
  }
}

/** Validates the complete graph and returns an independent canonical snapshot. */
export function validateSessionOrganization(value: unknown): SessionOrganization {
  const raw = fields(value, ['version', 'revision', 'folders', 'sessions'])
  if (raw.version !== 1 || typeof raw.revision !== 'number' || !Number.isSafeInteger(raw.revision) || raw.revision < 0) return invalid()
  const folders = items(raw.folders, folder)
  const sessions = items(raw.sessions, placement)
  const byId = new Map<string, SessionFolder>()
  for (const entry of folders) {
    if (byId.has(entry.id)) return invalid()
    byId.set(entry.id, entry)
  }
  const assertFolder = (id: string, cwd: string): SessionFolder => {
    const entry = byId.get(id)
    if (!entry || entry.cwd !== cwd) return invalid()
    return entry
  }
  // Iterative walking also handles deeply nested user-created folders.
  const checked = new Set<string>()
  for (const entry of folders) {
    const visiting = new Set<string>()
    let current: SessionFolder | undefined = entry
    while (current && !checked.has(current.id)) {
      if (visiting.has(current.id)) return invalid()
      visiting.add(current.id)
      current = current.parentId === undefined ? undefined : assertFolder(current.parentId, current.cwd)
    }
    for (const id of visiting) checked.add(id)
  }
  const keys = new Set<string>()
  for (const entry of sessions) {
    const key = sessionPlacementKey(entry.cwd, entry.path)
    if (keys.has(key)) return invalid()
    keys.add(key)
    if (entry.folderId !== undefined) assertFolder(entry.folderId, entry.cwd)
  }
  return { version: 1, revision: raw.revision, folders, sessions }
}

export function validateSessionOrganizationChange(value: unknown): SessionOrganizationChange {
  const raw = fields(value, ['type', 'id', 'cwd', 'name', 'parentId', 'collapsed', 'path', 'folderId', 'archived', 'title'])
  switch (raw.type) {
    case 'createFolder': {
      fields(value, ['type', 'id', 'cwd', 'name', 'parentId'])
      return { type: raw.type, id: text(raw.id), cwd: text(raw.cwd), name: text(raw.name), ...('parentId' in raw ? { parentId: text(raw.parentId) } : {}) }
    }
    case 'renameFolder':
      fields(value, ['type', 'id', 'name'])
      return { type: raw.type, id: text(raw.id), name: text(raw.name) }
    case 'moveFolder':
      fields(value, ['type', 'id', 'parentId'])
      return { type: raw.type, id: text(raw.id), ...('parentId' in raw ? { parentId: text(raw.parentId) } : {}) }
    case 'deleteFolder':
      fields(value, ['type', 'id'])
      return { type: raw.type, id: text(raw.id) }
    case 'setFolderCollapsed':
      fields(value, ['type', 'id', 'collapsed'])
      return { type: raw.type, id: text(raw.id), collapsed: bool(raw.collapsed) }
    case 'setSession':
      fields(value, ['type', 'cwd', 'path', 'folderId', 'archived', 'title'])
      return {
        type: raw.type, cwd: text(raw.cwd), path: text(raw.path),
        ...('folderId' in raw ? { folderId: raw.folderId === null ? null : text(raw.folderId) } : {}),
        ...('archived' in raw ? { archived: bool(raw.archived) } : {}),
        ...('title' in raw ? { title: text(raw.title, true) } : {})
      }
    default: return invalid()
  }
}

/** Applies a patch without touching the input, then revalidates graph invariants. */
export function applySessionOrganizationChange(value: SessionOrganization, input: unknown): SessionOrganization {
  const result = validateSessionOrganization(value)
  const change = validateSessionOrganizationChange(input)
  if (result.revision === Number.MAX_SAFE_INTEGER) return invalid()
  if (change.type === 'setSession') {
    const key = sessionPlacementKey(change.cwd, change.path)
    let entry = result.sessions.find((item) => sessionPlacementKey(item.cwd, item.path) === key)
    if (!entry) { entry = { cwd: change.cwd, path: change.path }; result.sessions.push(entry) }
    if ('folderId' in change) {
      if (change.folderId === null) delete entry.folderId
      else entry.folderId = change.folderId
    }
    if ('archived' in change) entry.archived = change.archived
    if ('title' in change) entry.title = change.title
  } else if (change.type === 'createFolder') {
    if (result.folders.some((entry) => entry.id === change.id)) return invalid()
    result.folders.push({ id: change.id, cwd: change.cwd, name: change.name, ...('parentId' in change ? { parentId: change.parentId } : {}) })
  } else {
    const entry = result.folders.find((item) => item.id === change.id)
    if (!entry) return invalid()
    switch (change.type) {
      case 'renameFolder': entry.name = change.name; break
      case 'moveFolder':
        if (change.parentId === undefined) delete entry.parentId
        else entry.parentId = change.parentId
        break
      case 'setFolderCollapsed': entry.collapsed = change.collapsed; break
      case 'deleteFolder':
        result.folders = result.folders.filter((item) => item.id !== entry.id)
        for (const child of result.folders) {
          if (child.parentId !== entry.id) continue
          if (entry.parentId === undefined) delete child.parentId
          else child.parentId = entry.parentId
        }
        for (const session of result.sessions) {
          if (session.folderId !== entry.id) continue
          if (entry.parentId === undefined) delete session.folderId
          else session.folderId = entry.parentId
        }
        break
    }
  }
  result.revision += 1
  return validateSessionOrganization(result)
}
