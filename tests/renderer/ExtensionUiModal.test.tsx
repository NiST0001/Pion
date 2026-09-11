// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionUiModal } from '../../src/renderer/src/features/common/ExtensionUiModal'
import { useConversationOverlays } from '../../src/renderer/src/hooks/useConversationOverlays'
import type { ExtensionUiRequest } from '../../src/shared/types'

const baseRequest: ExtensionUiRequest = {
  id: 'request-1',
  cwd: '/tmp/project',
  method: 'select',
  title: '实现方式: 请选择计划方向',
  options: [
    '1. 保持兼容 — 改动较小',
    '2. 完整重构 — 长期维护更容易'
  ],
  createdAt: 1,
  timeoutAt: 10_000
}

describe('ExtensionUiModal', () => {
  describe('composer clearance', () => {
    afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

    it('scopes the measured offset to workspace questions, not global authentication dialogs', () => {
      // jsdom does not lay out CSS variables: check the positioning contract,
      // then exercise its ResizeObserver input separately below.
      const css = readFileSync(resolve('src/renderer/src/styles/extension-ui.css'), 'utf8')
      const base = css.match(/\.extension-ui-backdrop\s*\{([^}]*)\}/)?.[1] ?? ''
      const workspace = css.match(/\.extension-ui-backdrop:not\(\.is-global\)\s*\{([^}]*)\}/)?.[1] ?? ''
      const global = css.match(/\.extension-ui-backdrop\.is-global\s*\{([^}]*)\}/)?.[1] ?? ''
      expect(base).toContain('position: absolute')
      expect(base).toContain('inset: 0')
      expect(base).not.toContain('bottom:')
      expect(base).toContain('align-items: flex-end')
      expect(workspace).toContain('bottom: var(--conversation-bottom-clearance, 0px)')
      expect(global).toContain('position: fixed')
      expect(global).toContain('align-items: center')
      expect(global).not.toContain('--conversation-bottom-clearance')
    })

    it('updates the question clearance as the composer grows without replacing either draft', () => {
      let measure = () => {}
      const observe = vi.fn()
      const disconnect = vi.fn()
      vi.stubGlobal('ResizeObserver', class {
        constructor(callback: () => void) { measure = callback }
        observe = observe
        disconnect = disconnect
      })
      let composerHeight = 140
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('composer-dock') ? composerHeight : 0
      })
      const onResolve = vi.fn()
      const request: ExtensionUiRequest = { ...baseRequest, method: 'editor', scope: 'workspace', options: undefined }
      function Harness() {
        const ref = useConversationOverlays(false)
        return <div ref={ref} data-testid="conversation">
          <div className="chat-stage">
            <ExtensionUiModal request={request} queueLength={1} busy={false} error="" onResolve={onResolve} />
          </div>
          <div className="composer-dock"><textarea aria-label="消息草稿" defaultValue="已有消息草稿" /></div>
        </div>
      }
      const view = render(<Harness />)
      const shell = screen.getByTestId('conversation')
      const question = screen.getByRole('dialog', { name: request.title })
      const answer = screen.getByRole('textbox', { name: request.title })
      const draft = screen.getByRole('textbox', { name: '消息草稿' })
      fireEvent.change(answer, { target: { value: '未提交的回答' } })
      expect(shell.style.getPropertyValue('--conversation-bottom-clearance')).toBe('140px')
      expect(observe).toHaveBeenCalledWith(shell.querySelector('.composer-dock'))
      expect(question.parentElement).not.toHaveClass('is-global')
      composerHeight = 272
      act(() => measure())
      view.rerender(<Harness />)
      expect(shell.style.getPropertyValue('--conversation-bottom-clearance')).toBe('272px')
      expect(screen.getByRole('dialog', { name: request.title })).toBe(question)
      expect(screen.getByRole('textbox', { name: request.title })).toBe(answer)
      expect(answer).toHaveValue('未提交的回答')
      expect(screen.getByRole('textbox', { name: '消息草稿' })).toBe(draft)
      expect(draft).toHaveValue('已有消息草稿')
      expect(onResolve).not.toHaveBeenCalled()
      view.unmount()
      expect(disconnect).toHaveBeenCalled()
    })
  })

  it('returns the exact RPC option selected by the user', () => {
    const onResolve = vi.fn()
    render(
      <ExtensionUiModal
        request={baseRequest}
        queueLength={2}
        busy={false}
        error=""
        onResolve={onResolve}
      />
    )

    expect(screen.getByRole('dialog', { name: baseRequest.title })).toHaveTextContent('还有 1 项')
    fireEvent.click(screen.getByRole('option', { name: /完整重构/ }))
    expect(onResolve).toHaveBeenCalledWith({ value: baseRequest.options?.[1] })
  })

  it('submits editor text for a custom plan answer', () => {
    const onResolve = vi.fn()
    render(
      <ExtensionUiModal
        request={{ ...baseRequest, method: 'editor', options: undefined, prefill: 'draft' }}
        queueLength={1}
        busy={false}
        error=""
        onResolve={onResolve}
      />
    )

    const editor = screen.getByRole('textbox')
    fireEvent.change(editor, { target: { value: '自定义答案' } })
    fireEvent.click(screen.getByRole('button', { name: /提交回答/ }))
    expect(onResolve).toHaveBeenCalledWith({ value: '自定义答案' })
  })

  it('renders Pi provider secrets in a global password prompt', () => {
    const onResolve = vi.fn()
    const { container } = render(
      <ExtensionUiModal
        request={{
          ...baseRequest,
          method: 'input',
          options: undefined,
          source: 'provider-auth',
          scope: 'global',
          secret: true,
          title: 'OpenAI · 输入 API 密钥'
        }}
        queueLength={1}
        busy={false}
        error=""
        onResolve={onResolve}
      />
    )

    expect(container.querySelector('.extension-ui-backdrop')).toHaveClass('is-global')
    expect(screen.getByText('Pi 提供商认证')).toBeInTheDocument()
    expect(container.querySelector('input')).toHaveAttribute('type', 'password')
  })

  it('cancels the pending request with Escape', () => {
    const onResolve = vi.fn()
    render(
      <ExtensionUiModal
        request={baseRequest}
        queueLength={1}
        busy={false}
        error=""
        onResolve={onResolve}
      />
    )

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onResolve).toHaveBeenCalledWith({ cancelled: true })
  })
})
