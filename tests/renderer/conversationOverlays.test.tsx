// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useConversationOverlays } from '../../src/renderer/src/hooks/useConversationOverlays'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('measures overlay clearance, keeps child identity, and ignores expanded detail height', () => {
  let measure = () => {}
  const observe = vi.fn()
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { measure = callback }
    observe = observe
    disconnect = disconnect
  })
  let composerHeight = 100
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.className === 'composer-dock' ? composerHeight : this.className === 'run-metrics-strip' ? 32 : 300
  })
  function Harness({ metrics = true, expanded = false }) {
    const ref = useConversationOverlays(metrics)
    return <div ref={ref} data-testid="shell">
      {metrics && <section className="run-metrics-strip">summary{expanded && <div className="run-metrics-detail">detail</div>}</section>}
      <div className="chat-stage">history</div>
      <div className="composer-dock"><textarea defaultValue="draft" /></div>
    </div>
  }
  const view = render(<Harness />)
  const shell = view.getByTestId('shell')
  const textarea = shell.querySelector('textarea')
  expect(shell.style.getPropertyValue('--conversation-top-clearance')).toBe('38px')
  expect(shell.style.getPropertyValue('--conversation-bottom-clearance')).toBe('100px')
  expect(observe).toHaveBeenCalledTimes(2)
  view.rerender(<Harness expanded />)
  act(() => measure())
  expect(shell.style.getPropertyValue('--conversation-top-clearance')).toBe('38px')
  composerHeight = 180
  act(() => measure())
  expect(shell.style.getPropertyValue('--conversation-bottom-clearance')).toBe('180px')
  view.rerender(<Harness metrics={false} />)
  expect(shell.style.getPropertyValue('--conversation-top-clearance')).toBe('0px')
  expect(shell.querySelector('textarea')).toBe(textarea)
  expect(textarea?.value).toBe('draft')
  view.unmount()
  expect(disconnect).toHaveBeenCalled()
})
