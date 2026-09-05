import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import { GitBranch, Loader2, X } from 'lucide-react'

interface BranchCreateModalProps {
  open: boolean
  projectName: string
  projectCwd: string
  onClose: () => void
  onSubmit: (name: string) => Promise<void>
}

/** Native window.prompt is unavailable in Electron; keep branch creation in-app. */
export function BranchCreateModal({
  open,
  projectName,
  projectCwd,
  onClose,
  onSubmit
}: BranchCreateModalProps): ReactElement | null {
  const [name, setName] = useState('feature/new-branch')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    submittingRef.current = submitting
  }, [submitting])

  useEffect(() => {
    if (!open) return
    setName('feature/new-branch')
    setError('')
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !submittingRef.current) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError('分支名称不能为空')
      inputRef.current?.focus()
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await onSubmit(trimmed)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="modal-backdrop branch-create-backdrop"
      onClick={() => {
        if (!submitting) onClose()
      }}
    >
      <form
        className="modal branch-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="branch-create-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => void submit(event)}
      >
        <header className="modal-head branch-create-head">
          <div>
            <div className="modal-kicker">PION GIT</div>
            <h2 id="branch-create-title">新建 Git 分支</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            title="关闭"
            aria-label="关闭"
            disabled={submitting}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        <div className="modal-body branch-create-body">
          <p className="branch-create-description">
            在项目 <strong>{projectName}</strong> 中创建独立的 worktree 分支。
          </p>
          <div className="branch-create-path" title={projectCwd}>{projectCwd}</div>
          <label className="branch-create-field" htmlFor="branch-create-name">
            <span>分支名称</span>
            <input
              ref={inputRef}
              id="branch-create-name"
              className="branch-create-input"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                if (error) setError('')
              }}
              placeholder="feature/my-branch"
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
            />
          </label>
          <p className="branch-create-hint">支持 feature/...、fix/... 等 Git 分支名称。</p>
          {error && <p className="branch-create-error" role="alert">{error}</p>}
        </div>

        <footer className="branch-create-actions">
          <button
            type="button"
            className="ghost-button branch-create-cancel"
            disabled={submitting}
            onClick={onClose}
          >
            取消
          </button>
          <button type="submit" className="branch-create-submit" disabled={submitting || !name.trim()}>
            {submitting ? <Loader2 size={13} className="spin" /> : <GitBranch size={13} />}
            {submitting ? '创建中…' : '创建分支'}
          </button>
        </footer>
      </form>
    </div>
  )
}
