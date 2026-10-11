// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserNavigationContext } from '../../src/renderer/src/features/browser/BrowserNavigationContext'
import { Markdown } from '../../src/renderer/src/features/chat/Markdown'
import { BROWSER_URL_MAX_LENGTH } from '../../src/shared/browser'

// DOM-only tests: the provider is a routing stub, never an Electron guest.
function setup(text: string, readOnly = false) {
  const navigate = vi.fn()
  const view = render(
    <BrowserNavigationContext.Provider value={navigate}>
      <Markdown text={text} readOnly={readOnly} />
    </BrowserNavigationContext.Provider>
  )
  return { ...view, navigate }
}

function activate(link: HTMLElement, type = 'click', init: MouseEventInit = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })
  fireEvent(link, event)
  return event
}

describe('Markdown browser links', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('routes GitHub repository and release links internally while retaining copyable hrefs', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const urls = ['https://github.com/NiST0001/Pion', 'https://github.com/NiST0001/Pion/releases']
    const { navigate } = setup(`[项目](${urls[0]})\n\n[发布](${urls[1]})`)
    const links = screen.getAllByRole('link')
    links.forEach((link, index) => {
      expect(link).toHaveAttribute('href', urls[index])
      expect(link).not.toHaveAttribute('target')
      expect(activate(link).defaultPrevented).toBe(true)
      expect(navigate).toHaveBeenNthCalledWith(index + 1, urls[index])
    })
    expect(navigate).toHaveBeenCalledTimes(2)
    expect(open).not.toHaveBeenCalled()
  })

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }])(
    'keeps modified clicks internal and prevents native navigation: %j', (modifier) => {
      const { navigate } = setup('[链接](https://example.test/path)')
      const link = screen.getByRole('link', { name: '链接' })
      expect(activate(link, 'click', modifier).defaultPrevented).toBe(true)
      expect(navigate).toHaveBeenCalledExactlyOnceWith('https://example.test/path')
    }
  )

  it('routes middle auxiliary clicks once, blocks other auxiliary navigation, and leaves copy-link context menus intact', () => {
    const { navigate } = setup('[链接](https://example.test/path)')
    const link = screen.getByRole('link')
    expect(activate(link, 'auxclick', { button: 1 }).defaultPrevented).toBe(true)
    expect(navigate).toHaveBeenCalledExactlyOnceWith('https://example.test/path')
    expect(activate(link, 'auxclick', { button: 2 }).defaultPrevented).toBe(true)
    expect(activate(link, 'contextmenu', { button: 2 }).defaultPrevented).toBe(false)
    expect(navigate).toHaveBeenCalledTimes(1)
  })

  it('accepts native keyboard-generated clicks and repeated activation of the same URL', () => {
    const { navigate } = setup('[链接](https://example.test/path)')
    const link = screen.getByRole('link')
    // Browsers activate anchors with a button-zero, detail-zero click on Enter.
    // jsdom does not implement that keyboard default action.
    expect(activate(link, 'click', { detail: 0 }).defaultPrevented).toBe(true)
    expect(activate(link).defaultPrevented).toBe(true)
    expect(navigate.mock.calls).toEqual([['https://example.test/path'], ['https://example.test/path']])
  })

  it('fails closed without a provider instead of opening a window', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<Markdown text="[链接](https://example.test/path)" />)
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', 'https://example.test/path')
    expect(link).not.toHaveAttribute('target')
    expect(activate(link).defaultPrevented).toBe(true)
    expect(activate(link, 'auxclick', { button: 1 }).defaultPrevented).toBe(true)
    expect(open).not.toHaveBeenCalled()
  })

  it.each([
    'about:blank', 'mailto:user@example.test', 'file:///tmp/example', 'javascript:alert',
    '/relative', '../relative', '//example.test/path',
    'https://user:secret@example.test/path', 'https://@example.test/path',
    `https://example.test/${'x'.repeat(BROWSER_URL_MAX_LENGTH)}`
  ])('renders rejected URL as non-navigable text: %s', (url) => {
    const { navigate, container } = setup(`[保留标签](${url})`)
    expect(container).toHaveTextContent('保留标签')
    expect(container.querySelector('a, [href]')).toBeNull()
    fireEvent.click(screen.getByText('保留标签'))
    expect(navigate).not.toHaveBeenCalled()
  })

  it('preserves read-only formatting and text labels without mounting navigation, images or HTML', () => {
    const { navigate, container } = setup(
      '**格式** [链接](https://example.test/path)\n\nhttps://github.com/NiST0001/Pion\n\n'
        + '![图片描述](https://example.test/image.png)\n\n<img src="https://example.test/raw.png" />',
      true
    )
    expect(container.querySelector('strong')).toHaveTextContent('格式')
    expect(container).toHaveTextContent('图片描述')
    expect(container).toHaveTextContent('https://github.com/NiST0001/Pion')
    expect(container.querySelector('a, img, [href], [src]')).toBeNull()
    fireEvent.click(screen.getByText('链接'))
    expect(navigate).not.toHaveBeenCalled()
  })
})
