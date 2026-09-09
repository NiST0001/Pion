// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  armHistoryRevealRow,
  armPendingHistoryRevealRows
} from '../../src/renderer/src/utils/historyReveal'
import {
  armScreenTextReveal,
  assignPendingLineDelays,
  resetLineRevealClock
} from '../../src/renderer/src/utils/screenTextReveal'

function rect(top: number, left: number, height = 20, width = 200): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({})
  } as DOMRect
}

describe('history text reveal', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('arms visible characters in timeline DOM order', () => {
    const container = document.createElement('div')
    const first = document.createElement('div')
    const second = document.createElement('div')
    container.append(first, second)
    document.body.append(container)
    container.getBoundingClientRect = () => rect(100, 0, 100, 400)
    first.getBoundingClientRect = () => rect(120, 0)
    second.getBoundingClientRect = () => rect(145, 0)

    for (const [row, positions] of [[first, [140, 120]], [second, [180, 160]]] as const) {
      row.className = 'history-reveal'
      for (const left of positions) {
        const character = document.createElement('span')
        character.dataset.screenRevealCharacter = ''
        character.className = 'screen-text-reveal-history'
        character.getBoundingClientRect = () => rect(row === first ? 120 : 145, left, 10, 8)
        row.append(character)
      }
    }

    armPendingHistoryRevealRows(container)

    const delays = [...container.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
      .map((element) => Number.parseFloat(element.style.getPropertyValue('--screen-text-reveal-delay')))
    expect(delays.map((delay) => Math.round(delay * 10) / 10)).toEqual([0, 1.2, 2.4, 3.6])
    expect(first).toHaveClass('history-reveal-armed')
    expect(second).toHaveClass('history-reveal-armed')
  })

  it('starts newly mounted text without remeasuring or delaying behind armed text', () => {
    const container = document.createElement('div')
    const first = document.createElement('div')
    const firstCharacter = document.createElement('span')
    container.append(first)
    first.append(firstCharacter)
    document.body.append(container)
    container.getBoundingClientRect = () => rect(100, 0, 80, 300)
    first.getBoundingClientRect = () => rect(120, 0)
    firstCharacter.getBoundingClientRect = vi.fn(() => rect(120, 0, 10, 8))
    first.className = 'history-reveal'
    firstCharacter.dataset.screenRevealCharacter = ''
    firstCharacter.className = 'screen-text-reveal-history'

    armHistoryRevealRow(first, container)
    vi.mocked(firstCharacter.getBoundingClientRect).mockClear()

    const second = document.createElement('div')
    const secondCharacter = document.createElement('span')
    second.append(secondCharacter)
    container.append(second)
    second.getBoundingClientRect = () => rect(145, 0)
    secondCharacter.getBoundingClientRect = () => rect(145, 0, 10, 8)
    second.className = 'history-reveal'
    secondCharacter.dataset.screenRevealCharacter = ''
    secondCharacter.className = 'screen-text-reveal-history'
    armHistoryRevealRow(second, container)

    expect(firstCharacter.style.getPropertyValue('--screen-text-reveal-delay')).toBe('0ms')
    expect(secondCharacter.style.getPropertyValue('--screen-text-reveal-delay')).toBe('0ms')
    expect(firstCharacter.getBoundingClientRect).not.toHaveBeenCalled()
  })

  it('can arm newly mounted detail text in an already armed row', () => {
    const container = document.createElement('div')
    const row = document.createElement('div')
    const character = document.createElement('span')
    container.append(row)
    row.append(character)
    document.body.append(container)
    container.getBoundingClientRect = () => rect(100, 0, 80, 300)
    row.getBoundingClientRect = () => rect(120, 0)
    character.getBoundingClientRect = () => rect(120, 0, 10, 8)
    row.className = 'history-reveal history-reveal-armed'
    character.dataset.screenRevealCharacter = ''
    character.className = 'screen-text-reveal-history'

    armHistoryRevealRow(row, container)

    expect(character).toHaveClass('screen-text-reveal-armed')
  })

  it('animates only the bottom two viewport heights and shows older lines instantly', () => {
    const container = document.createElement('div')
    document.body.append(container)
    container.getBoundingClientRect = () => rect(100, 0, 500, 400)
    const makeLine = (top: number): HTMLElement => {
      const line = document.createElement('span')
      line.className = 'screen-text-reveal-line screen-text-reveal-line-history'
      line.getBoundingClientRect = () => rect(top, 0, 20, 200)
      container.append(line)
      return line
    }

    // 窗口：容器底部 600 - 2*500 = -400；top=0 的行在窗口之上，top=500/580 的在窗口内
    const oldLine = makeLine(-600)
    const inWindow1 = makeLine(500)
    const inWindow2 = makeLine(580)
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1000)
    resetLineRevealClock()
    assignPendingLineDelays(container)
    nowSpy.mockRestore()

    expect(oldLine).toHaveClass('screen-text-reveal-static')
    expect(oldLine.style.getPropertyValue('--screen-text-reveal-delay')).toBe('')
    expect(inWindow1.style.getPropertyValue('--screen-text-reveal-delay')).toBe('0ms')
    expect(inWindow2.style.getPropertyValue('--screen-text-reveal-delay')).toBe('20ms')
  })

  it('does not arm characters outside the scroll viewport', () => {
    const container = document.createElement('div')
    const row = document.createElement('div')
    const character = document.createElement('span')
    container.append(row)
    row.append(character)
    document.body.append(container)
    container.getBoundingClientRect = () => rect(100, 0, 80, 300)
    row.getBoundingClientRect = () => rect(300, 0)
    character.getBoundingClientRect = () => rect(300, 0, 10, 8)
    row.className = 'history-reveal'
    character.dataset.screenRevealCharacter = ''
    character.className = 'screen-text-reveal-history'

    armScreenTextReveal(container, container)

    expect(character).not.toHaveClass('screen-text-reveal-armed')
    expect(character.style.getPropertyValue('--screen-text-reveal-delay')).toBe('')
  })
})
