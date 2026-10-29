import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps, DragEvent, ReactElement } from 'react'
import { ChevronRight, Folder, FolderInput, FolderPlus, GripVertical, Loader2, PencilLine, Trash2 } from 'lucide-react'
import type { SessionFolder, SessionOrganization, SessionOrganizationChange, SessionOrganizationItem } from '../../../../shared/session-organization'
import { sessionOrganizationItemKey } from '../../../../shared/session-organization'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { TextInputDialog } from '../common/TextInputDialog'
import { SessionFolderMoveDialog, SessionItems } from './SessionList'
import { getSessionDrag, SESSION_DRAG_MIME } from '../../utils/sessionDrag'
import { beginSessionFolderDrag, endSessionFolderDrag, getSessionFolderDrag, SESSION_FOLDER_DRAG_MIME } from '../../utils/sessionFolderDrag'
import { moveSidebarKey } from '../project/SortableSidebarGroup'
import { indexSessionFolderOrganization, projectSessionFolderTree, sessionFolderMoveOptions } from './session-folder-projection'

export interface SessionFolderHeaderControls {
  disabled: boolean
  onCreateFolder: () => void
  rootDropProps: Pick<ComponentProps<'div'>, 'onDragOver' | 'onDragLeave' | 'onDrop' | 'className' | 'aria-busy'> & {
    'data-session-drop-target': 'root'
  }
}

export interface SessionFolderTreeProps {
  cwd: string
  organization: SessionOrganization
  onOrganizationChange: (change: SessionOrganizationChange) => Promise<void>
  organizationDisabled?: boolean
  searchActive?: boolean
  manualOrder?: boolean
  className?: string
  hidden?: boolean
  renderHeader?: (controls: SessionFolderHeaderControls) => ReactElement
  itemProps: ComponentProps<typeof SessionItems>
}

type Scope = { cwd: string; update: SessionFolderTreeProps['onOrganizationChange'] }
type FolderDialog = { scope: Scope } & (
  | { kind: 'create'; parentId?: string }
  | { kind: 'rename' | 'move' | 'delete'; folder: SessionFolder }
)

export function SessionFolderTree({
  cwd, organization, onOrganizationChange, organizationDisabled = false, searchActive = false, manualOrder = true,
  className, hidden = false, renderHeader, itemProps
}: SessionFolderTreeProps): ReactElement {
  const scope = useRef<Scope>({ cwd, update: onOrganizationChange })
  if (scope.current.cwd !== cwd || scope.current.update !== onOrganizationChange) scope.current = { cwd, update: onOrganizationChange }
  const owner = scope.current
  const mounted = useRef(true)
  const pending = useRef(false)
  const disabled = useRef(organizationDisabled)
  disabled.current = organizationDisabled
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<FolderDialog | null>(null)
  const [failure, setFailure] = useState<{ scope: Scope; message: string; folderId?: string } | null>(null)
  const [pendingFolder, setPendingFolder] = useState<{ scope: Scope; id: string | null } | null>(null)
  const [dropTarget, setDropTarget] = useState<{ scope: Scope; epoch: object; id: string | null } | null>(null)
  const [collapseIntent, setCollapseIntent] = useState<{ scope: Scope; id: string; collapsed: boolean } | null>(null)
  const reorderDisabled = useRef(itemProps.reorderDisabled)
  reorderDisabled.current = itemProps.reorderDisabled
  const api = window.pion
  const sessionSignature = JSON.stringify(itemProps.sessions.map((session) => [session.projectCwd ?? cwd, session.path, session.id, Boolean(session.optimistic)]))
  const deletingSignature = JSON.stringify([...(itemProps.pendingDeletePaths ?? [])].sort())
  const dragState = { owner, api, organization, revision: organization.revision, searchActive, manualOrder, hidden, organizationDisabled, busy,
    reorderDisabled: itemProps.reorderDisabled, sessionSignature, deletingSignature }
  const dragEpoch = useRef(dragState)
  if (dragEpoch.current.owner !== owner || dragEpoch.current.api !== api || dragEpoch.current.organization !== organization
    || dragEpoch.current.revision !== organization.revision
    || dragEpoch.current.searchActive !== searchActive || dragEpoch.current.manualOrder !== manualOrder || dragEpoch.current.hidden !== hidden
    || dragEpoch.current.organizationDisabled !== organizationDisabled || dragEpoch.current.busy !== busy
    || dragEpoch.current.reorderDisabled !== itemProps.reorderDisabled || dragEpoch.current.sessionSignature !== sessionSignature
    || dragEpoch.current.deletingSignature !== deletingSignature) {
    dragEpoch.current = dragState
  }
  const epoch = dragEpoch.current
  const [draggedFolder, setDraggedFolder] = useState<{ epoch: object; id: string } | null>(null)
  const [folderOver, setFolderOver] = useState<{ epoch: object; key: string; edge?: 'before' | 'after' } | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const folderIndex = useMemo(() => indexSessionFolderOrganization(organization, cwd), [cwd, organization])
  const { folders, parents, placements, options } = folderIndex
  const { sessionFolderIds, sessionsByPath, groups } = useMemo(() => projectSessionFolderTree(folderIndex, itemProps.sessions),
    [folderIndex, itemProps.sessions])
  const activeDialog = dialog?.scope === owner ? dialog : null
  useEffect(() => {
    setCollapseIntent((intent) => {
      if (!intent) return intent
      const folder = folders.get(intent.id)
      return intent.scope !== owner || !folder || Boolean(folder.collapsed) === intent.collapsed ? null : intent
    })
  }, [folders, owner])
  const currentFailure = failure?.scope === owner ? failure : null
  const error = currentFailure?.message ?? ''
  const canMutate = (): boolean => mounted.current && scope.current === owner && !disabled.current && !pending.current

  const commit = async (change: SessionOrganizationChange): Promise<void> => {
    if (!canMutate()) throw new Error('会话整理暂不可用，请稍后重试。')
    pending.current = true
    setBusy(true)
    setFailure(null)
    if (change.type === 'deleteFolder' || change.type === 'setFolderCollapsed') setPendingFolder({ scope: owner, id: change.id })
    if (change.type === 'setSession' && 'folderId' in change) setPendingFolder({ scope: owner, id: change.folderId ?? null })
    if (change.type === 'reorderFolders' || change.type === 'reorderItems') setPendingFolder({ scope: owner, id: change.parentId ?? null })
    try {
      await onOrganizationChange(change)
    } finally {
      pending.current = false
      if (mounted.current) { setBusy(false); setPendingFolder(null) }
    }
  }
  const perform = async (change: SessionOrganizationChange, closeDialog = false, folderId?: string): Promise<boolean> => {
    try {
      await commit(change)
      if (mounted.current && scope.current === owner && closeDialog) setDialog(null)
      return true
    } catch (err) {
      if (mounted.current && scope.current === owner) setFailure({ scope: owner, folderId, message: err instanceof Error ? err.message : String(err) })
      return false
    }
  }
  const toggleFolder = async (id: string, collapsed: boolean): Promise<void> => {
    if (searchActive || !canMutate()) return
    const intent = { scope: owner, id, collapsed }
    setCollapseIntent(intent)
    const saved = await perform({ type: 'setFolderCollapsed', id, collapsed }, false, id)
    if (!saved && mounted.current) setCollapseIntent((current) => current === intent ? null : current)
  }
  const openDialog = (next: FolderDialog): void => {
    if (!canMutate()) return
    setFailure(null)
    setDialog(next)
  }
  const cancelDialog = (): void => { if (!pending.current) { setDialog(null); setFailure(null) } }
  const mutationsDisabled = organizationDisabled || busy
  const rootBusy = pendingFolder?.scope === owner && pendingFolder.id === null
  useEffect(() => {
    const clear = (): void => {
      setDropTarget((current) => current?.epoch === epoch ? null : current)
      setFolderOver((current) => current?.epoch === epoch ? null : current)
      setDraggedFolder((current) => current?.epoch === epoch ? null : current)
      endSessionFolderDrag(epoch)
    }
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => { window.removeEventListener('dragend', clear); window.removeEventListener('drop', clear); clear() }
  }, [epoch])
  const canReorderFolders = (): boolean => canMutate() && dragEpoch.current === epoch && window.pion === api
    && !busy && !searchActive && !hidden && !reorderDisabled.current
  const groupItems = (parentId?: string): SessionOrganizationItem[] => groups.get(parentId)!.items
  const canReorderItems = (parentId?: string): boolean => manualOrder && canReorderFolders()
    && groups.get(parentId)!.sessions.every((session) => !session.optimistic && !itemProps.pendingDeletePaths?.has(session.path))
  const itemParent = (item: SessionOrganizationItem): string | undefined => item.kind === 'folder'
    ? parents.get(item.id) : sessionFolderIds.get(item.path)
  const mixedSource = (event: DragEvent<HTMLDivElement>, target: SessionOrganizationItem, phase: 'over' | 'drop'): SessionOrganizationItem | null => {
    // Choose the intent before consuming the one private source receipt.
    let source: SessionOrganizationItem | null = null
    if (event.dataTransfer.types.includes(SESSION_FOLDER_DRAG_MIME)) {
      const receipt = getSessionFolderDrag(event.dataTransfer, cwd, phase)
      const folder = receipt && folders.get(receipt.id)
      if (receipt && folder && draggedFolder?.epoch === epoch && draggedFolder.id === receipt.id
        && receipt.parentId === folder.parentId && parents.get(folder.id) === folder.parentId) source = { kind: 'folder', id: folder.id }
    } else if (event.dataTransfer.types.includes(SESSION_DRAG_MIME)) {
      const receipt = getSessionDrag(event.dataTransfer, cwd, phase, epoch)
      const session = receipt && sessionsByPath.get(receipt.path)
      if (session && !session.optimistic && !itemProps.pendingDeletePaths?.has(session.path)) source = { kind: 'session', path: session.path }
    }
    const parentId = itemParent(target)
    if (!source || !canReorderItems(parentId) || itemParent(source) !== parentId
      || sessionOrganizationItemKey(source) === sessionOrganizationItemKey(target)
      || !groups.get(parentId)?.itemKeys.has(sessionOrganizationItemKey(target))) return null
    return source
  }
  const reorderItems = (source: SessionOrganizationItem, target: SessionOrganizationItem, edge?: 'before' | 'after'): void => {
    const parentId = itemParent(target), items = groupItems(parentId), keys = items.map(sessionOrganizationItemKey)
    const sourceKey = sessionOrganizationItemKey(source), targetKey = sessionOrganizationItemKey(target)
    let next: string[]
    if (edge) {
      next = keys.filter((key) => key !== sourceKey)
      next.splice(next.indexOf(targetKey) + (edge === 'after' ? 1 : 0), 0, sourceKey)
    } else next = moveSidebarKey(keys, sourceKey, targetKey)
    if (next.every((key, index) => key === keys[index])) return
    const byKey = new Map(items.map((item) => [sessionOrganizationItemKey(item), item]))
    void perform({ type: 'reorderItems', cwd, ...(parentId ? { parentId } : {}), expectedRevision: organization.revision,
      items: next.map((key) => byKey.get(key)!) }, false, parentId)
  }
  const targetEdge = (event: DragEvent<HTMLDivElement>, fraction = 0.5): 'before' | 'after' | undefined => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (!(rect.height > 0) || !Number.isFinite(rect.height) || !Number.isFinite(rect.top) || !Number.isFinite(event.clientY)) return
    if (event.clientY < rect.top + rect.height * fraction) return 'before'
    if (fraction === 0.5 || event.clientY > rect.top + rect.height * (1 - fraction)) return 'after'
    return
  }
  const headingEdge = (event: DragEvent<HTMLDivElement>): 'before' | 'after' | undefined => {
    if (!manualOrder || searchActive || hidden) return
    return targetEdge(event, 0.25)
  }
  const typedDrag = (event: DragEvent<HTMLDivElement>): boolean => event.dataTransfer.types?.includes(SESSION_FOLDER_DRAG_MIME)
    || event.dataTransfer.types?.includes(SESSION_DRAG_MIME)
  const startFolderDrag = (event: DragEvent<HTMLButtonElement>, folder: SessionFolder): void => {
    event.stopPropagation()
    if (!canReorderFolders() || folder.parentId !== parents.get(folder.id)) { event.preventDefault(); return }
    const isCurrent = (): boolean => canReorderFolders() && folders.get(folder.id) === folder
    if (!beginSessionFolderDrag(event.dataTransfer, { cwd, id: folder.id,
      ...(folder.parentId ? { parentId: folder.parentId } : {}) }, epoch, isCurrent)) { event.preventDefault(); return }
    event.dataTransfer.effectAllowed = 'move'
    setDraggedFolder({ epoch, id: folder.id })
    setFolderOver(null)
    setDropTarget(null)
  }
  const folderSource = (event: DragEvent<HTMLDivElement>, id: string | null, phase: 'over' | 'drop') => {
    const source = getSessionFolderDrag(event.dataTransfer, cwd, phase)
    const folder = source && folders.get(source.id)
    const target = id === null ? undefined : folders.get(id)
    if (!source || !folder || !target || !canReorderFolders() || draggedFolder?.epoch !== epoch
      || draggedFolder.id !== source.id || source.id === id || source.parentId !== folder.parentId
      || target.parentId !== source.parentId || parents.get(target.id) !== target.parentId) return null
    return source
  }
  const dragSource = (event: DragEvent<HTMLDivElement>, id: string | null, phase: 'over' | 'drop') => {
    const source = getSessionDrag(event.dataTransfer, cwd, phase)
    if (!source || !canMutate() || hidden || window.pion !== api || itemProps.pendingDeletePaths?.has(source.path) || placements.get(source.path)?.archived
      || (id !== null && !folders.has(id))) return null
    const currentFolder = placements.get(source.path)?.folderId
    if ((currentFolder && folders.has(currentFolder) ? currentFolder : null) === id) return null
    return source
  }
  const dragOver = (event: DragEvent<HTMLDivElement>, id: string | null): void => {
    if (!typedDrag(event)) return
    event.stopPropagation()
    const folderDrag = event.dataTransfer.types.includes(SESSION_FOLDER_DRAG_MIME)
    const edge = id !== null ? (folderDrag ? targetEdge(event) : headingEdge(event)) : undefined
    const mixed = id !== null && (folderDrag ? manualOrder : Boolean(edge))
    const target: SessionOrganizationItem | null = id === null ? null : { kind: 'folder', id }
    const source = mixed ? mixedSource(event, target!, 'over')
      : folderDrag ? folderSource(event, id, 'over') : dragSource(event, id, 'over')
    if (!source) { event.dataTransfer.dropEffect = 'none'; setDropTarget(null); setFolderOver(null); return }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (folderDrag || edge) {
      setDropTarget(null)
      const key = sessionOrganizationItemKey(target!)
      setFolderOver(current => current?.epoch === epoch && current.key === key && current.edge === edge
        ? current : { epoch, key, ...(edge ? { edge } : {}) })
    } else {
      setFolderOver(null)
      setDropTarget(current => current?.epoch === epoch && current.id === id ? current : { scope: owner, epoch, id })
    }
  }
  const dragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
      setDropTarget(null)
      setFolderOver(null)
    }
  }
  const drop = (event: DragEvent<HTMLDivElement>, id: string | null): void => {
    if (!typedDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    const folderDrag = event.dataTransfer.types.includes(SESSION_FOLDER_DRAG_MIME)
    // Recompute the actual drop geometry; the last hover may have a different intent.
    const edge = id !== null ? (folderDrag ? targetEdge(event) : headingEdge(event)) : undefined
    const mixed = id !== null && (folderDrag ? manualOrder : Boolean(edge))
    setFolderOver(null)
    setDraggedFolder(null)
    setDropTarget(null)
    if (mixed) {
      const target: SessionOrganizationItem = { kind: 'folder', id: id! }
      const source = mixedSource(event, target, 'drop')
      if (source) reorderItems(source, target, edge)
    } else if (folderDrag) {
      const source = folderSource(event, id, 'drop')
      if (source) {
        const siblings = groupItems(source.parentId).filter((item) => item.kind === 'folder').map((item) => item.id)
        const ids = edge ? siblings.filter((id) => id !== source.id) : moveSidebarKey(siblings, source.id, id!)
        if (edge) ids.splice(ids.indexOf(id!) + (edge === 'after' ? 1 : 0), 0, source.id)
        if (!ids.every((id, index) => id === siblings[index])) void perform({ type: 'reorderFolders', cwd, ids,
          ...(source.parentId ? { parentId: source.parentId } : {}) }, false, source.parentId)
      }
    } else {
      const source = dragSource(event, id, 'drop')
      if (source) void perform({ type: 'setSession', cwd, path: source.path, folderId: id }, false, id ?? undefined)
    }
  }
  const sessionDragOver: NonNullable<ComponentProps<typeof SessionItems>['siblingDrag']>['onDragOver'] = (event, session) => {
    if (!typedDrag(event)) return
    event.stopPropagation()
    setDropTarget(null)
    const target: SessionOrganizationItem = { kind: 'session', path: session.path }
    if (!mixedSource(event, target, 'over')) { event.dataTransfer.dropEffect = 'none'; setFolderOver(null); return }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const key = sessionOrganizationItemKey(target), edge = targetEdge(event)
    setFolderOver(current => current?.epoch === epoch && current.key === key && current.edge === edge
      ? current : { epoch, key, ...(edge ? { edge } : {}) })
  }
  const sessionDrop: NonNullable<ComponentProps<typeof SessionItems>['siblingDrag']>['onDrop'] = (event, session) => {
    if (!typedDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    const target: SessionOrganizationItem = { kind: 'session', path: session.path }
    const source = mixedSource(event, target, 'drop')
    setFolderOver(null)
    setDraggedFolder(null)
    setDropTarget(null)
    if (source) reorderItems(source, target, targetEdge(event))
  }

  const renderLevel = (folderId?: string): ReactElement => {
    const group = groups.get(folderId)!
    const refs = manualOrder ? group.items : group.automaticItems
    return <SessionItems key={cwd} {...itemProps}
      sessions={group.sessions}
      allowFolderDrag
      folderDragCwd={cwd}
      folderDragScope={epoch}
      folderOptions={options}
      sessionFolderIds={sessionFolderIds}
      organizationDisabled={mutationsDisabled}
      onArchive={(path) => {
        const session = group.byPath.get(path)
        if (!session || session.optimistic) return Promise.reject(new Error('会话尚未就绪。'))
        return commit({ type: 'setSession', cwd, path, archived: true, title: session.name || session.preview || '未命名会话' })
      }}
      onMoveToFolder={(path, targetId) => {
        const session = group.byPath.get(path)
        if (!session || session.optimistic || (targetId && !folders.has(targetId))) {
          return Promise.reject(new Error('请重新选择会话和目标文件夹。'))
        }
        return commit({ type: 'setSession', cwd, path, folderId: targetId })
      }}
      reorderDisabled={mutationsDisabled || itemProps.reorderDisabled}
      onReorder={undefined}
      siblingDrag={{
        targetPath: folderOver?.epoch === epoch ? group.sessionPathsByKey.get(folderOver.key) : undefined,
        targetEdge: folderOver?.epoch === epoch ? folderOver.edge : undefined,
        onDragOver: sessionDragOver, onDragLeave: dragLeave, onDrop: sessionDrop
      }}
      renderWithSiblings={(renderSession) => refs.map((ref) => ref.kind === 'session'
        ? renderSession(group.byPath.get(ref.path)!) : renderFolder(folders.get(ref.id)!))}
    />
  }

  const renderFolder = (folder: SessionFolder): ReactElement => {
      const collapsed = collapseIntent?.scope === owner && collapseIntent.id === folder.id ? collapseIntent.collapsed : folder.collapsed
      const expanded = searchActive || !collapsed
      const folderBusy = pendingFolder?.scope === owner && pendingFolder.id === folder.id
      const over = folderOver?.epoch === epoch && folderOver.key === sessionOrganizationItemKey({ kind: 'folder', id: folder.id }) ? folderOver : null
      return <div key={sessionOrganizationItemKey({ kind: 'folder', id: folder.id })} className="session-folder" data-folder-id={folder.id} aria-busy={folderBusy}>
        <div className={`session-folder-heading${dropTarget?.scope === owner && dropTarget.epoch === epoch && dropTarget.id === folder.id && !mutationsDisabled ? ' session-folder-drop-target' : ''}${draggedFolder?.epoch === epoch && draggedFolder.id === folder.id ? ' is-dragging' : ''}${over ? ' is-drop-target' : ''}`}
          data-session-drop-target={folder.id} data-drop-edge={over?.edge}
          onDragOver={(event) => dragOver(event, folder.id)} onDragLeave={dragLeave}
          onDrop={(event) => drop(event, folder.id)}>
          <button type="button" className="session-folder-toggle" aria-label={`文件夹 ${folder.name}`}
            aria-expanded={expanded} disabled={mutationsDisabled || searchActive}
            draggable={canReorderFolders() && folder.parentId === parents.get(folder.id)}
            title={manualOrder ? '拖拽调整同级会话和文件夹顺序' : '拖拽调整同级文件夹顺序'}
            onDragStart={(event) => startFolderDrag(event, folder)}
            onDragEnd={(event) => {
              event.stopPropagation()
              endSessionFolderDrag(epoch)
              setDraggedFolder((current) => current?.epoch === epoch ? null : current)
              setFolderOver((current) => current?.epoch === epoch ? null : current)
            }}
            onClick={() => void toggleFolder(folder.id, !collapsed)}>
            <GripVertical size={13} className="side-session-drag session-folder-drag" aria-hidden="true" />
            <ChevronRight size={12} className={expanded ? 'expanded' : ''} aria-hidden="true" />
            {folderBusy ? <Loader2 size={13} className="spin" aria-hidden="true" /> : <Folder size={13} aria-hidden="true" />}<span>{folder.name}</span>
          </button>
          <div className="session-folder-actions">
            <button type="button" title="新建子文件夹" aria-label={`在 ${folder.name} 中新建文件夹`} disabled={mutationsDisabled}
              onClick={() => openDialog({ scope: owner, kind: 'create', parentId: folder.id })}><FolderPlus size={12} /></button>
            <button type="button" title="重命名文件夹" aria-label={`重命名文件夹 ${folder.name}`} disabled={mutationsDisabled}
              onClick={() => openDialog({ scope: owner, kind: 'rename', folder })}><PencilLine size={12} /></button>
            <button type="button" title="移动文件夹" aria-label={`移动文件夹 ${folder.name}`} disabled={mutationsDisabled}
              onClick={() => openDialog({ scope: owner, kind: 'move', folder })}><FolderInput size={12} /></button>
            <button type="button" title="删除文件夹" aria-label={`删除文件夹 ${folder.name}`} disabled={mutationsDisabled}
              onClick={() => openDialog({ scope: owner, kind: 'delete', folder })}><Trash2 size={12} /></button>
          </div>
        </div>
        {folderBusy && <span role="status" className="session-folder-status">正在保存…</span>}
        {currentFailure?.folderId === folder.id && <div role="alert" className="session-organization-error">{error}</div>}
        <div className="session-folder-content" hidden={!expanded} inert={!expanded}>
          {renderLevel(folder.id)}
        </div>
      </div>
  }

  const movingFolderId = activeDialog?.kind === 'move' ? activeDialog.folder.id : undefined
  const moveOptions = useMemo(() => movingFolderId === undefined ? options : sessionFolderMoveOptions(folderIndex, movingFolderId),
    [folderIndex, movingFolderId, options])

  const rootDropProps: SessionFolderHeaderControls['rootDropProps'] = {
    'data-session-drop-target': 'root',
    'aria-busy': rootBusy,
    className: dropTarget?.scope === owner && dropTarget.epoch === epoch && dropTarget.id === null && !mutationsDisabled ? 'session-folder-drop-target' : undefined,
    onDragOver: (event) => dragOver(event, null), onDragLeave: dragLeave, onDrop: (event) => drop(event, null)
  }
  return <>
    {renderHeader?.({ disabled: mutationsDisabled,
      onCreateFolder: () => openDialog({ scope: owner, kind: 'create' }), rootDropProps })}
    <div {...(!renderHeader ? rootDropProps : {})}
      className={`session-folder-tree${className ? ` ${className}` : ''}${!renderHeader && rootDropProps.className ? ` ${rootDropProps.className}` : ''}`}
      hidden={hidden} inert={hidden}>
    {rootBusy && <span role="status" className="session-folder-status">正在保存…</span>}
    {error && !activeDialog && !currentFailure?.folderId && <div role="alert" className="session-organization-error">{error}</div>}
    {renderLevel()}
    <TextInputDialog
      open={activeDialog?.kind === 'create' || activeDialog?.kind === 'rename'}
      title={activeDialog?.kind === 'rename' ? '重命名文件夹' : '新建文件夹'}
      label="文件夹名称" initialValue={activeDialog?.kind === 'rename' ? activeDialog.folder.name : ''}
      confirmLabel="保存" busy={mutationsDisabled} error={error}
      onConfirm={(name) => {
        if (activeDialog?.kind === 'create') void perform({ type: 'createFolder', cwd, id: crypto.randomUUID(), name, ...(activeDialog.parentId ? { parentId: activeDialog.parentId } : {}) }, true)
        if (activeDialog?.kind === 'rename') void perform({ type: 'renameFolder', id: activeDialog.folder.id, name }, true)
      }} onCancel={cancelDialog}
    />
    <SessionFolderMoveDialog open={activeDialog?.kind === 'move'} title="移动文件夹"
      options={moveOptions} initialValue={activeDialog?.kind === 'move' ? parents.get(activeDialog.folder.id) ?? '' : ''}
      busy={busy} disabled={organizationDisabled} error={error}
      onConfirm={(parentId) => {
        if (activeDialog?.kind === 'move' && moveOptions.some((option) => option.value === parentId)) {
          void perform({ type: 'moveFolder', id: activeDialog.folder.id, ...(parentId ? { parentId } : {}) }, true)
        }
      }} onCancel={cancelDialog}
    />
    <ConfirmDialog open={activeDialog?.kind === 'delete'} title="删除文件夹"
      message={<>删除“{activeDialog && 'folder' in activeDialog ? activeDialog.folder.name : ''}”？其中的会话和子文件夹将移到父目录，会话历史保留。</>}
      detail={error || undefined} confirmLabel="删除文件夹" busy={mutationsDisabled}
      onConfirm={() => {
        if (activeDialog?.kind !== 'delete' || !canMutate()) return
        setDialog(null)
        void perform({ type: 'deleteFolder', id: activeDialog.folder.id }, false, activeDialog.folder.id)
      }}
      onCancel={cancelDialog}
    />
    </div>
  </>
}
