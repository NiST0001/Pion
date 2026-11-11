/** Display-only organization; never changes SDK session files or Agent lifecycle. */
export interface SessionFolder {
  id: string
  cwd: string
  name: string
  parentId?: string
  collapsed?: boolean
  order?: number
}

export interface SessionPlacement {
  cwd: string
  path: string
  folderId?: string
  archived?: boolean
  title?: string
  order?: number
}

export interface SessionOrganization {
  version: 1
  revision: number
  folders: SessionFolder[]
  sessions: SessionPlacement[]
}

export type SessionOrganizationItem = { kind: 'folder'; id: string } | { kind: 'session'; path: string }

export function sessionOrganizationItemKey(item: SessionOrganizationItem): string {
  return JSON.stringify([item.kind, item.kind === 'folder' ? item.id : item.path])
}

export type SessionOrganizationChange =
  | { type: 'createFolder'; id: string; cwd: string; name: string; parentId?: string }
  | { type: 'renameFolder'; id: string; name: string }
  | { type: 'moveFolder'; id: string; parentId?: string }
  | { type: 'reorderFolders'; cwd: string; parentId?: string; ids: string[] }
  | { type: 'reorderItems'; cwd: string; parentId?: string; expectedRevision: number; items: SessionOrganizationItem[] }
  | { type: 'deleteFolder'; id: string }
  | { type: 'setFolderCollapsed'; id: string; collapsed: boolean }
  | { type: 'setSession'; cwd: string; path: string; folderId?: string | null; archived?: boolean; title?: string }

export function sessionPlacementKey(cwd: string, path: string): string {
  return JSON.stringify([cwd, path])
}

function invalid(): never { throw new Error('会话分组参数无效') }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}

/** JSON and structured-clone boundaries validate ordinary fields and reject unknown keys. */
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null)
  for (const [key, entry] of Object.entries(record(value))) {
    if (!allowed.includes(key)) return invalid()
    result[key] = entry
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

function nonnegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid()
  return value
}

function organizationItem(value: unknown): SessionOrganizationItem {
  const input = record(value)
  const kind = Object.hasOwn(input, 'kind') ? input.kind : undefined
  if (kind === 'folder') {
    const raw = fields(value, ['kind', 'id'])
    return { kind, id: text(raw.id) }
  }
  if (kind === 'session') {
    const raw = fields(value, ['kind', 'path'])
    return { kind, path: text(raw.path) }
  }
  return invalid()
}

function items<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) return invalid()
  return Array.from(value, parse)
}

function folder(value: unknown): SessionFolder {
  const raw = fields(value, ['id', 'cwd', 'name', 'parentId', 'collapsed', 'order'])
  return {
    id: text(raw.id), cwd: text(raw.cwd), name: text(raw.name),
    ...('parentId' in raw ? { parentId: text(raw.parentId) } : {}),
    ...('collapsed' in raw ? { collapsed: bool(raw.collapsed) } : {}),
    ...('order' in raw ? { order: nonnegativeInteger(raw.order) } : {})
  }
}

function placement(value: unknown): SessionPlacement {
  const raw = fields(value, ['cwd', 'path', 'folderId', 'archived', 'title', 'order'])
  return {
    cwd: text(raw.cwd), path: text(raw.path),
    ...('folderId' in raw ? { folderId: text(raw.folderId) } : {}),
    ...('archived' in raw ? { archived: bool(raw.archived) } : {}),
    ...('title' in raw ? { title: text(raw.title, true) } : {}),
    ...('order' in raw ? { order: nonnegativeInteger(raw.order) } : {})
  }
}

/** Validates the complete graph and returns an independent canonical snapshot. */
export function validateSessionOrganization(value: unknown): SessionOrganization {
  const raw = fields(value, ['version', 'revision', 'folders', 'sessions'])
  if (raw.version !== 1) return invalid()
  const result: SessionOrganization = { version: 1, revision: nonnegativeInteger(raw.revision), folders: items(raw.folders, folder), sessions: items(raw.sessions, placement) }
  assertOrganizationGraph(result)
  return result
}

/** Shared graph invariants for boundary snapshots and the final typed patch result. */
function assertOrganizationGraph({ folders, sessions }: SessionOrganization): void {
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
}

/** Ranked entries precede unranked entries; ties retain their natural input order. */
export function sortSessionOrganizationItems(entries: { item: SessionOrganizationItem; order?: number }[]): SessionOrganizationItem[] {
  return entries.map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.index - b.index)
    .map((entry) => entry.item)
}

/** Projects only the caller's real sessions; stale placement records never add rows. */
export function orderedSessionOrganizationItems(organization: SessionOrganization, cwd: string, parentId: string | undefined, sessionPaths: string[]): SessionOrganizationItem[] {
  const placements = new Map(organization.sessions.filter((entry) => entry.cwd === cwd).map((entry) => [entry.path, entry]))
  const base: { item: SessionOrganizationItem; order?: number }[] = []
  for (const path of new Set(sessionPaths)) {
    const entry = placements.get(path)
    if (entry?.folderId !== parentId || entry?.archived === true) continue
    base.push({ item: { kind: 'session', path }, order: entry?.order })
  }
  for (const entry of organization.folders) {
    if (entry.cwd === cwd && entry.parentId === parentId) base.push({ item: { kind: 'folder', id: entry.id }, order: entry.order })
  }
  return sortSessionOrganizationItems(base)
}

export function validateSessionOrganizationChange(value: unknown): SessionOrganizationChange {
  const input = record(value)
  const type = Object.hasOwn(input, 'type') ? input.type : undefined
  switch (type) {
    case 'createFolder': {
      const raw = fields(value, ['type', 'id', 'cwd', 'name', 'parentId'])
      return { type, id: text(raw.id), cwd: text(raw.cwd), name: text(raw.name), ...('parentId' in raw ? { parentId: text(raw.parentId) } : {}) }
    }
    case 'renameFolder': {
      const raw = fields(value, ['type', 'id', 'name'])
      return { type, id: text(raw.id), name: text(raw.name) }
    }
    case 'moveFolder': {
      const raw = fields(value, ['type', 'id', 'parentId'])
      return { type, id: text(raw.id), ...('parentId' in raw ? { parentId: text(raw.parentId) } : {}) }
    }
    case 'reorderFolders': {
      const raw = fields(value, ['type', 'cwd', 'parentId', 'ids'])
      const ids = items(raw.ids, (item) => text(item))
      if (new Set(ids).size !== ids.length) return invalid()
      return { type, cwd: text(raw.cwd), ...('parentId' in raw ? { parentId: text(raw.parentId) } : {}), ids }
    }
    case 'reorderItems': {
      const raw = fields(value, ['type', 'cwd', 'parentId', 'expectedRevision', 'items'])
      const refs = items(raw.items, organizationItem)
      if (new Set(refs.map(sessionOrganizationItemKey)).size !== refs.length) return invalid()
      return { type, cwd: text(raw.cwd), ...('parentId' in raw ? { parentId: text(raw.parentId) } : {}), expectedRevision: nonnegativeInteger(raw.expectedRevision), items: refs }
    }
    case 'deleteFolder': {
      const raw = fields(value, ['type', 'id'])
      return { type, id: text(raw.id) }
    }
    case 'setFolderCollapsed': {
      const raw = fields(value, ['type', 'id', 'collapsed'])
      return { type, id: text(raw.id), collapsed: bool(raw.collapsed) }
    }
    case 'setSession': {
      const raw = fields(value, ['type', 'cwd', 'path', 'folderId', 'archived', 'title'])
      return {
        type, cwd: text(raw.cwd), path: text(raw.path),
        ...('folderId' in raw ? { folderId: raw.folderId === null ? null : text(raw.folderId) } : {}),
        ...('archived' in raw ? { archived: bool(raw.archived) } : {}),
        ...('title' in raw ? { title: text(raw.title, true) } : {})
      }
    }
    default: return invalid()
  }
}

export function applySessionOrganizationChange(value: SessionOrganization, input: unknown): SessionOrganization {
  return applyValidatedSessionOrganizationChange(validateSessionOrganization(value), validateSessionOrganizationChange(input))
}

/** Internal typed patches copy once and check the final graph, without reparsing snapshots. */
export function applyValidatedSessionOrganizationChange(value: SessionOrganization, change: SessionOrganizationChange): SessionOrganization {
  const result: SessionOrganization = { ...value, folders: value.folders.map((entry) => ({ ...entry })), sessions: value.sessions.map((entry) => ({ ...entry })) }
  if (result.revision === Number.MAX_SAFE_INTEGER) return invalid()
  if (change.type === 'setSession') {
    const key = sessionPlacementKey(change.cwd, change.path)
    let entry = result.sessions.find((item) => sessionPlacementKey(item.cwd, item.path) === key)
    if (!entry) { entry = { cwd: change.cwd, path: change.path }; result.sessions.push(entry) }
    if ('folderId' in change) {
      if (entry.folderId !== (change.folderId ?? undefined)) delete entry.order
      if (change.folderId === null) delete entry.folderId
      else entry.folderId = change.folderId
    }
    if ('archived' in change) entry.archived = change.archived
    if ('title' in change) entry.title = change.title
  } else if (change.type === 'createFolder') {
    result.folders.push({ id: change.id, cwd: change.cwd, name: change.name, ...('parentId' in change ? { parentId: change.parentId } : {}) })
  } else if (change.type === 'reorderFolders') {
    if (change.parentId !== undefined && !result.folders.some((entry) => entry.id === change.parentId && entry.cwd === change.cwd)) return invalid()
    const siblings = result.folders.filter((entry) => entry.cwd === change.cwd && entry.parentId === change.parentId)
    const byId = new Map(siblings.map((entry) => [entry.id, entry]))
    if (change.ids.length !== siblings.length || change.ids.some((id) => !byId.has(id))) return invalid()
    // Legacy folder-only sorting reuses the group's folder ranks, leaving session slots intact.
    const ranks = siblings.map((entry) => entry.order).sort((a, b) => a === undefined ? (b === undefined ? 0 : 1) : b === undefined ? -1 : a - b)
    for (const [index, id] of change.ids.entries()) {
      const entry = byId.get(id)!
      if (ranks[index] === undefined) delete entry.order
      else entry.order = ranks[index]
    }
    let index = 0
    result.folders = result.folders.map((entry) => byId.has(entry.id) ? byId.get(change.ids[index++])! : entry)
  } else if (change.type === 'reorderItems') {
    if (change.expectedRevision !== result.revision) return invalid()
    if (change.parentId !== undefined && !result.folders.some((entry) => entry.id === change.parentId && entry.cwd === change.cwd)) return invalid()
    const siblings = new Map(result.folders.filter((entry) => entry.cwd === change.cwd && entry.parentId === change.parentId).map((entry) => [entry.id, entry]))
    const placements = new Map(result.sessions.filter((entry) => entry.cwd === change.cwd).map((entry) => [entry.path, entry]))
    const knownPaths = new Set(result.sessions.map((entry) => entry.path))
    const folderRefs = change.items.filter((item) => item.kind === 'folder')
    if (folderRefs.length !== siblings.size || new Set(change.items.map(sessionOrganizationItemKey)).size !== change.items.length) return invalid()
    for (const [order, ref] of change.items.entries()) {
      if (ref.kind === 'folder') {
        const entry = siblings.get(ref.id)
        if (!entry) return invalid()
        entry.order = order
      } else {
        let entry = placements.get(ref.path)
        if (entry) {
          if (entry.folderId !== change.parentId || entry.archived === true) return invalid()
        } else {
          if (change.parentId !== undefined || knownPaths.has(ref.path)) return invalid()
          // Root implicit placements are display metadata, with no SDK or filesystem existence claim.
          entry = { cwd: change.cwd, path: ref.path }
          result.sessions.push(entry)
        }
        entry.order = order
      }
    }
  } else {
    const entry = result.folders.find((item) => item.id === change.id)
    if (!entry) return invalid()
    switch (change.type) {
      case 'renameFolder': entry.name = change.name; break
      case 'moveFolder':
        if (entry.parentId !== change.parentId) delete entry.order
        if (change.parentId === undefined) delete entry.parentId
        else entry.parentId = change.parentId
        break
      case 'setFolderCollapsed': entry.collapsed = change.collapsed; break
      case 'deleteFolder':
        result.folders = result.folders.filter((item) => item.id !== entry.id)
        for (const child of result.folders) {
          if (child.parentId !== entry.id) continue
          delete child.order
          if (entry.parentId === undefined) delete child.parentId
          else child.parentId = entry.parentId
        }
        for (const session of result.sessions) {
          if (session.folderId !== entry.id) continue
          delete session.order
          if (entry.parentId === undefined) delete session.folderId
          else session.folderId = entry.parentId
        }
        break
    }
  }
  result.revision += 1
  assertOrganizationGraph(result)
  return result
}
