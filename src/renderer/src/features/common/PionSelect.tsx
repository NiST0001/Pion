import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'

export interface PionSelectOption {
  value: string
  label: string
  group?: string
  disabled?: boolean
}

interface PionSelectProps {
  value: string
  options: PionSelectOption[]
  onValueChange(value: string): void
  disabled?: boolean
  ariaLabel: string
  className?: string
  children?: ReactNode
  id?: string
}

/** A single-select listbox. Only its trigger participates in the tab order. */
export function PionSelect({ value, options, onValueChange, disabled = false, ariaLabel, className, children, id }: PionSelectProps) {
  const generatedId = useId()
  const listId = `${generatedId}-listbox`
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const search = useRef({ text: '', time: 0 })
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [placement, setPlacement] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' })
  const selected = options.findIndex(option => option.value === value)
  const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0)
  const activeIndex = enabled.includes(active) ? active : (enabled.includes(selected) ? selected : (enabled[0] ?? -1))

  const unavailable = () => disabled || !trigger.current || trigger.current.matches(':disabled')
  const close = () => { setOpen(false); search.current = { text: '', time: 0 } }
  const show = (index = enabled.includes(selected) ? selected : (enabled[0] ?? -1)) => {
    if (unavailable()) return
    setPlacement({ position: 'fixed', visibility: 'hidden' })
    setActive(index)
    setOpen(true)
  }
  const choose = (index: number) => {
    if (unavailable() || !options[index] || options[index].disabled) return
    close()
    if (options[index].value !== value) onValueChange(options[index].value)
  }

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useLayoutEffect(() => {
    if (!open) return
    const button = trigger.current
    const menu = popup.current
    if (!button || !menu) return
    const position = () => {
      if (button.matches(':disabled') || !button.isConnected) { setOpen(false); return }
      const rect = button.getBoundingClientRect()
      const margin = 8, gap = 4
      const width = Math.min(Math.max(rect.width, 180), Math.max(0, window.innerWidth - margin * 2))
      const below = Math.max(0, window.innerHeight - rect.bottom - gap - margin)
      const above = Math.max(0, rect.top - gap - margin)
      // Measure wrapping at the actual clamped width, including on the first layout.
      menu.style.width = `${width}px`
      const desired = Math.min(menu.scrollHeight || 280, 320)
      const flip = below < desired && above > below
      const maxHeight = Math.min(320, flip ? above : below)
      const height = Math.min(desired, maxHeight)
      setPlacement({
        position: 'fixed', width, maxHeight,
        left: Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin)),
        top: Math.max(margin, Math.min(flip ? rect.top - gap - height : rect.bottom + gap, window.innerHeight - height - margin))
      })
    }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !button.contains(event.target) && !menu.contains(event.target)) setOpen(false)
    }
    const scrolled = (event: Event) => {
      // Never call scrollIntoView: it can move the settings page or conversation.
      if (event.target instanceof Node && menu.contains(event.target)) return
      setOpen(false)
    }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || composing.current || event.keyCode === 229) return
      // Settings listens on window in the bubble phase; consume only an open menu's Escape.
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
    const focus = (event: FocusEvent) => { if (event.target !== button) setOpen(false) }
    const windowBlur = () => setOpen(false)
    position()
    window.addEventListener('resize', position)
    window.addEventListener('blur', windowBlur)
    document.addEventListener('scroll', scrolled, true)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', focus)
    window.addEventListener('keydown', escape, true)
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(position)
    resize?.observe(button)
    resize?.observe(menu)
    const mutations = new MutationObserver(() => { if (button.matches(':disabled')) setOpen(false) })
    // Native fieldset inheritance (including its first-legend exception) is authoritative.
    for (let ancestor: HTMLElement | null = button; ancestor; ancestor = ancestor.parentElement) {
      mutations.observe(ancestor, { attributes: true, attributeFilter: ['disabled'] })
    }
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('blur', windowBlur)
      document.removeEventListener('scroll', scrolled, true)
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', focus)
      window.removeEventListener('keydown', escape, true)
      resize?.disconnect()
      mutations.disconnect()
      search.current = { text: '', time: 0 }
    }
  }, [open, options])

  useLayoutEffect(() => {
    if (!open || !popup.current || activeIndex < 0) return
    const menu = popup.current
    const row = menu.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`)
    if (!row) return
    const menuRect = menu.getBoundingClientRect(), rowRect = row.getBoundingClientRect()
    if (rowRect.top < menuRect.top) menu.scrollTop -= menuRect.top - rowRect.top
    else if (rowRect.bottom > menuRect.bottom) menu.scrollTop += rowRect.bottom - menuRect.bottom
  }, [open, activeIndex, placement])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (unavailable() || event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return
    const key = event.key
    if (key === 'Tab') { close(); return }
    if (key === 'Escape') {
      if (open) { event.preventDefault(); event.stopPropagation(); close() }
      return
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(key)) {
      event.preventDefault()
      event.stopPropagation()
      if (key === 'Enter' || key === ' ') { if (open) choose(activeIndex); else show(); return }
      if (key === 'Home' || key === 'End') {
        const index = key === 'Home' ? enabled[0] : enabled[enabled.length - 1]
        if (open) setActive(index ?? -1); else show(index ?? -1)
        return
      }
      if (!open) { show(); return }
      const current = enabled.indexOf(activeIndex)
      setActive(enabled[(current + (key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length] ?? -1)
      return
    }
    if (key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return
    event.preventDefault()
    event.stopPropagation()
    const now = performance.now()
    const text = (now - search.current.time < 700 ? search.current.text : '') + key.toLocaleLowerCase()
    search.current = { text, time: now }
    const prefix = [...text].every(character => character === text[0]) ? text[0] : text
    const current = open ? activeIndex : selected
    const start = prefix.length === 1 ? current + 1 : current
    for (let offset = 0; offset < options.length; offset++) {
      const index = (Math.max(0, start) + offset) % options.length
      if (!options[index].disabled && options[index].label.toLocaleLowerCase().startsWith(prefix)) {
        if (open) setActive(index); else show(index)
        break
      }
    }
  }

  // Preserve source order and its contiguous group runs (do not reorder keyboard indices).
  const runs: { group?: string; start: number; indices: number[] }[] = []
  options.forEach((option, index) => {
    const last = runs[runs.length - 1]
    if (last && last.group === option.group) last.indices.push(index)
    else runs.push({ group: option.group, start: index, indices: [index] })
  })
  const renderOption = (index: number) => {
    const option = options[index]
    return <div key={index} id={`${listId}-option-${index}`} role="option"
      aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
      data-option-index={index} data-active={index === activeIndex} className="pion-select-option"
      onPointerMove={() => { if (!option.disabled) setActive(index) }}
      onClick={event => { event.preventDefault(); event.stopPropagation(); choose(index) }}>
      <span className="pion-select-check" aria-hidden="true">{option.value === value && <Check size={14} />}</span>
      <span className="pion-select-option-label">{option.label}</span>
    </div>
  }

  return <>
    <button ref={trigger} id={id} type="button" role="combobox" aria-label={ariaLabel}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
      aria-activedescendant={open && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined}
      disabled={disabled} className={`pion-select pion-select-trigger${className ? ` ${className}` : ''}`}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
      onKeyDown={onKeyDown} onBlur={close}
      onPointerDown={event => {
        if (event.button !== 0 || unavailable()) return
        event.preventDefault()
        event.stopPropagation()
        trigger.current?.focus({ preventScroll: true })
      }}
      onClick={event => {
        event.preventDefault()
        event.stopPropagation()
        if (unavailable()) return
        if (open) close(); else show()
      }}>
      {children ?? <span className="pion-select-value">{options[selected]?.label ?? value}</span>}
      <ChevronDown size={14} className="pion-select-chevron" aria-hidden="true" />
    </button>
    {open && !disabled && createPortal(<div ref={popup} id={listId} role="listbox" aria-label={ariaLabel}
      className="pion-select-popup" style={placement}
      onPointerDown={event => {
        if (event.target instanceof Element && event.target.closest('[role="option"]')) event.preventDefault()
        event.stopPropagation()
      }}
      onMouseDown={event => {
        if (event.target instanceof Element && event.target.closest('[role="option"]')) event.preventDefault()
        event.stopPropagation()
      }}
      onClick={event => { event.preventDefault(); event.stopPropagation() }}
      onWheel={event => event.stopPropagation()} onTouchMove={event => event.stopPropagation()}>
      {runs.map(run => run.group ? <div key={run.start} role="group" aria-labelledby={`${listId}-group-${run.start}`}>
        <div id={`${listId}-group-${run.start}`} className="pion-select-group">{run.group}</div>
        {run.indices.map(renderOption)}
      </div> : run.indices.map(renderOption))}
    </div>, document.body)}
  </>
}
