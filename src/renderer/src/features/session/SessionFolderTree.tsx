import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps, DragEvent, ReactElement } from 'react'
import { ChevronRight, Folder, FolderInput, FolderPlus, Loader2, PencilLine, Trash2 } from 'lucide-react'
import type { SessionFolder, SessionOrganization, SessionOrganizationChange } from '../../../../shared/session-organization'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { TextInputDialog } from '../common/TextInputDialog'
import { SessionFolderMoveDialog, SessionItems } from './SessionList'
import { getSessionDrag, SESSION_DRAG_MIME } from '../../utils/sessionDrag'

export interface SessionFolderTreeProps {
  cwd: string
  organization: SessionOrganization
  onOrganizationChange: (change: SessionOrganizationChange) => Promise<void>
  organizationDisabled?: boolean
  searchActive?: boolean
  itemProps: ComponentProps<typeof SessionItems>
}

type Scope = { cwd: string; update: SessionFolderTreeProps['onOrganizationChange'] }
type FolderDialog = { scope: Scope } & (
  | { kind: 'create'; parentId?: string }
  | { kind: 'rename' | 'move' | 'delete'; folder: SessionFolder }
)

export function SessionFolderTree({
  cwd, organization, onOrganizationChange, organizationDisabled = false, searchActive = false, itemProps
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
  const [dropTarget, setDropTarget] = useState<{ scope: Scope; id: string | null } | null>(null)
  const [collapseIntent, setCollapseIntent] = useState<{ scope: Scope; id: string; collapsed: boolean } | null>(null)
  const reorderDisabled = useRef(itemProps.reorderDisabled)
  reorderDisabled.current = itemProps.reorderDisabled
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const { folders, parents, options } = useMemo(() => {
    // Keep exact worktree membership; broken ancestry projects at root.
    const folders = new Map<string, SessionFolder>()
    for (const folder of organization.folders) {
      if (folder.cwd === cwd && folder.id && !folders.has(folder.id)) folders.set(folder.id, folder)
    }
    const parents = new Map<string, string | undefined>()
    for (const folder of folders.values()) {
      const seen = new Set([folder.id])
      let parentId = folder.parentId
      let broken = false
      while (parentId) {
        if (seen.has(parentId) || !folders.has(parentId)) { broken = true; break }
        seen.add(parentId)
        parentId = folders.get(parentId)?.parentId
      }
      parents.set(folder.id, broken ? undefined : folder.parentId || undefined)
    }
    const options = [{ value: '', label: '根目录' }]
    const visit = (parentId: string | undefined, prefix: string): void => {
      for (const folder of folders.values()) {
        if (parents.get(folder.id) !== parentId) continue
        const label = prefix ? `${prefix} / ${folder.name}` : folder.name
        options.push({ value: folder.id, label })
        visit(folder.id, label)
      }
    }
    visit(undefined, '')
    return { folders, parents, options }
  }, [cwd, organization.folders])

  const placements = useMemo(() => new Map(organization.sessions
    .filter((placement) => placement.cwd === cwd)
    .map((placement) => [placement.path, placement])), [cwd, organization.sessions])
  const sessions = itemProps.sessions.filter((session) => (!session.projectCwd || session.projectCwd === cwd) && !placements.get(session.path)?.archived)
  const sessionFolderIds = new Map(sessions.map((session) => {
    const id = placements.get(session.path)?.folderId
    return [session.path, id && folders.has(id) ? id : undefined] as const
  }))
  const activeDialog = dialog?.scope === owner ? dialog : null
  useEffect(() => {
    setCollapseIntent((intent) => {
      if (!intent) return intent
      const folder = organization.folders.find((entry) => entry.id === intent.id && entry.cwd === cwd)
      return intent.scope !== owner || !folder || Boolean(folder.collapsed) === intent.collapsed ? null : intent
    })
  }, [cwd, organization.folders, owner])
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
    if (dropTarget?.scope !== owner) return
    const clear = (): void => setDropTarget(null)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => { window.removeEventListener('dragend', clear); window.removeEventListener('drop', clear) }
  }, [dropTarget, owner])
  const dragSource = (event: DragEvent<HTMLDivElement>, id: string | null, phase: 'over' | 'drop') => {
    const source = getSessionDrag(event.dataTransfer, cwd, phase)
    if (!source || !canMutate() || itemProps.pendingDeletePaths?.has(source.path) || placements.get(source.path)?.archived
      || (id !== null && !folders.has(id))) return null
    const currentFolder = placements.get(source.path)?.folderId
    if ((currentFolder && folders.has(currentFolder) ? currentFolder : null) === id) return null
    return source
  }
  const dragOver = (event: DragEvent<HTMLDivElement>, id: string | null): void => {
    if (!event.dataTransfer.types?.includes(SESSION_DRAG_MIME)) return
    event.stopPropagation()
    if (!dragSource(event, id, 'over')) {
      event.dataTransfer.dropEffect = 'none'
      setDropTarget(null)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTarget((current) => current?.scope === owner && current.id === id ? current : { scope: owner, id })
  }
  const dragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(null)
  }
  const drop = (event: DragEvent<HTMLDivElement>, id: string | null): void => {
    if (!event.dataTransfer.types?.includes(SESSION_DRAG_MIME)) return
    event.preventDefault()
    event.stopPropagation()
    setDropTarget(null)
    const source = dragSource(event, id, 'drop')
    if (source) void perform({ type: 'setSession', cwd, path: source.path, folderId: id }, false, id ?? undefined)
  }

  const renderItems = (folderId?: string): ReactElement => {
    const group = sessions.filter((session) => sessionFolderIds.get(session.path) === folderId)
    return <SessionItems key={cwd} {...itemProps}
      sessions={group}
      allowFolderDrag
      folderDragCwd={cwd}
      folderDragScope={owner}
      folderOptions={options}
      sessionFolderIds={sessionFolderIds}
      organizationDisabled={mutationsDisabled}
      onArchive={(path) => {
        const session = group.find((session) => session.path === path)
        if (!session || session.optimistic) return Promise.reject(new Error('会话尚未就绪。'))
        return commit({ type: 'setSession', cwd, path, archived: true, title: session.name || session.preview || '未命名会话' })
      }}
      onMoveToFolder={(path, targetId) => {
        if (!group.some((session) => session.path === path && !session.optimistic) || (targetId && !folders.has(targetId))) {
          return Promise.reject(new Error('请重新选择会话和目标文件夹。'))
        }
        return commit({ type: 'setSession', cwd, path, folderId: targetId })
      }}
      reorderDisabled={mutationsDisabled || itemProps.reorderDisabled}
      onReorder={itemProps.onReorder ? (reordered) => {
        if (!canMutate() || reorderDisabled.current) return
        // Replace just this group's original slots; every other group's order stays intact.
        const paths = new Set(group.map((session) => session.path))
        let index = 0
        itemProps.onReorder?.(itemProps.sessions.map((session) => paths.has(session.path) ? reordered[index++] : session))
      } : undefined}
    />
  }

  const renderFolders = (parentId?: string): ReactElement[] => [...folders.values()]
    .filter((folder) => parents.get(folder.id) === parentId)
    .map((folder) => {
      const collapsed = collapseIntent?.scope === owner && collapseIntent.id === folder.id ? collapseIntent.collapsed : folder.collapsed
      const expanded = searchActive || !collapsed
      const folderBusy = pendingFolder?.scope === owner && pendingFolder.id === folder.id
      return <div key={folder.id} className="session-folder" data-folder-id={folder.id} aria-busy={folderBusy}>
        <div className={`session-folder-heading${dropTarget?.scope === owner && dropTarget.id === folder.id && !mutationsDisabled ? ' session-folder-drop-target' : ''}`}
          data-session-drop-target={folder.id}
          onDragOver={(event) => dragOver(event, folder.id)} onDragLeave={dragLeave}
          onDrop={(event) => drop(event, folder.id)}>
          <button type="button" className="session-folder-toggle" aria-label={`文件夹 ${folder.name}`}
            aria-expanded={expanded} disabled={mutationsDisabled || searchActive}
            onClick={() => void toggleFolder(folder.id, !collapsed)}>
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
          {renderItems(folder.id)}
          {renderFolders(folder.id)}
        </div>
      </div>
    })

  const moveOptions = activeDialog?.kind === 'move' ? options.filter((option) => {
    let id: string | undefined = option.value
    const seen = new Set<string>()
    while (id) {
      if (id === activeDialog.folder.id || seen.has(id)) return false
      seen.add(id)
      // Check original ancestry too, so malformed cycles stay conservative.
      id = folders.get(id)?.parentId
    }
    return true
  }) : options

  return <div className="session-folder-tree">
    <div className={`session-folder-root${dropTarget?.scope === owner && dropTarget.id === null && !mutationsDisabled ? ' session-folder-drop-target' : ''}`}
      data-session-drop-target="root" role="group" aria-label="会话根目录" aria-busy={rootBusy}
      onDragOver={(event) => dragOver(event, null)} onDragLeave={dragLeave} onDrop={(event) => drop(event, null)}>
      <span className="session-folder-root-label">{rootBusy ? <Loader2 size={13} className="spin" aria-hidden="true" /> : <Folder size={13} aria-hidden="true" />}根目录</span>
      <button type="button" className="session-folder-create" disabled={mutationsDisabled}
        onClick={() => openDialog({ scope: owner, kind: 'create' })}><FolderPlus size={13} />新建文件夹</button>
      {rootBusy && <span role="status" className="session-folder-status">正在保存…</span>}
    </div>
    {error && !activeDialog && !currentFailure?.folderId && <div role="alert" className="session-organization-error">{error}</div>}
    {renderItems()}
    {renderFolders()}
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
}
