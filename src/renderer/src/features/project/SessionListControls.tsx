import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDownUp, Check, Filter } from 'lucide-react'

import type { SessionListFilter, SessionListSort } from '../../agent/sessionListView'
export type { SessionListFilter, SessionListSort } from '../../agent/sessionListView'
export interface SessionListControlsProps {
  filter: SessionListFilter
  sort: SessionListSort
  onFilterChange(value: SessionListFilter): void
  onSortChange(value: SessionListSort): void
}
const filters: { value: SessionListFilter; label: string }[] = [
  { value: 'all', label: '全部' }, { value: 'running', label: '运行中' }, { value: 'idle', label: '未运行' }
]
const sorts: { value: SessionListSort; label: string }[] = [
  { value: 'manual', label: '手动排序' }, { value: 'updated-desc', label: '最近更新' },
  { value: 'updated-asc', label: '最早更新' }, { value: 'running-first', label: '运行优先' },
  { value: 'tokens-desc', label: '累计 Token 多到少' }, { value: 'tokens-asc', label: '累计 Token 少到多' }
]
type Menu = 'filter' | 'sort'

/** Controlled display preferences only: opening/choosing never reads or starts a session. */
export function SessionListControls({ filter, sort, onFilterChange, onSortChange }: SessionListControlsProps) {
  const id = useId()
  const triggers = useRef<Partial<Record<Menu, HTMLButtonElement | null>>>({})
  const popup = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const [open, setOpen] = useState<Menu | null>(null)
  const [active, setActive] = useState(0)
  const [placement, setPlacement] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' })
  const options = open === 'filter' ? filters : sorts
  const selected = open === 'filter' ? filter : sort
  const close = (restoreFocus = true) => {
    setOpen(null)
    composing.current = false
    if (restoreFocus && open) triggers.current[open]?.focus({ preventScroll: true })
  }
  const show = (kind: Menu, boundary?: 'first' | 'last') => {
    if (triggers.current[kind]?.matches(':disabled')) return
    const choices = kind === 'filter' ? filters : sorts
    const value = kind === 'filter' ? filter : sort
    const index = boundary === 'first' ? 0 : boundary === 'last' ? choices.length - 1 : choices.findIndex(option => option.value === value)
    setActive(Math.max(0, index))
    setPlacement({ position: 'fixed', visibility: 'hidden' })
    setOpen(kind)
  }
  const choose = (index: number) => {
    if (!open || triggers.current[open]?.matches(':disabled')) return
    if (open === 'filter') {
      const option = filters[index]
      if (option && option.value !== filter) onFilterChange(option.value)
    } else {
      const option = sorts[index]
      if (option && option.value !== sort) onSortChange(option.value)
    }
    close()
  }

  useLayoutEffect(() => {
    if (!open) return
    const button = triggers.current[open], menu = popup.current
    if (!button || !menu) return
    const rect = button.getBoundingClientRect()
    const margin = 8, gap = 4
    const width = Math.min(open === 'sort' ? 236 : 172, Math.max(0, window.innerWidth - margin * 2))
    menu.style.width = `${width}px`
    const desired = Math.min(menu.scrollHeight || (open === 'sort' ? 284 : 114), 340)
    const below = Math.max(0, window.innerHeight - rect.bottom - margin - gap)
    const above = Math.max(0, rect.top - margin - gap)
    const flip = below < desired && above > below
    const maxHeight = Math.min(340, flip ? above : below)
    const height = Math.min(desired, maxHeight)
    setPlacement({
      position: 'fixed', width, maxHeight,
      left: Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(flip ? rect.top - gap - height : rect.bottom + gap, window.innerHeight - height - margin))
    })
    const dismiss = () => { setOpen(null); button.focus({ preventScroll: true }) }
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || menu.contains(event.target) || Object.values(triggers.current).some(trigger => trigger?.contains(event.target as Node))) return
      dismiss()
    }
    const scroll = (event: Event) => {
      if (event.target instanceof Node && menu.contains(event.target)) return
      dismiss()
    }
    const focus = (event: FocusEvent) => {
      if (event.target instanceof Node && (menu.contains(event.target) || button.contains(event.target))) return
      setOpen(null)
    }
    const blur = () => setOpen(null)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', blur)
    window.addEventListener('scroll', scroll, true)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', focus)
    return () => {
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', blur)
      window.removeEventListener('scroll', scroll, true)
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', focus)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open || !popup.current) return
    const menu = popup.current
    const row = menu.querySelector<HTMLButtonElement>(`[data-index="${active}"]`)
    row?.focus({ preventScroll: true })
    if (!row) return
    const menuRect = menu.getBoundingClientRect(), rowRect = row.getBoundingClientRect()
    // Scroll only the popup, never its host conversation/project panel.
    if (rowRect.top < menuRect.top) menu.scrollTop -= menuRect.top - rowRect.top
    else if (rowRect.bottom > menuRect.bottom) menu.scrollTop += rowRect.bottom - menuRect.bottom
  }, [open, active, placement])

  const menuKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return
    if (event.key === 'Tab') { close(); return } // Restore source tab order without trapping focus.
    if (!['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') close()
    else if (event.key === 'Enter' || event.key === ' ') choose(active)
    else if (event.key === 'Home') setActive(0)
    else if (event.key === 'End') setActive(options.length - 1)
    else setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
  }

  return <div className="session-list-controls">
    {(['filter', 'sort'] as const).map(kind => {
      const label = kind === 'filter' ? '筛选会话' : '排序会话'
      const Icon = kind === 'filter' ? Filter : ArrowDownUp
      const valueLabel = kind === 'filter' ? filters.find(option => option.value === filter)?.label : sorts.find(option => option.value === sort)?.label
      return <button key={kind} ref={node => { triggers.current[kind] = node }} type="button"
        className="icon-button session-list-control" aria-label={label} title={`${label}：${valueLabel}`}
        aria-haspopup="menu" aria-expanded={open === kind} aria-controls={open === kind ? `${id}-${kind}` : undefined}
        data-active={kind === 'filter' ? filter !== 'all' : sort !== 'manual'}
        onPointerDown={event => { if (event.button === 0) event.preventDefault(); event.stopPropagation() }}
        onClick={event => { event.stopPropagation(); if (open === kind) close(); else show(kind) }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation()
            show(kind, event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : undefined)
          }
        }}><Icon size={14} aria-hidden="true" /></button>
    })}
    {open && createPortal(<div ref={popup} id={`${id}-${open}`} role="menu"
      aria-label={open === 'filter' ? '筛选会话' : '排序会话'}
      aria-describedby={open === 'sort' ? `${id}-tokens-note` : undefined}
      className="session-list-menu" style={placement} onKeyDown={menuKeyDown}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
      onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
      onWheel={event => event.stopPropagation()} onTouchMove={event => event.stopPropagation()}>
      {options.map((option, index) => <button key={option.value} type="button" role="menuitemradio"
        aria-checked={option.value === selected} tabIndex={-1} data-index={index} data-active={index === active}
        className="session-list-menu-option" onClick={() => choose(index)} onFocus={() => setActive(index)}>
        <span className="session-list-menu-check" aria-hidden="true">{option.value === selected && <Check size={14} />}</span>
        <span>{option.label}</span>
      </button>)}
      {open === 'sort' && <p id={`${id}-tokens-note`} className="session-list-menu-note">Token 为已落盘记录累计；未知值排后，不等于 0。</p>}
    </div>, document.body)}
  </div>
}
