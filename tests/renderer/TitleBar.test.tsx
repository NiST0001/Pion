// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TitleBar } from '../../src/renderer/src/features/chrome/TitleBar'

const props = { maximized: false, sidebarOpen: true, sidebarWidth: 240, reviewOpen: false,
  onToggleSidebar: vi.fn(), onToggleReview: vi.fn() }

describe('TitleBar full working directory', () => {
  it.each(['/Misc/AIProject/AI_Software/Pion', '/home/user/projects/Pion',
    'C:\\Users\\user\\projects\\Pion', '\\\\server\\share\\projects\\Pion'])('keeps the original complete path: %s', (cwd) => {
    const { container } = render(<TitleBar {...props} cwd={cwd} sessionName="当前会话" />)
    const title = container.querySelector('.titlebar-path')!
    expect(title.textContent).toBe(`${cwd} · 当前会话`)
    expect(title).toHaveAttribute('title', cwd)
  })

  it('retains the session-only and empty-workspace fallback', () => {
    const { container, rerender } = render(<TitleBar {...props} sessionName="当前会话" />)
    expect(container.querySelector('.titlebar-path')).toHaveTextContent('当前会话')
    rerender(<TitleBar {...props} />)
    expect(container.querySelector('.titlebar-path')).toHaveTextContent('Pion')
  })
})
