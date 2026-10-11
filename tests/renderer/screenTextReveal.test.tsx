// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { Markdown } from '../../src/renderer/src/features/chat/Markdown'
import {
  appendedCharacterCount,
  armScreenTextReveal,
  resetLineRevealClock,
  RevealText,
  takeLineRevealSlot,
  SCREEN_TEXT_REVEAL_LIVE_DURATION_MS,
  SCREEN_TEXT_REVEAL_LIVE_MAX_DELAY_MS
} from '../../src/renderer/src/utils/screenTextReveal'

describe('screen text reveal', () => {
  it('wraps every character without changing the rendered text', () => {
    const { container } = render(<RevealText text={'A\n好'} mode="live" />)
    const characters = [...container.querySelectorAll('[data-screen-reveal-character]')]

    expect(container.textContent).toBe('A\n好')
    expect(characters).toHaveLength(3)
    expect(characters.map((element) => element.textContent)).toEqual(['A', '\n', '好'])
    expect(characters.every((element) => element.classList.contains('screen-text-reveal-live'))).toBe(true)
  })

  it('keeps a long settled prefix as text rather than thousands of character spans', () => {
    const text = 'x'.repeat(10000) + 'new'
    const { container } = render(<RevealText text={text} mode="live" revealCount={3} />)
    expect(container.textContent).toBe(text)
    expect(container.querySelectorAll('span')).toHaveLength(3)
  })

  it('does not remeasure already armed history characters on later scroll scans', () => {
    const root = document.createElement('div')
    root.innerHTML = '<span class="screen-text-reveal-history screen-text-reveal-armed" data-screen-reveal-character="true">a</span><span class="screen-text-reveal-history" data-screen-reveal-character="true">b</span>'
    const rect = { top: 0, bottom: 10, width: 20, height: 10 } as DOMRect
    root.getBoundingClientRect = () => rect
    const oldMeasure = vi.fn(() => rect)
    const newMeasure = vi.fn(() => rect)
    ;(root.children[0] as HTMLElement).getBoundingClientRect = oldMeasure
    ;(root.children[1] as HTMLElement).getBoundingClientRect = newMeasure
    armScreenTextReveal(root)
    armScreenTextReveal(root)
    expect(oldMeasure).not.toHaveBeenCalled()
    expect(newMeasure).toHaveBeenCalledOnce()
  })

  it('assigns each Markdown line one fixed delay that survives re-parses', () => {
    resetLineRevealClock()
    const view = render(<Markdown text={'第一行\n第二行'} revealMode="live" />)
    const before = [...view.container.querySelectorAll<HTMLElement>('.screen-text-reveal-line-live')]
    expect(before).toHaveLength(2)
    const delays = before.map((element) => element.style.getPropertyValue('--screen-text-reveal-delay'))
    expect(delays.every((delay) => delay.endsWith('ms'))).toBe(true)

    view.rerender(<Markdown text={'第一行\n第二行\n第三行'} revealMode="live" />)
    const after = [...view.container.querySelectorAll<HTMLElement>('.screen-text-reveal-line-live')]
    expect(after).toHaveLength(3)
    // Existing lines keep both their DOM node and their assigned delay.
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
    expect(after[0].style.getPropertyValue('--screen-text-reveal-delay')).toBe(delays[0])
    expect(after[1].style.getPropertyValue('--screen-text-reveal-delay')).toBe(delays[1])
  })

  it('queues list items on the same waterfall clock as line spans', () => {
    resetLineRevealClock()
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1000)
    const view = render(<Markdown text={'- 第一\n- 第二'} revealMode="live" />)
    const items = [...view.container.querySelectorAll<HTMLElement>('li.screen-text-reveal-line')]
    expect(items).toHaveLength(2)
    expect(items.map((item) => item.style.getPropertyValue('--screen-text-reveal-delay')))
      .toEqual(['0ms', '40ms'])
    nowSpy.mockRestore()
  })

  it('fades only newly streamed characters within a live line', () => {
    resetLineRevealClock()
    const view = render(<Markdown text="你好" revealMode="live" />)
    expect([...view.container.querySelectorAll('.screen-text-reveal-live')]
      .map((element) => element.textContent)).toEqual(['你', '好'])

    view.rerender(<Markdown text="你好世界" revealMode="live" />)
    expect([...view.container.querySelectorAll('.screen-text-reveal-live')]
      .map((element) => element.textContent)).toEqual(['世', '界'])
    expect(view.container).toHaveTextContent('你好世界')
  })

  it('queues lines on one global clock and restarts after idle', () => {
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1000)
    resetLineRevealClock()
    expect(takeLineRevealSlot()).toBe(0)
    expect(takeLineRevealSlot()).toBe(20)
    nowSpy.mockReturnValue(5000)
    expect(takeLineRevealSlot()).toBe(0)
    resetLineRevealClock()
    nowSpy.mockRestore()
  })

  it('doubles live character stagger and cap without slowing history characters', () => {
    const view = render(<RevealText text={'a'.repeat(200)} mode="live" />)
    const characters = view.container.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')
    expect(characters[1].style.getPropertyValue('--screen-text-reveal-delay')).toBe('2.4ms')
    expect(characters[199].style.getPropertyValue('--screen-text-reveal-delay')).toBe('360ms')
    view.rerender(<RevealText text="abc" mode="history" />)
    const rect = { top: 0, bottom: 10, width: 20, height: 10 } as DOMRect
    view.container.getBoundingClientRect = () => rect
    for (const character of view.container.querySelectorAll<HTMLElement>('span')) {
      character.getBoundingClientRect = () => rect
    }
    armScreenTextReveal(view.container)
    expect(view.container.querySelectorAll<HTMLElement>('span')[1].style.getPropertyValue('--screen-text-reveal-delay')).toBe('1.2ms')
  })

  it('uses live 40ms slots while retaining history 20ms slots on the shared clock', () => {
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1000)
    resetLineRevealClock()
    expect(takeLineRevealSlot('live')).toBe(0)
    expect(takeLineRevealSlot('history')).toBe(40)
    expect(takeLineRevealSlot('history')).toBe(60)
    resetLineRevealClock()
    nowSpy.mockRestore()
  })

  it('keeps CSS fade durations aligned with cleanup constants and reduced-motion overrides', () => {
    // Static contract only: this does not claim real browser animation timing.
    const css = readFileSync('src/renderer/src/styles/refinements.css', 'utf8')
    expect(css).toContain(`.screen-text-reveal-live {\n  animation-duration: ${SCREEN_TEXT_REVEAL_LIVE_DURATION_MS}ms;`)
    expect(css).toContain('.screen-text-reveal-line-live[data-line-reveal-ready="true"] {\n  animation-duration: 180ms;')
    expect(css).toContain('animation: screen-text-reveal 90ms')
    expect(css).toContain('animation: screen-text-reveal 52ms')
    expect(SCREEN_TEXT_REVEAL_LIVE_MAX_DELAY_MS).toBe(360)
    const reducedMotion = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.screen-text-reveal-line {')))
    expect(reducedMotion).toContain('.screen-text-reveal-line-live[data-line-reveal-ready="true"]')
    expect(reducedMotion).toContain('animation: none;')
  })

  it('animates only the appended suffix of a live value', () => {
    expect(appendedCharacterCount('', 'abc')).toBe(3)
    expect(appendedCharacterCount('abc', 'abcdef')).toBe(3)
    expect(appendedCharacterCount('abc', 'ab')).toBe(2)
    expect(appendedCharacterCount('same', 'same')).toBe(0)
  })
})
