// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatMessage } from '../../src/renderer/src/features/chat/ChatMessage'
import {
  assignPendingLineDelays,
  resetLineRevealClock,
  takeLineRevealSlot
} from '../../src/renderer/src/utils/screenTextReveal'

describe('ChatMessage', () => {
  it('streams assistant text without a simulated terminal block cursor', () => {
    const { container } = render(
      <ChatMessage
        item={{
          kind: 'assistant',
          id: 1,
          text: '正在生成回复',
          thinking: '',
          streaming: true,
          live: true
        }}
        canFork={false}
      />
    )

    expect(container.querySelector('.markdown')).toHaveTextContent('正在生成回复')
    expect(container.querySelectorAll('.markdown .screen-text-reveal-line-live')).toHaveLength(1)
    expect(container.querySelector('.caret')).not.toBeInTheDocument()
  })

  it('arms a historical row after the lazy message component mounts', () => {
    const { container } = render(
      <div className="chat-scroll">
        <ChatMessage
          item={{
            kind: 'assistant',
            id: 3,
            text: '延迟加载后仍应显示',
            thinking: '',
            streaming: false,
            historical: true
          }}
          canFork={false}
        />
      </div>
    )

    expect(container.querySelector('.markdown')).toHaveTextContent('延迟加载后仍应显示')
    expect(container.querySelector('.history-reveal')).toBeInTheDocument()
  })

  it('reveals live thinking text independently from the assistant answer', () => {
    const { container } = render(
      <ChatMessage
        item={{
          kind: 'assistant',
          id: 2,
          text: '',
          thinking: '分析工具调用',
          streaming: true,
          live: true
        }}
        canFork={false}
      />
    )

    expect(container.querySelector('.row-assistant-thinking-only')).toBeInTheDocument()
    expect(container.querySelectorAll('.screen-text-reveal-live')).toHaveLength(6)
  })

  it('fades the assistant bubble in together with its first line', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000)
    resetLineRevealClock()
    takeLineRevealSlot() // occupy an earlier slot so the line delay is non-zero
    const { container } = render(
      <ChatMessage
        item={{
          kind: 'assistant',
          id: 5,
          text: '第一行\n第二行',
          thinking: '',
          streaming: false,
          historical: true
        }}
        canFork={false}
      />
    )
    // History lines wait for the settle scan, which assigns DOM-order delays
    // and lets the bubble copy its first line's slot.
    assignPendingLineDelays(container)

    const bubble = container.querySelector<HTMLElement>('.bubble-assistant')
    const firstLine = container.querySelector<HTMLElement>('.markdown .screen-text-reveal-line')
    expect(bubble?.className).toContain('screen-text-reveal-line')
    expect(firstLine).not.toBeNull()
    const lineDelay = firstLine?.style.getPropertyValue('--screen-text-reveal-delay')
    expect(lineDelay).toBe('40ms')
    expect(bubble?.style.getPropertyValue('--screen-text-reveal-delay')).toBe('20ms')
    vi.restoreAllMocks()
  })
})
