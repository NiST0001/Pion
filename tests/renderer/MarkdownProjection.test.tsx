// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { StrictMode } from 'react'
import type { Processor } from 'unified'
import * as gfm from 'remark-gfm'
import * as highlighter from 'rehype-highlight'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from '../../src/renderer/src/features/chat/Markdown'
import { BrowserNavigationContext } from '../../src/renderer/src/features/browser/BrowserNavigationContext'

const cost = vi.hoisted(() => ({ parse: 0, highlight: 0 }))

vi.mock('remark-gfm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remark-gfm')>()
  return { default: function (this: Processor, ...options: Parameters<typeof actual.default>) {
    actual.default.apply(this, options)
    const parse = this.parser!
    this.parser = (...args) => {
      cost.parse++
      return parse(...args)
    }
  } }
})

vi.mock('rehype-highlight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('rehype-highlight')>()
  return { default: (...options: Parameters<typeof actual.default>) => {
    const highlight = actual.default(...options)
    return (...args: Parameters<typeof highlight>) => {
      cost.highlight++
      return highlight(...args)
    }
  } }
})

describe('Markdown parsing and reveal projection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    cost.parse = 0
    cost.highlight = 0
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it.each([false, true])('reuses parsing/highlighting across admission and cleanup, retaining hosts and deadlines (StrictMode: %s)', (strictMode) => {
    const view = render(
      <div data-line-reveal-owner="true">
        <Markdown text={'```js\nconst answer = 42\n```\n\n[a](https://example.test)'} revealMode="live" />
      </div>,
      { wrapper: strictMode ? StrictMode : undefined }
    )
    expect(cost).toEqual({ parse: 1, highlight: 1 })
    const owner = view.container.firstElementChild!
    const link = view.getByRole('link', { name: 'a' })
    const line = link.closest<HTMLElement>('.screen-text-reveal-line')!
    const character = link.querySelector<HTMLElement>('.screen-text-reveal-live')!
    expect(character.style.animationPlayState).toBe('paused')
    expect(view.container.querySelector('.hljs-keyword')).toHaveTextContent('const')
    act(() => {
      line.dataset.lineRevealReady = 'true'
      line.dataset.lineRevealStart = String(performance.now() + 600)
      owner.dispatchEvent(new Event('pion:line-reveal'))
    })
    // Before caching, the measured baseline was 2 here and 3 after cleanup.
    expect(cost).toEqual({ parse: 1, highlight: 1 })
    expect(link.querySelector('.screen-text-reveal-live')).toBe(character)
    expect(character.style.animationPlayState).toBe('')
    expect(character.style.getPropertyValue('--screen-text-reveal-delay')).toBe('600ms')
    act(() => vi.advanceTimersByTime(1000))
    expect(link.querySelector('.screen-text-reveal-live')).toBe(character)
    act(() => vi.advanceTimersByTime(200))
    expect(cost).toEqual({ parse: 1, highlight: 1 })
    expect(view.container.querySelector('.screen-text-reveal-live')).toBeNull()
    expect(view.getByRole('link', { name: 'a' })).toBe(link)
    expect(link.closest('.screen-text-reveal-line')).toBe(line)
    expect(view.container.querySelector('.hljs-keyword')).toHaveTextContent('const')
  })

  it('invalidates on append, replacement, shortening and authoritative empty text, retaining only one source per mount', () => {
    const view = render(<Markdown text="ab" revealMode="live" />)
    const prefix = view.container.querySelector('.screen-text-reveal-live')
    expect(cost).toEqual({ parse: 1, highlight: 1 })
    view.rerender(<Markdown text="abc" revealMode="live" />)
    expect(cost).toEqual({ parse: 2, highlight: 2 })
    expect(view.container.querySelector('.screen-text-reveal-live')).toBe(prefix)
    expect(view.container.textContent).toBe('abc')
    view.rerender(<Markdown text={'```js\nlet next = 7\n```'} revealMode="live" />)
    expect(cost).toEqual({ parse: 3, highlight: 3 })
    expect(view.container.querySelector('.hljs-keyword')).toHaveTextContent('let')
    view.rerender(<Markdown text="a" revealMode="live" />)
    expect(cost).toEqual({ parse: 4, highlight: 4 })
    expect(view.container.textContent).toBe('a')
    view.rerender(<Markdown text="" />)
    expect(cost).toEqual({ parse: 5, highlight: 5 })
    expect(view.container.querySelector('.markdown')).toBeEmptyDOMElement()
    expect(vi.getTimerCount()).toBe(0)
    view.rerender(<Markdown text="ab" revealMode="live" />)
    expect(cost).toEqual({ parse: 6, highlight: 6 })
    view.unmount()
    render(<Markdown text="ab" revealMode="live" />)
    expect(cost).toEqual({ parse: 7, highlight: 7 })
  })

  it('invalidates both caches when the parser/GFM or highlighter pipeline changes', () => {
    const text = '~one~ ~~two~~\n\n```js\nconst value = 1\n```'
    const view = render(<Markdown text={text} />)
    expect(view.container.querySelectorAll('del')).toHaveLength(2)
    expect(view.container.querySelector('.hljs-keyword')).toHaveTextContent('const')
    const originalGfm = gfm.default
    vi.spyOn(gfm, 'default').mockImplementation(function (this: Processor, ...options) {
      originalGfm.call(this, { ...options[0], singleTilde: false })
    })
    view.rerender(<Markdown text={text} readOnly />)
    expect(cost).toEqual({ parse: 2, highlight: 2 })
    expect(view.container.querySelectorAll('del')).toHaveLength(1)
    expect(view.container).toHaveTextContent('~one~')
    const originalHighlight = highlighter.default
    vi.spyOn(highlighter, 'default').mockImplementation((...options) => originalHighlight({ ...options[0], plainText: ['js'] }))
    view.rerender(<Markdown text={text} />)
    expect(cost).toEqual({ parse: 3, highlight: 3 })
    expect(view.container.querySelector('.hljs-keyword')).toBeNull()
    expect(view.container.querySelector('code')).toHaveTextContent('const value = 1')
    expect(view.container.querySelectorAll('del')).toHaveLength(1)
  })

  it('keeps cached trees upstream of read-only filtering and browser navigation ownership', () => {
    const navigate = vi.fn()
    const text = '**bold** [link](https://example.test) ![alt](https://example.test/image.png)\n\n<i>raw</i>\n\n[unsafe](javascript:alert)'
    const frame = (readOnly: boolean) => (
      <BrowserNavigationContext.Provider value={navigate}>
        <Markdown text={text} readOnly={readOnly} />
      </BrowserNavigationContext.Provider>
    )
    const view = render(frame(false))
    expect(cost).toEqual({ parse: 1, highlight: 1 })
    fireEvent.click(view.getByRole('link', { name: 'link' }))
    expect(navigate).toHaveBeenCalledExactlyOnceWith('https://example.test')
    expect(view.container).toHaveTextContent('<i>raw</i>')
    expect(view.container.querySelectorAll('a')).toHaveLength(1)
    view.rerender(frame(true))
    expect(cost).toEqual({ parse: 1, highlight: 1 })
    expect(view.container.querySelector('a, img, [href], [src]')).toBeNull()
    expect(view.container).not.toHaveTextContent('<i>')
    expect(view.container.querySelector('strong')).toHaveTextContent('bold')
    view.rerender(frame(false))
    expect(cost).toEqual({ parse: 1, highlight: 1 })
    expect(view.container.querySelector('img')).toHaveAttribute('src', 'https://example.test/image.png')
    expect(view.container).toHaveTextContent('<i>raw</i>')
    fireEvent.click(view.getByRole('link', { name: 'link' }))
    expect(navigate).toHaveBeenCalledTimes(2)
  })

  it('reprojects history, static, read-only and reduced-motion modes without caching animation eligibility', () => {
    const view = render(<Markdown text="abc" revealMode="history" />)
    expect(view.container.querySelector('.screen-text-reveal-line-history')).toHaveTextContent('abc')
    expect(view.container.querySelector('.screen-text-reveal-live')).toBeNull()
    view.rerender(<Markdown text="abc" />)
    expect(view.container.querySelector('.screen-text-reveal-line')).toBeNull()
    view.rerender(<Markdown text="abc" revealMode="live" readOnly />)
    expect(view.container.querySelector('.screen-text-reveal-live')).toBeNull()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    view.rerender(<Markdown text="abc" revealMode="live" />)
    expect(view.container.querySelector('.screen-text-reveal-live')).toBeNull()
    expect(view.container.textContent).toBe('abc')
    expect(cost).toEqual({ parse: 1, highlight: 1 })
    expect(vi.getTimerCount()).toBe(0)
  })
})
