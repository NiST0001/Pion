import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Check, ChevronDown, FolderOpen } from 'lucide-react'
import type { ProjectMeta } from '../../../shared/types'

export function ProjectPicker({
  projects,
  value,
  disabled = false,
  onChange
}: {
  projects: ProjectMeta[]
  value: string
  disabled?: boolean
  onChange: (cwd: string) => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const selectedIndex = projects.findIndex((project) => project.cwd === value)
  const selectedProject = selectedIndex >= 0 ? projects[selectedIndex] : undefined

  useEffect(() => {
    if (!open) return
    const index = selectedIndex >= 0 ? selectedIndex : 0
    const focusTimer = window.setTimeout(() => optionRefs.current[index]?.focus(), 0)
    return () => window.clearTimeout(focusTimer)
  }, [open, projects.length, selectedIndex])

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open])

  const selectProject = (cwd: string): void => {
    onChange(cwd)
    setOpen(false)
  }

  return (
    <div className="composer-project-picker picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="composer-project-trigger"
        aria-label="新会话项目"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <FolderOpen size={12} className="composer-project-icon" />
        <span className="composer-project-label">项目</span>
        <span className="composer-project-value" title={selectedProject?.cwd}>
          {selectedProject?.name ?? '暂无项目'}
        </span>
        <ChevronDown size={12} className="composer-project-chevron" />
      </button>

      {open && projects.length > 0 && (
        <div className="composer-project-menu picker-menu" role="listbox" aria-label="新会话项目">
          <div className="composer-project-menu-head">选择新会话项目</div>
          {projects.map((project, index) => (
            <button
              ref={(element) => {
                optionRefs.current[index] = element
              }}
              type="button"
              role="option"
              aria-selected={project.cwd === value}
              key={project.cwd}
              className={`composer-project-option${project.cwd === value ? ' selected' : ''}`}
              title={project.cwd}
              onClick={() => selectProject(project.cwd)}
            >
              <FolderOpen size={14} className="composer-project-option-icon" />
              <span className="composer-project-option-copy">
                <strong>{project.name}</strong>
                <small>{project.cwd}</small>
              </span>
              {project.cwd === value && <Check size={14} className="composer-project-option-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
