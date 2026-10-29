// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { ModelPicker, ThinkingPicker } from '../../src/renderer/src/features/settings/ModelPicker'
import type { ModelOption } from '../../src/shared/types'

const models: ModelOption[] = [
  { provider: 'alpha/beta', id: 'shared', name: 'Friendly name', reasoning: true, contextWindow: 128000 },
  { provider: 'alpha', id: 'beta/shared', contextWindow: 64000 },
  { provider: 'alpha', id: 'shared' },
  { provider: 'alpha/beta', id: 'tail', contextWindow: 0 },
  { provider: '__proto__', id: 'constructor' }
]

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function open(button: HTMLElement) {
  act(() => button.focus({ preventScroll: true }))
  fireEvent.click(button)
}

it('uses the shared portal and preserves provider groups, precise selection and model decorations', () => {
  const onSelect = vi.fn()
  const { container, rerender } = render(<ModelPicker models={models} currentProvider="alpha" currentModelId="shared" onSelect={onSelect} compact />)
  const button = screen.getByRole('combobox', { name: '切换模型' })
  expect(button).toHaveClass('pion-select', 'picker-trigger')
  expect(button.closest('.picker')).toHaveClass('picker-compact')
  expect(button).toHaveTextContent('shared')
  expect(button).toHaveAttribute('title', 'alpha/shared')
  open(button)
  fireEvent.click(within(screen.getByRole('group', { name: 'alpha' })).getByRole('option', { name: 'shared' }))
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('alpha', 'shared')
  onSelect.mockClear()
  open(button)
  const list = screen.getByRole('listbox', { name: '切换模型' })
  expect(list).toHaveClass('pion-select-popup', 'model-picker-popup')
  expect(list.parentElement).toBe(document.body)
  expect(container).not.toContainElement(list)
  expect(within(list).getAllByRole('group').map(group => group.firstElementChild?.textContent))
    .toEqual(['alpha/beta', 'alpha', '__proto__'])
  const firstGroup = within(list).getByRole('group', { name: 'alpha/beta' })
  const secondGroup = within(list).getByRole('group', { name: 'alpha' })
  const reasoning = within(firstGroup).getByRole('option', { name: 'shared' })
  expect(reasoning).toHaveAttribute('title', 'alpha/beta/shared')
  expect(reasoning.querySelector('.picker-reasoning')).toHaveAttribute('aria-hidden', 'true')
  expect(reasoning).toHaveTextContent('128k')
  expect(within(firstGroup).getByRole('option', { name: 'tail' })).toHaveTextContent('0k')
  expect(within(secondGroup).getByRole('option', { name: 'shared' }).querySelector('.picker-option-meta')).toBeNull()
  expect(within(list).getAllByRole('option', { selected: true })).toEqual([within(secondGroup).getByRole('option', { name: 'shared' })])
  expect(screen.queryByText('Friendly name')).not.toBeInTheDocument()

  fireEvent.click(reasoning)
  expect(onSelect).toHaveBeenLastCalledWith('alpha/beta', 'shared')
  expect(button).toHaveFocus()
  rerender(<ModelPicker models={models} currentProvider="alpha/beta" currentModelId="shared" onSelect={onSelect} compact />)
  open(button)
  fireEvent.click(within(screen.getByRole('group', { name: 'alpha' })).getByRole('option', { name: 'beta/shared' }))
  expect(onSelect).toHaveBeenLastCalledWith('alpha', 'beta/shared')
  expect(onSelect).toHaveBeenCalledTimes(2) // These two pairs share the same slash-joined title.
})

it('keeps model navigation uncommitted until Enter and emits the exact provider/id', () => {
  const onSelect = vi.fn()
  render(<ModelPicker models={models} currentProvider="alpha" currentModelId="shared" onSelect={onSelect} />)
  const button = screen.getByRole('combobox')
  act(() => button.focus())
  fireEvent.keyDown(button, { key: 'Home' })
  expect(document.getElementById(button.getAttribute('aria-activedescendant')!)).toHaveAccessibleName('shared')
  fireEvent.keyDown(button, { key: 'ArrowDown' })
  expect(document.getElementById(button.getAttribute('aria-activedescendant')!)).toHaveAccessibleName('tail')
  expect(onSelect).not.toHaveBeenCalled()
  fireEvent.keyDown(button, { key: 'Enter' })
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('alpha/beta', 'tail')
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(button).toHaveFocus()
})

it('preserves an open model menu and multi-character typeahead across unrelated parent updates', () => {
  const choices = ['alpha', 'delta', 'echo', 'dog'].map(id => ({ provider: 'p', id }))
  const onSelect = vi.fn()
  const { rerender } = render(<ModelPicker models={choices} currentProvider="p" currentModelId="dog" onSelect={onSelect} />)
  const button = screen.getByRole('combobox')
  open(button)
  const list = screen.getByRole('listbox')
  fireEvent.keyDown(button, { key: 'd' })
  rerender(<ModelPicker models={choices} currentProvider="p" currentModelId="dog" onSelect={onSelect} compact />)
  fireEvent.keyDown(button, { key: 'e' })
  expect(screen.getByRole('listbox')).toBe(list)
  expect(document.getElementById(button.getAttribute('aria-activedescendant')!)).toHaveAccessibleName('delta')
  fireEvent.keyDown(button, { key: 'Enter' })
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('p', 'delta')
})

it('retains the omitted-provider fallback and displays unknown model IDs without selecting another model', () => {
  const onSelect = vi.fn()
  const { rerender } = render(<ModelPicker models={models} currentModelId="shared" onSelect={onSelect} />)
  const button = screen.getByRole('combobox')
  expect(button).toHaveAttribute('title', 'alpha/beta/shared')
  open(button)
  expect(screen.getAllByRole('option', { selected: true })).toHaveLength(1)
  fireEvent.keyDown(button, { key: 'Escape' })
  rerender(<ModelPicker models={models} currentProvider="" currentModelId="shared" onSelect={onSelect} />)
  open(button)
  expect(screen.queryByRole('option', { selected: true })).not.toBeInTheDocument()
  fireEvent.keyDown(button, { key: 'Escape' })
  rerender(<ModelPicker models={models} currentProvider="missing" currentModelId="unknown/id" onSelect={onSelect} />)
  expect(button).toHaveTextContent('unknown/id')
  expect(button).toHaveAttribute('title', '切换模型')
  open(button)
  expect(screen.queryByRole('option', { selected: true })).not.toBeInTheDocument()
  expect(onSelect).not.toHaveBeenCalled()
})

it('renders loading as an unavailable option and keeps both picker types disabled inside a fieldset', () => {
  const onSelect = vi.fn()
  const { rerender } = render(<ModelPicker models={[]} onSelect={onSelect} />)
  let button = screen.getByRole('combobox')
  expect(button).toHaveTextContent('模型')
  open(button)
  const loading = screen.getByRole('option', { name: '模型加载中…' })
  expect(loading).toHaveAttribute('aria-disabled', 'true')
  expect(loading).toHaveAttribute('aria-selected', 'false')
  expect(button).not.toHaveAttribute('aria-activedescendant')
  fireEvent.click(loading)
  fireEvent.keyDown(button, { key: 'Enter' })
  expect(onSelect).not.toHaveBeenCalled()
  rerender(<fieldset disabled>
    <ModelPicker models={models} onSelect={onSelect} />
    <ThinkingPicker levels={['low', 'high']} onSelect={onSelect} />
  </fieldset>)
  for (button of screen.getAllByRole('combobox')) {
    expect(button).toBeDisabled()
    fireEvent.click(button)
    fireEvent.keyDown(button, { key: 'Enter' })
  }
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(onSelect).not.toHaveBeenCalled()
})

it('closes an open model menu when explicitly disabled and leaves the callback untouched', () => {
  const onSelect = vi.fn()
  const { rerender } = render(<ModelPicker models={models} onSelect={onSelect} />)
  const button = screen.getByRole('combobox')
  open(button)
  rerender(<ModelPicker models={models} onSelect={onSelect} disabled />)
  expect(button).toBeDisabled()
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  fireEvent.click(button)
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(onSelect).not.toHaveBeenCalled()
})

it('hides absent thinking levels and preserves its fallback, icon and exact level callback', () => {
  const onSelect = vi.fn()
  const { container, rerender } = render(<ThinkingPicker levels={[]} onSelect={onSelect} />)
  expect(container).toBeEmptyDOMElement()
  rerender(<ThinkingPicker levels={['off', 'medium', 'high']} current="unknown" onSelect={onSelect} />)
  const button = screen.getByRole('combobox', { name: '思考等级' })
  expect(button).toHaveClass('pion-select', 'thinking-trigger')
  expect(button).toHaveTextContent('off')
  expect(button).toHaveAttribute('title', '切换思考等级')
  expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  open(button)
  expect(screen.getByRole('listbox')).toHaveClass('thinking-picker-popup')
  expect(screen.getByRole('option', { name: 'off' })).toHaveAttribute('aria-selected', 'true')
  fireEvent.click(screen.getByRole('option', { name: 'off' }))
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('off')
  onSelect.mockClear()
  open(button)
  fireEvent.click(screen.getByRole('option', { name: 'high' }))
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('high')
})

it('keeps picker presentation attached to shared selectors without overriding portal placement or scrolling', () => {
  const css = readFileSync('src/renderer/src/styles/composer.css', 'utf8')
  expect(css).toMatch(/\.pion-select\.picker-trigger\s*\{[^}]*padding: 5px 10px;[^}]*border: 0;[^}]*font-size: 14px;[^}]*line-height: normal;/)
  expect(css).toMatch(/\.picker-compact \.pion-select\.picker-trigger\s*\{[^}]*padding: 3px 8px;[^}]*font-size: 13px;[^}]*border-radius: 999px;/)
  expect(css).toMatch(/\.pion-select\.thinking-trigger\s*\{[^}]*gap: 5px;[^}]*padding: 4px 8px;[^}]*border-radius: 999px;[^}]*font-size: 13px;/)
  const popup = css.match(/\.pion-select-popup\.model-picker-popup,\s*\.pion-select-popup\.thinking-picker-popup\s*\{([^}]*)\}/)![1]
  expect(popup).toContain('padding: 6px')
  expect(popup).toContain('font-family: var(--mono)')
  expect(popup).not.toMatch(/(?:^|\n)\s*(?:position|(?:max-|min-)?(?:width|height)|top|bottom|left|right|overflow(?:-[xy])?):/)
  expect(css).toContain('.model-picker-popup .pion-select-option')
  expect(css).toContain('.thinking-picker-popup .pion-select-option')
  expect(css).toContain('prefers-reduced-motion: reduce')
  expect(css).toContain('forced-colors: active')
  expect(css).toContain('border: 1px solid ButtonText')
})

it('shares thinking IME, keyboard commit and menu-only Escape handling without scrolling its host', () => {
  const onSelect = vi.fn(), escape = vi.fn()
  const { container } = render(<ThinkingPicker levels={['off', 'medium', 'high']} current="medium" onSelect={onSelect} />)
  const button = screen.getByRole('combobox')
  container.scrollTop = 41
  window.addEventListener('keydown', escape)
  try {
    open(button)
    fireEvent.compositionStart(button)
    fireEvent.keyDown(button, { key: 'End' })
    fireEvent.keyDown(button, { key: 'Enter', isComposing: true })
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.compositionEnd(button)
    fireEvent.keyDown(button, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(escape).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }))
    expect(button).toHaveFocus()
    fireEvent.keyDown(button, { key: 'End' })
    fireEvent.keyDown(button, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('high')
    expect(container.scrollTop).toBe(41)
  } finally { window.removeEventListener('keydown', escape) }
})
