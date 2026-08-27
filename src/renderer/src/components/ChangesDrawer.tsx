import { useEffect } from 'react'
import type { ReactElement } from 'react'
import { FilePenLine, FilePlus2, X } from 'lucide-react'
import type { FileChange } from '../hooks/useAgent'
import { DiffView } from './DiffView'

export function ChangesDrawer({
  change,
  onClose
}: {
  change: FileChange | null
  onClose: () => void
}): ReactElement | null {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  if (!change) return null

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          {change.kind === 'edit' ? <FilePenLine size={14} /> : <FilePlus2 size={14} />}
          <span className="drawer-title" title={change.path}>
            {change.path}
          </span>
          <span className="tool-stats">
            <span className="stat-add">+{change.additions}</span>
            <span className="stat-del">−{change.deletions}</span>
          </span>
          <button className="icon-button" onClick={onClose}>
            <X size={15} />
          </button>
        </header>
        <div className="drawer-body">
          {change.kind === 'edit' && change.diff && <DiffView diff={change.diff} />}
          {change.kind === 'write' && <pre className="file-preview">{change.content}</pre>}
        </div>
      </aside>
    </div>
  )
}
