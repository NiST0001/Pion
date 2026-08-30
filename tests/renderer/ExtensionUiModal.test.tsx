// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ExtensionUiModal } from '../../src/renderer/src/components/ExtensionUiModal'
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
