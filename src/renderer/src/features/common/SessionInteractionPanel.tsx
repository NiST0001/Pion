import { useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { AnimatedDisclosure } from './AnimatedDisclosure'

/** Session-owned interaction: hiding or folding it never resolves the request. */
export function SessionInteractionPanel({
  active,
  backdropClassName,
  className,
  icon,
  label,
  title,
  meta,
  children
}: {
  active: boolean
  backdropClassName: string
  className: string
  icon: ReactNode
  label: string
  title: string
  meta?: ReactNode
  children: ReactNode
}): ReactElement {
  const titleId = useId()
  const bodyId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const [expanded, setExpanded] = useState(true)

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!expanded || event.key !== 'Escape' || event.defaultPrevented || event.repeat ||
      event.nativeEvent.isComposing || event.keyCode === 229 ||
      !event.currentTarget.contains(document.activeElement) ||
      document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')) return
    event.preventDefault()
    event.stopPropagation()
    setExpanded(false)
    toggleRef.current?.focus({ preventScroll: true })
  }

  return (
    <div className={backdropClassName} hidden={!active} inert={!active}>
      <section
        className={`${className} session-interaction-panel`}
        role="region"
        aria-labelledby={titleId}
        onKeyDown={active ? onKeyDown : undefined}
      >
        <button
          ref={toggleRef}
          type="button"
          className="session-interaction-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          disabled={!active}
          title={expanded ? '收起' : '展开'}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="session-interaction-icon" aria-hidden="true">{icon}</span>
          <span className="session-interaction-copy">
            <span className="session-interaction-label" title={label}>{label}</span>
            <strong id={titleId} className="session-interaction-title" title={title}>{title}</strong>
          </span>
          {meta && <span className="session-interaction-meta">{meta}</span>}
          <ChevronDown className="session-interaction-chevron" size={14} aria-hidden="true" />
        </button>
        <div id={bodyId}>
          <AnimatedDisclosure open={expanded} retainContent>
            <div className="session-interaction-content">{children}</div>
          </AnimatedDisclosure>
        </div>
      </section>
    </div>
  )
}
