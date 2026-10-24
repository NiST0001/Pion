// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionUiModal } from '../../src/renderer/src/features/common/ExtensionUiModal'
import { useConversationOverlays } from '../../src/renderer/src/hooks/useConversationOverlays'
import type { ExtensionUiRequest } from '../../src/shared/types'
import { QUESTION_CUSTOM_ANSWER_OPTION } from '../../src/shared/question-answer'

const baseRequest: ExtensionUiRequest = {
  id: 'request-1',
  cwd: '/tmp/project',
  method: 'select',
  title: '实现方式: 请选择计划方向',
  options: [
    '1. 保持兼容 — 改动较小',
    '2. 完整重构 — 长期维护更容易',
    QUESTION_CUSTOM_ANSWER_OPTION
  ],
  createdAt: 1,
  timeoutAt: 10_000
}

const questionRequest: ExtensionUiRequest = { ...baseRequest, question: true, scope: 'workspace', timeoutAt: null }

describe('ExtensionUiModal', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  describe('composer clearance', () => {
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
      const stack = css.match(/\.session-interaction-panels > \.extension-ui-backdrop:not\(\.is-global\)\s*\{([^}]*)\}/)?.[1] ?? ''
      expect(stack).toContain('position: static')
      expect(stack).toContain('inset: auto')
      expect(stack).toContain('bottom: auto')
      expect(stack).toContain('padding: 0')
      expect(css).toMatch(/\.extension-ui-backdrop\[hidden\],[\s\S]*?display: none/)
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
          <div className="chat-stage"><div className="session-interaction-panels">
            <ExtensionUiModal request={request} queueLength={1} busy={false} error="" onResolve={onResolve} />
          </div></div>
          <div className="composer-dock"><textarea aria-label="消息草稿" defaultValue="已有消息草稿" /></div>
        </div>
      }
      const view = render(<Harness />)
      const shell = screen.getByTestId('conversation')
      const question = screen.getByRole('region', { name: request.title })
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
      expect(screen.getByRole('region', { name: request.title })).toBe(question)
      expect(screen.getByRole('textbox', { name: request.title })).toBe(answer)
      expect(answer).toHaveValue('未提交的回答')
      expect(screen.getByRole('textbox', { name: '消息草稿' })).toBe(draft)
      expect(draft).toHaveValue('已有消息草稿')
      expect(onResolve).not.toHaveBeenCalled()
      view.unmount()
      expect(disconnect).toHaveBeenCalled()
    })
  })

  it.each([
    { name: /完整重构/, value: baseRequest.options?.[1] },
    { name: QUESTION_CUSTOM_ANSWER_OPTION, value: QUESTION_CUSTOM_ANSWER_OPTION }
  ])('returns the exact ordinary extension option $value without entering custom mode', ({ name, value }) => {
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

    expect(screen.getByRole('region', { name: baseRequest.title })).toHaveTextContent('还有 1 项')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(baseRequest.options!.length)
    const toggle = screen.getByRole('button', { name: /Agent 提问/ })
    expect(toggle.tagName).toBe('BUTTON')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(onResolve).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('option', { name }))
    expect(onResolve).toHaveBeenCalledExactlyOnceWith({ value })
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('returns from a native custom answer to the original options without resolving or renewing the question', () => {
    vi.useFakeTimers()
    const onResolve = vi.fn()
    const request = { ...questionRequest, timeoutAt: Date.now() + 60_000 }
    render(<ExtensionUiModal request={request} queueLength={1} busy={false} error="" onResolve={onResolve} />)
    fireEvent.click(screen.getByRole('option', { name: QUESTION_CUSTOM_ANSWER_OPTION }))
    const answer = screen.getByRole('textbox', { name: questionRequest.title })
    expect(answer.tagName).toBe('INPUT')
    expect(answer).toHaveFocus()
    fireEvent.change(answer, { target: { value: '尚未提交的草稿' } })
    expect(onResolve).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(10_000))

    fireEvent.click(screen.getByRole('button', { name: '返回选项' }))
    expect(screen.getByText('50 秒后超时')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: /保持兼容/ })).toHaveFocus()
    expect(onResolve).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('option', { name: /完整重构/ }))
    expect(onResolve).toHaveBeenCalledExactlyOnceWith({ value: questionRequest.options?.[1] })
  })

  it('retains a custom draft through returning, folding and hiding, and only submits explicitly while active and idle', () => {
    vi.useFakeTimers()
    const onResolve = vi.fn()
    const view = render(<ExtensionUiModal request={questionRequest} queueLength={1} busy={false} error="" onResolve={onResolve} />)
    const toggle = screen.getByRole('button', { name: /Agent 提问/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('option', { name: QUESTION_CUSTOM_ANSWER_OPTION }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  保留的自定义草稿  ' } })
    fireEvent.click(screen.getByRole('button', { name: '返回选项' }))
    const modal = render(<div role="dialog" aria-modal="true"><input aria-label="另一个弹窗" /></div>)
    const otherInput = screen.getByRole('textbox', { name: '另一个弹窗' })
    otherInput.focus()
    fireEvent.click(screen.getByRole('option', { name: QUESTION_CUSTOM_ANSWER_OPTION }))
    const answer = screen.getByRole('textbox', { name: questionRequest.title })
    const back = screen.getByRole('button', { name: '返回选项' })
    const submit = screen.getByRole('button', { name: /提交回答/ })
    expect(answer).toHaveValue('  保留的自定义草稿  ')
    expect(otherInput).toHaveFocus()
    modal.unmount()
    expect(onResolve).not.toHaveBeenCalled()
    fireEvent.click(toggle)
    act(() => vi.advanceTimersByTime(250))
    fireEvent.click(toggle)
    expect(screen.getByRole('textbox')).toBe(answer)
    expect(answer).toHaveValue('  保留的自定义草稿  ')

    view.rerender(<ExtensionUiModal request={questionRequest} queueLength={1} busy error="" onResolve={onResolve} />)
    expect(answer).toBeDisabled()
    expect(back).toBeDisabled()
    expect(submit).toBeDisabled()
    fireEvent.click(back)
    fireEvent.click(submit)
    fireEvent.keyDown(answer, { key: 'Enter' })
    view.rerender(<ExtensionUiModal active={false} request={questionRequest} queueLength={1} busy={false} error="" onResolve={onResolve} />)
    expect(back).toBeDisabled()
    expect(submit).toBeDisabled()
    fireEvent.click(back)
    fireEvent.keyDown(answer, { key: 'Enter' })
    expect(onResolve).not.toHaveBeenCalled()
    view.rerender(<ExtensionUiModal request={questionRequest} queueLength={1} busy={false} error="" onResolve={onResolve} />)
    expect(screen.getByRole('textbox')).toBe(answer)
    expect(answer).toHaveValue('  保留的自定义草稿  ')
    expect(answer).not.toHaveFocus()
    fireEvent.keyDown(answer, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(answer, { key: 'Enter', keyCode: 229 })
    expect(onResolve).not.toHaveBeenCalled()
    fireEvent.click(submit)
    expect(onResolve).toHaveBeenCalledExactlyOnceWith({ customAnswer: '保留的自定义草稿' })

    view.rerender(<ExtensionUiModal request={{ ...questionRequest, id: 'question-2' }} queueLength={1} busy={false} error="" onResolve={onResolve} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: QUESTION_CUSTOM_ANSWER_OPTION }))
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.getByRole('button', { name: /提交回答/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '取消 Agent 交互' }))
    expect(onResolve).toHaveBeenLastCalledWith({ cancelled: true })
    expect(onResolve).toHaveBeenCalledTimes(2)
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

  it('cancels a global authentication request with Escape', () => {
    const onResolve = vi.fn()
    render(
      <ExtensionUiModal
        request={{ ...baseRequest, scope: 'global', source: 'provider-auth' }}
        queueLength={1}
        busy={false}
        error=""
        onResolve={onResolve}
      />
    )

    expect(screen.queryByRole('button', { expanded: false })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onResolve).toHaveBeenCalledWith({ cancelled: true })
  })

  it('only folds a focused session panel on Escape and retains its answer across folding and hiding', () => {
    vi.useFakeTimers()
    const onResolve = vi.fn()
    const request = { ...baseRequest, method: 'editor' as const, options: undefined, prefill: '初始回答' }
    const view = render(<ExtensionUiModal request={request} queueLength={1} busy={false} error="" onResolve={onResolve} />)
    const toggle = screen.getByRole('button', { name: /Agent 提问/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onResolve).not.toHaveBeenCalled()
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const answer = screen.getByRole('textbox')
    fireEvent.change(answer, { target: { value: '保留的草稿' } })
    answer.focus()
    const modal = render(<div role="dialog" aria-modal="true">另一个弹窗</div>)
    fireEvent.keyDown(answer, { key: 'Escape' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    modal.unmount()
    fireEvent.keyDown(answer, { key: 'Escape', isComposing: true })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(answer, { key: 'Escape' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveFocus()
    act(() => vi.advanceTimersByTime(250))
    view.rerender(<ExtensionUiModal active={false} request={request} queueLength={1} busy={false} error="" onResolve={onResolve} />)
    view.rerender(<ExtensionUiModal active request={request} queueLength={1} busy={false} error="" onResolve={onResolve} />)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(onResolve).not.toHaveBeenCalled()
    fireEvent.click(toggle)
    expect(screen.getByRole('textbox')).toBe(answer)
    expect(answer).toHaveValue('保留的草稿')

    view.rerender(<ExtensionUiModal active={false} request={request} queueLength={1} busy={false} error="" onResolve={onResolve} />)
    const shell = view.container.querySelector('.extension-ui-backdrop')
    expect(shell).toHaveAttribute('hidden')
    expect(shell).toHaveAttribute('inert')
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
    fireEvent.keyDown(answer, { key: 'Escape' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(onResolve).not.toHaveBeenCalled()

    view.rerender(<ExtensionUiModal active request={request} queueLength={2} busy={false} error="回答未提交" onResolve={onResolve} />)
    expect(screen.getByRole('textbox')).toBe(answer)
    expect(answer).toHaveValue('保留的草稿')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('回答未提交')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消 Agent 交互' }))
    expect(onResolve).toHaveBeenCalledExactlyOnceWith({ cancelled: true })
  })

  it('does not steal focus or install modal shortcuts for inactive requests or session questions', () => {
    const frames = vi.spyOn(window, 'requestAnimationFrame')
    const listeners = vi.spyOn(window, 'addEventListener')
    const onResolve = vi.fn()
    const view = render(<div><input aria-label="会话草稿" /></div>)
    const draft = screen.getByRole('textbox', { name: '会话草稿' })
    draft.focus()
    const globalRequest = { ...baseRequest, scope: 'global' as const, source: 'provider-auth' as const }
    const panels = <>
      <ExtensionUiModal request={baseRequest} queueLength={1} busy={false} error="" onResolve={onResolve} />
      <ExtensionUiModal active={false} request={globalRequest} queueLength={1} busy={false} error="" onResolve={onResolve} />
    </>
    view.rerender(<div><input aria-label="会话草稿" />{panels}</div>)
    expect(draft).toHaveFocus()
    expect(frames).not.toHaveBeenCalled()
    expect(listeners.mock.calls.some(([name]) => name === 'keydown')).toBe(false)
    expect(view.container.querySelector('.is-global')).toHaveAttribute('hidden')
    expect(view.container.querySelector('.is-global')).toHaveAttribute('inert')
    expect(view.container.querySelector('.is-global [role="dialog"]')).not.toHaveAttribute('aria-modal', 'true')
    fireEvent.keyDown(draft, { key: 'Escape' })
    expect(onResolve).not.toHaveBeenCalled()
  })
})
