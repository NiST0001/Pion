// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { SessionListControls } from '../../src/renderer/src/features/project/SessionListControls'
import type { SessionListControlsProps } from '../../src/renderer/src/features/project/SessionListControls'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
function setup(extra: Partial<SessionListControlsProps> = {}) {
  const props: SessionListControlsProps = { filter: 'all', sort: 'manual', onFilterChange: vi.fn(), onSortChange: vi.fn(), ...extra }
  return { ...render(<SessionListControls {...props} />), props,
    filter: screen.getByRole('button', { name: '筛选会话' }), sort: screen.getByRole('button', { name: '排序会话' }) }
}

it('opens a single body-portal radio menu with controlled selections and no persistence', () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem')
  const { filter, sort, container, props, rerender } = setup({ filter: 'running', sort: 'tokens-desc' })
  fireEvent.click(filter)
  const menu = screen.getByRole('menu', { name: '筛选会话' })
  expect(menu.parentElement).toBe(document.body)
  expect(container).not.toContainElement(menu)
  expect(menu).toHaveStyle({ position: 'fixed' })
  expect(filter).toHaveAttribute('aria-haspopup', 'menu')
  expect(filter).toHaveAttribute('aria-controls', menu.id)
  expect(filter).toHaveAttribute('aria-expanded', 'true')
  expect(within(menu).getByRole('menuitemradio', { name: '运行中' })).toHaveAttribute('aria-checked', 'true')
  expect(screen.getByRole('menuitemradio', { name: '运行中' })).toHaveFocus()
  fireEvent.click(sort)
  expect(screen.getAllByRole('menu')).toHaveLength(1)
  expect(filter).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByRole('menuitemradio', { name: '累计 Token 多到少' })).toHaveAttribute('aria-checked', 'true')
  expect(screen.getByText('Token 为已落盘记录累计；未知值排后，不等于 0。')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('menuitemradio', { name: '累计 Token 少到多' }))
  expect(props.onSortChange).toHaveBeenCalledExactlyOnceWith('tokens-asc')
  expect(props.onFilterChange).not.toHaveBeenCalled()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(sort).toHaveFocus()
  rerender(<SessionListControls {...props} sort="tokens-asc" />)
  fireEvent.click(sort)
  expect(screen.getByRole('menuitemradio', { name: '累计 Token 少到多' })).toHaveAttribute('aria-checked', 'true')
  expect(storage).not.toHaveBeenCalled()
})

it('supports wrapping arrows, Home/End, keyboard commit and Escape without changing on navigation', () => {
  const { filter, props } = setup()
  act(() => filter.focus())
  fireEvent.keyDown(filter, { key: 'ArrowDown' })
  expect(screen.getByRole('menuitemradio', { name: '全部' })).toHaveFocus()
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
  expect(screen.getByRole('menuitemradio', { name: '未运行' })).toHaveFocus()
  fireEvent.keyDown(document.activeElement!, { key: 'Home' })
  expect(screen.getByRole('menuitemradio', { name: '全部' })).toHaveFocus()
  fireEvent.keyDown(document.activeElement!, { key: 'End' })
  expect(screen.getByRole('menuitemradio', { name: '未运行' })).toHaveFocus()
  expect(props.onFilterChange).not.toHaveBeenCalled()
  fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
  expect(props.onFilterChange).toHaveBeenCalledExactlyOnceWith('idle')
  expect(filter).toHaveFocus()
  fireEvent.click(filter)
  const parentEscape = vi.fn()
  window.addEventListener('keydown', parentEscape)
  try {
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(parentEscape).not.toHaveBeenCalled()
  } finally { window.removeEventListener('keydown', parentEscape) }
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(filter).toHaveFocus()
})

it('allows Tab, closes on outside pointer, resize and host scroll but not menu scroll', () => {
  const { filter } = setup()
  fireEvent.click(filter)
  expect(fireEvent.keyDown(document.activeElement!, { key: 'Tab' })).toBe(true)
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(filter).toHaveFocus()
  fireEvent.click(filter)
  fireEvent.scroll(screen.getByRole('menu'))
  expect(screen.getByRole('menu')).toBeInTheDocument()
  fireEvent.scroll(window)
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  fireEvent.click(filter)
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(filter).toHaveFocus()
  fireEvent.click(filter)
  fireEvent.resize(window)
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})

it('keeps same-value selections silent and ignores composing keyboard events', () => {
  const { filter, props } = setup()
  fireEvent.click(filter)
  fireEvent.compositionStart(screen.getByRole('menu'))
  fireEvent.keyDown(document.activeElement!, { key: 'End', isComposing: true })
  fireEvent.keyDown(document.activeElement!, { key: 'Escape', isComposing: true })
  expect(screen.getByRole('menuitemradio', { name: '全部' })).toHaveFocus()
  fireEvent.compositionEnd(screen.getByRole('menu'))
  fireEvent.keyDown(document.activeElement!, { key: ' ' })
  expect(props.onFilterChange).not.toHaveBeenCalled()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})

it('clamps and flips a menu above a near-bottom trigger and removes active listeners on unmount', () => {
  const { sort, unmount } = setup()
  vi.spyOn(sort, 'getBoundingClientRect').mockReturnValue({ left: 980, right: 1008, top: 710, bottom: 736, width: 28, height: 26, x: 980, y: 710, toJSON: () => ({}) })
  const removeWindow = vi.spyOn(window, 'removeEventListener')
  const removeDocument = vi.spyOn(document, 'removeEventListener')
  fireEvent.click(sort)
  const menu = screen.getByRole('menu')
  const left = parseFloat(menu.style.left), top = parseFloat(menu.style.top)
  expect(left).toBeGreaterThanOrEqual(8)
  expect(left + parseFloat(menu.style.width)).toBeLessThanOrEqual(window.innerWidth - 8)
  expect(top).toBeLessThan(710)
  expect(top).toBeGreaterThanOrEqual(8)
  unmount()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(removeWindow).toHaveBeenCalledWith('resize', expect.any(Function))
  expect(removeWindow).toHaveBeenCalledWith('scroll', expect.any(Function), true)
  expect(removeDocument).toHaveBeenCalledWith('pointerdown', expect.any(Function), true)
  expect(removeDocument).toHaveBeenCalledWith('focusin', expect.any(Function))
})

it('preserves non-shrinking capsule buttons, theme and forced-colors contracts in styles', () => {
  const css = readFileSync('src/renderer/src/styles/session-list-controls.css', 'utf8')
  expect(css).toContain('flex: 0 0 28px')
  expect(css).toContain('min-width: 28px')
  expect(css).toContain('border-radius: 999px')
  expect(css).toContain('overscroll-behavior: contain')
  expect(css).toContain('var(--bg-elev)')
  expect(css).toContain('pion-keyboard-focus')
  expect(css).toContain('@media (forced-colors: active)')
})
