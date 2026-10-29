import type { SessionFolder, SessionOrganization, SessionOrganizationItem, SessionPlacement } from '../../../../shared/session-organization'
import { sessionOrganizationItemKey, sortSessionOrganizationItems } from '../../../../shared/session-organization'
import type { SessionMeta } from '../../../../shared/types'

type ParentId = string | undefined
type FolderOption = { value: string; label: string }
type RankedItem = { item: SessionOrganizationItem; order?: number }

export interface SessionFolderGroup {
  sessions: SessionMeta[]
  byPath: Map<string, SessionMeta>
  sessionPathsByKey: Map<string, string>
  items: SessionOrganizationItem[]
  automaticItems: SessionOrganizationItem[]
  itemKeys: Set<string>
}

export interface SessionFolderIndex {
  cwd: string
  folders: Map<string, SessionFolder>
  parents: Map<string, ParentId>
  placements: Map<string, SessionPlacement>
  options: FolderOption[]
  originalChildren: Map<ParentId, SessionFolder[]>
  cyclicAncestry: Set<string>
}

export interface SessionFolderProjection extends SessionFolderIndex {
  sessionFolderIds: Map<string, ParentId>
  sessionsByPath: Map<string, SessionMeta>
  groups: Map<ParentId, SessionFolderGroup>
}

function append<T>(groups: Map<ParentId, T[]>, parentId: ParentId, value: T): void {
  const group = groups.get(parentId)
  if (group) group.push(value)
  else groups.set(parentId, [value])
}

/** Snapshot-local indexes only: no receipts, persisted data or lifecycle state. */
export function indexSessionFolderOrganization(organization: SessionOrganization, cwd: string): SessionFolderIndex {
  const folders = new Map<string, SessionFolder>()
  const placements = new Map<string, SessionPlacement>()
  for (const folder of organization.folders) {
    if (folder.cwd === cwd && folder.id && !folders.has(folder.id)) folders.set(folder.id, folder)
  }
  for (const placement of organization.sessions) if (placement.cwd === cwd) placements.set(placement.path, placement)

  // Memoize each ancestry once, including all descendants of a corrupt ancestor.
  const ancestry = new Map<string, 'valid' | 'missing' | 'cycle'>()
  for (const folder of folders.values()) {
    if (ancestry.has(folder.id)) continue
    const trail = new Set<string>()
    let id: ParentId = folder.id
    let result: 'valid' | 'missing' | 'cycle' = 'valid'
    while (id) {
      const known = ancestry.get(id)
      if (known) { result = known; break }
      if (trail.has(id)) { result = 'cycle'; break }
      const current = folders.get(id)
      if (!current) { result = 'missing'; break }
      trail.add(id)
      id = current.parentId
    }
    for (const id of trail) ancestry.set(id, result)
  }
  const parents = new Map<string, ParentId>()
  const children = new Map<ParentId, SessionFolder[]>()
  const originalChildren = new Map<ParentId, SessionFolder[]>()
  const cyclicAncestry = new Set<string>()
  for (const folder of folders.values()) {
    const parentId = ancestry.get(folder.id) === 'valid' ? folder.parentId || undefined : undefined
    parents.set(folder.id, parentId)
    append(children, parentId, folder)
    append(originalChildren, folder.parentId, folder)
    if (ancestry.get(folder.id) === 'cycle') cyclicAncestry.add(folder.id)
  }

  const options: FolderOption[] = [{ value: '', label: '根目录' }]
  const stack = [...(children.get(undefined) ?? [])].reverse().map((folder) => ({ folder, prefix: '' }))
  while (stack.length) {
    const { folder, prefix } = stack.pop()!
    const label = prefix ? `${prefix} / ${folder.name}` : folder.name
    options.push({ value: folder.id, label })
    const nested = children.get(folder.id) ?? []
    for (let index = nested.length - 1; index >= 0; index--) stack.push({ folder: nested[index], prefix: label })
  }

  return { cwd, folders, parents, placements, options, originalChildren, cyclicAncestry }
}

/** Reuse topology and move labels across equivalent list and statistics refreshes. */
export function projectSessionFolderTree(index: SessionFolderIndex, sessions: SessionMeta[]): SessionFolderProjection {
  const { cwd, folders, parents, placements } = index
  const groups = new Map<ParentId, SessionFolderGroup>()
  const ranked = new Map<ParentId, RankedItem[]>()
  const fallback = new Map<ParentId, SessionOrganizationItem[]>()
  const groupFor = (parentId: ParentId): SessionFolderGroup => {
    let group = groups.get(parentId)
    if (!group) {
      group = { sessions: [], byPath: new Map(), sessionPathsByKey: new Map(), items: [], automaticItems: [], itemKeys: new Set() }
      groups.set(parentId, group)
    }
    return group
  }
  groupFor(undefined)
  const sessionFolderIds = new Map<string, ParentId>()
  const sessionsByPath = new Map<string, SessionMeta>()
  for (const session of sessions) {
    if (session.projectCwd && session.projectCwd !== cwd) continue
    const placement = placements.get(session.path)
    if (placement?.archived) continue
    const parentId = placement?.folderId && folders.has(placement.folderId) ? placement.folderId : undefined
    const group = groupFor(parentId)
    group.sessions.push(session)
    group.byPath.set(session.path, session)
    sessionFolderIds.set(session.path, parentId)
    sessionsByPath.set(session.path, session)
    const item: SessionOrganizationItem = { kind: 'session', path: session.path }
    const key = sessionOrganizationItemKey(item)
    if (group.itemKeys.has(key)) continue
    group.itemKeys.add(key)
    group.sessionPathsByKey.set(key, session.path)
    if (placement?.folderId === parentId) append(ranked, parentId, { item, order: placement?.order })
    else append(fallback, parentId, item)
  }
  for (const folder of folders.values()) {
    const parentId = parents.get(folder.id)
    const group = groupFor(parentId)
    groupFor(folder.id)
    const item: SessionOrganizationItem = { kind: 'folder', id: folder.id }
    group.itemKeys.add(sessionOrganizationItemKey(item))
    if (folder.parentId === parentId) append(ranked, parentId, { item, order: folder.order })
    else append(fallback, parentId, item)
  }
  for (const [parentId, group] of groups) {
    // Corrupt ancestry keeps its previous natural root fallback, after ordinary ranked items.
    group.items = [...sortSessionOrganizationItems(ranked.get(parentId) ?? []), ...(fallback.get(parentId) ?? [])]
    group.automaticItems = [...group.sessions.map((session) => ({ kind: 'session' as const, path: session.path })),
      ...group.items.filter((item) => item.kind === 'folder')]
  }
  return { ...index, sessionFolderIds, sessionsByPath, groups }
}

/** Original ancestry governs move safety even when corrupt folders display at root. */
export function sessionFolderMoveOptions(index: SessionFolderIndex, folderId: string): FolderOption[] {
  const excluded = new Set<string>()
  const stack = [folderId]
  while (stack.length) {
    const id = stack.pop()!
    if (excluded.has(id)) continue
    excluded.add(id)
    for (const child of index.originalChildren.get(id) ?? []) stack.push(child.id)
  }
  return index.options.filter((option) => !excluded.has(option.value) && !index.cyclicAncestry.has(option.value))
}
