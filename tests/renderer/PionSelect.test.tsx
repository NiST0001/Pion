// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { PionSelect } from '../../src/renderer/src/features/common/PionSelect'
import type { PionSelectOption } from '../../src/renderer/src/features/common/PionSelect'

const options: PionSelectOption[] = [
  { value: 'a', label: 'Alpha', group: 'First' },
  { value: 'b', label: 'Beta', group: 'First', disabled: true },
  { value: 'c', label: 'Charlie', group: 'Second' },
  { value: 'd', label: 'Delta', group: 'Second' }
]
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function setup(extra: Partial<Parameters<typeof PionSelect>[0]> = {}) {
  const change = vi.fn()
  const props = { value: 'a', options, ariaLabel: 'Choice', onValueChange: change, ...extra }
  const rendered = render(<PionSelect {...props} />)
  const button = screen.getByRole('combobox', { name: 'Choice' })
  return { ...rendered, button, change, props }
}
function open(button: HTMLElement) {
  fireEvent.pointerDown(button, { button: 0 })
  // PointerEvent availability differs across jsdom releases; keyboard focus is explicit here.
  act(() => button.focus({ preventScroll: true }))
  fireEvent.click(button)
}
function active(button: HTMLElement) { return document.getElementById(button.getAttribute('aria-activedescendant')!) }

it('renders a themed body portal with real options, group labels and no native select', () => {
  const { button, container, change } = setup({ id: 'choice', className: 'compact' })
  expect(button).toHaveTextContent('Alpha')
  expect(button).toHaveAttribute('id', 'choice')
  expect(button).toHaveClass('pion-select', 'compact')
  expect(button).toHaveAttribute('aria-expanded', 'false')
  open(button)
  const list = screen.getByRole('listbox', { name: 'Choice' })
  expect(list.parentElement).toBe(document.body)
  expect(container).not.toContainElement(list)
  expect(button).toHaveAttribute('aria-controls', list.id)
  expect(button).toHaveAttribute('aria-expanded', 'true')
  expect(within(list).getByRole('group', { name: 'First' })).toBeInTheDocument()
  expect(within(list).getByRole('group', { name: 'Second' })).toBeInTheDocument()
  expect(screen.getByRole('option', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('option', { name: 'Beta' })).toHaveAttribute('aria-disabled', 'true')
  expect(document.querySelector('select')).toBeNull()
  expect(list.querySelector('[tabindex]')).toBeNull()
  expect(fireEvent.pointerDown(list)).toBe(true) // scrollbar/background keeps its native scrolling default
  expect(fireEvent.mouseDown(list)).toBe(true)
  fireEvent.click(screen.getByRole('option', { name: 'Beta' }))
  expect(change).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('option', { name: 'Charlie' }))
  expect(change).toHaveBeenCalledExactlyOnceWith('c')
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(button).toHaveFocus()
})

it('navigates without committing, skips disabled options, supports boundaries and commits only once', () => {
  const { button, change } = setup()
  act(() => button.focus())
  fireEvent.keyDown(button, { key: 'ArrowDown' })
  expect(active(button)).toHaveTextContent('Alpha')
  fireEvent.keyDown(button, { key: 'ArrowDown' })
  expect(active(button)).toHaveTextContent('Charlie')
  fireEvent.keyDown(button, { key: 'ArrowUp' })
  expect(active(button)).toHaveTextContent('Alpha')
  fireEvent.keyDown(button, { key: 'End' })
  expect(active(button)).toHaveTextContent('Delta')
  fireEvent.keyDown(button, { key: 'Home' })
  expect(active(button)).toHaveTextContent('Alpha')
  expect(change).not.toHaveBeenCalled()
  fireEvent.keyDown(button, { key: 'ArrowUp' })
  expect(active(button)).toHaveTextContent('Delta')
  fireEvent.keyDown(button, { key: 'Enter' })
  expect(change).toHaveBeenCalledExactlyOnceWith('d')
  fireEvent.keyDown(button, { key: ' ' })
  expect(screen.getByRole('listbox')).toBeInTheDocument()
  fireEvent.keyDown(button, { key: ' ' })
  expect(change).toHaveBeenCalledTimes(1) // same controlled value does not emit a change
})

it('supports typeahead and repeated-letter cycling while ignoring IME and shortcuts', () => {
  const { button } = setup({ options: [
    { value: 'a', label: 'Alpha' }, { value: 'b', label: 'Alpine', disabled: true },
    { value: 'c', label: 'Amber' }, { value: 'd', label: 'Delta' }
  ] })
  open(button)
  fireEvent.keyDown(button, { key: 'a' })
  expect(active(button)).toHaveTextContent('Amber')
  fireEvent.keyDown(button, { key: 'a' })
  expect(active(button)).toHaveTextContent('Alpha')
  fireEvent.keyDown(button, { key: 'd', ctrlKey: true })
  expect(active(button)).toHaveTextContent('Alpha')
  fireEvent.compositionStart(button)
  fireEvent.keyDown(button, { key: 'End' })
  fireEvent.keyDown(button, { key: 'Enter', isComposing: true })
  expect(active(button)).toHaveTextContent('Alpha')
  expect(button).toHaveAttribute('aria-expanded', 'true')
  fireEvent.compositionEnd(button)
  fireEvent.keyDown(button, { key: 'End' })
  expect(active(button)).toHaveTextContent('Delta')
})

it('matches multi-character typeahead prefixes and respects the first-legend fieldset exception', () => {
  render(<fieldset disabled><legend><PionSelect value="d" options={options} ariaLabel="Choice" onValueChange={vi.fn()} /></legend></fieldset>)
  const button = screen.getByRole('combobox')
  open(button)
  expect(screen.getByRole('listbox')).toBeInTheDocument()
  fireEvent.keyDown(button, { key: 'c' })
  fireEvent.keyDown(button, { key: 'h' })
  expect(active(button)).toHaveTextContent('Charlie')
  fireEvent.keyDown(button, { key: 'Escape', isComposing: true })
  expect(screen.getByRole('listbox')).toBeInTheDocument()
})

it('consumes an open menu Escape before the settings window bubble listener, but not a closed one', () => {
  const { button } = setup()
  const settingsEscape = vi.fn()
  window.addEventListener('keydown', settingsEscape)
  try {
    open(button)
    fireEvent.keyDown(button, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(settingsEscape).not.toHaveBeenCalled()
    fireEvent.keyDown(button, { key: 'Escape' })
    expect(settingsEscape).toHaveBeenCalledTimes(1)
  } finally { window.removeEventListener('keydown', settingsEscape) }
})

it('lets Tab move normally and closes on outside pointer, blur, explicit disable and unmount', () => {
  const { button, rerender, props, unmount } = setup()
  open(button)
  expect(fireEvent.keyDown(button, { key: 'Tab' })).toBe(true)
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  open(button)
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  open(button)
  fireEvent.blur(button)
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  open(button)
  rerender(<PionSelect {...props} disabled />)
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  fireEvent.click(button)
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  rerender(<PionSelect {...props} />)
  open(button)
  unmount()
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  fireEvent.keyDown(window, { key: 'Escape' }) // listeners removed
})

it('honors inherited fieldset disabling and closes if its fieldset becomes disabled', async () => {
  const change = vi.fn()
  const { rerender } = render(<fieldset disabled><PionSelect value="a" options={options} ariaLabel="Choice" onValueChange={change} /></fieldset>)
  const button = screen.getByRole('combobox')
  fireEvent.click(button)
  fireEvent.keyDown(button, { key: 'Enter' })
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  rerender(<fieldset><PionSelect value="a" options={options} ariaLabel="Choice" onValueChange={change} /></fieldset>)
  open(button)
  await act(async () => { button.closest('fieldset')!.disabled = true })
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(change).not.toHaveBeenCalled()
})

it('does not double-toggle or submit inside a wrapping label/form, and never focuses portal options', () => {
  const submit = vi.fn(), change = vi.fn()
  render(<form onSubmit={submit}><label>Label<PionSelect value="a" options={options} ariaLabel="Choice" onValueChange={change} /></label></form>)
  const button = screen.getByRole('combobox')
  open(button)
  const row = screen.getByRole('option', { name: 'Charlie' })
  expect(fireEvent.pointerDown(row)).toBe(false)
  expect(fireEvent.mouseDown(row)).toBe(false)
  fireEvent.click(row)
  expect(change).toHaveBeenCalledExactlyOnceWith('c')
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(button).toHaveFocus()
  expect(submit).not.toHaveBeenCalled()
})

it('clamps and flips fixed popup geometry, updates on resize, closes on ancestor scroll only', () => {
  const { button } = setup()
  vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ left: 950, right: 1050, top: 700, bottom: 730, width: 100, height: 30, x: 950, y: 700, toJSON: () => ({}) })
  vi.stubGlobal('innerWidth', 1000)
  vi.stubGlobal('innerHeight', 760)
  open(button)
  const list = screen.getByRole('listbox')
  expect(list.style.position).toBe('fixed')
  expect(list.style.left).toBe('812px')
  expect(Number.parseFloat(list.style.top)).toBeLessThan(700)
  fireEvent.scroll(list)
  expect(screen.getByRole('listbox')).toBe(list)
  fireEvent.resize(window)
  expect(screen.getByRole('listbox')).toBe(list)
  fireEvent.scroll(button.parentElement!)
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
})

it('scrolls only menu.scrollTop to reveal the active row, never scrollIntoView or an ancestor', () => {
  const { button, container } = setup()
  open(button)
  const list = screen.getByRole('listbox')
  const row = screen.getByRole('option', { name: 'Delta' })
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ top: 10, bottom: 100 } as DOMRect)
  vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ top: 110, bottom: 140 } as DOMRect)
  container.scrollTop = 17
  fireEvent.keyDown(button, { key: 'End' })
  expect(list.scrollTop).toBe(40)
  expect(container.scrollTop).toBe(17)
})

it('handles unknown values, no enabled options and live option replacement safely', () => {
  const { button, rerender, props, change } = setup({ value: 'unknown', options: [{ value: 'x', label: 'Unavailable', disabled: true }] })
  expect(button).toHaveTextContent('unknown')
  open(button)
  expect(button).not.toHaveAttribute('aria-activedescendant')
  fireEvent.keyDown(button, { key: 'ArrowDown' })
  fireEvent.keyDown(button, { key: 'Enter' })
  expect(change).not.toHaveBeenCalled()
  rerender(<PionSelect {...props} options={options} />)
  fireEvent.keyDown(button, { key: 'End' })
  expect(active(button)).toHaveTextContent('Delta')
  rerender(<PionSelect {...props} options={[]} />)
  expect(button).not.toHaveAttribute('aria-activedescendant')
})

it('keeps shared corners, keyboard-only focus, neutral signal-orange and accessibility fallbacks', () => {
  const css = readFileSync('src/renderer/src/styles/pion-select.css', 'utf8')
  expect(css).toContain('var(--radius-sm)')
  expect(css).toContain('var(--radius)')
  expect(css).toContain('html.pion-keyboard-focus .pion-select:focus-visible')
  expect(css).toContain("data-theme='division-dark'")
  expect(css).toContain('border-color: transparent; box-shadow: none')
  expect(css).toContain('background: var(--selected-bg)')
  expect(css).toContain('overscroll-behavior: contain')
  expect(css).toContain('prefers-reduced-motion: reduce')
  expect(css).toContain('forced-colors: active')
  expect(css).toContain('outline-color: Highlight')
})
