// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { useConversationOverlays } from '../../src/renderer/src/hooks/useConversationOverlays'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('measures overlay clearance, keeps child identity, and ignores expanded detail height', () => {
  let measure = () => {}
  const observe = vi.fn()
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { measure = callback }
    observe = observe
    unobserve = vi.fn()
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
  expect(shell.style.getPropertyValue('--conversation-interaction-bottom-clearance')).toBe('100px')
  expect(observe).toHaveBeenCalledTimes(2)
  view.rerender(<Harness expanded />)
  act(() => measure())
  expect(shell.style.getPropertyValue('--conversation-top-clearance')).toBe('38px')
  composerHeight = 180
  act(() => measure())
  expect(shell.style.getPropertyValue('--conversation-bottom-clearance')).toBe('180px')
  expect(shell.style.getPropertyValue('--conversation-interaction-bottom-clearance')).toBe('180px')
  view.rerender(<Harness metrics={false} />)
  expect(shell.style.getPropertyValue('--conversation-top-clearance')).toBe('0px')
  expect(shell.querySelector('textarea')).toBe(textarea)
  expect(textarea?.value).toBe('draft')
  view.unmount()
  expect(disconnect).toHaveBeenCalled()
})

// Non-zero page coordinates catch accidental viewport-height or height-sum math.
// In production the support row floats 8px above the normal composer boundary.
function mockSupportGeometry() {
  const observers: Array<{ targets: Set<Element>; callback: () => void; disconnect: ReturnType<typeof vi.fn> }> = []
  vi.stubGlobal('ResizeObserver', class {
    targets = new Set<Element>()
    disconnect = vi.fn(() => this.targets.clear())
    constructor(public callback: () => void) { observers.push(this) }
    observe = (target: Element) => { this.targets.add(target) }
    unobserve = (target: Element) => { this.targets.delete(target) }
  })
  let supportHeight = 64
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 600)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('composer-dock')) return 100
    if (this.classList.contains('composer-support-row')) return supportHeight
    return 0
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const bottom = this.classList.contains('composer-support-row') ? 692 : 800
    const height = this.classList.contains('composer-support-row') ? supportHeight
      : this.classList.contains('composer-dock') ? 100 : 600
    return { x: 40, y: bottom - height, top: bottom - height, bottom, left: 40, right: 640, width: 600, height, toJSON() {} }
  })
  return {
    observers,
    isObserved: (target: Element) => observers.some(observer => observer.targets.has(target)),
    resize: (target: Element) => act(() => {
      for (const observer of observers) if (observer.targets.has(target)) observer.callback()
    }),
    setHeight: (height: number) => { supportHeight = height },
  }
}

function SupportHarness({ task = false, queue = false, hidden = false, ariaHidden = false }) {
  const ref = useConversationOverlays(false, true)
  return <div ref={ref} data-testid="shell">
    <div className="chat-stage">history</div>
    <div className="composer-dock">
      <div data-testid="support-parent" hidden={hidden} aria-hidden={ariaHidden || undefined}>
        {(task || queue) && <div className="composer-support-row">
          {task && <section data-testid="task">task</section>}
          {queue && <section data-testid="queue">queue</section>}
        </div>}
      </div>
      <div className="composer-input-scroll"><textarea defaultValue="draft" /></div>
    </div>
  </div>
}

it('uses the support-row top including its 8px gap and expanded height, without increasing chat clearance', () => {
  const geometry = mockSupportGeometry()
  const view = render(<SupportHarness task queue />)
  const shell = view.getByTestId('shell')
  const support = shell.querySelector('.composer-support-row')!
  const draft = shell.querySelector('textarea')!
  draft.value = 'unsent edit'
  expect(shell.style.getPropertyValue('--conversation-bottom-clearance')).toBe('100px')
  expect(shell.style.getPropertyValue('--conversation-interaction-bottom-clearance')).toBe('172px')
  expect(geometry.isObserved(support)).toBe(true)
  expect(geometry.isObserved(view.getByTestId('task'))).toBe(true)
  expect(geometry.isObserved(view.getByTestId('queue'))).toBe(true)
  geometry.setHeight(224)
  geometry.resize(view.getByTestId('task'))
  expect(shell.style.getPropertyValue('--conversation-interaction-bottom-clearance')).toBe('332px')
  expect(shell.style.getPropertyValue('--conversation-bottom-clearance')).toBe('100px')
  expect(shell.querySelector('textarea')).toBe(draft)
  expect(draft.value).toBe('unsent edit')
})

it('discovers task/queue rows and children added later and releases removed targets and observers', async () => {
  const geometry = mockSupportGeometry()
  const mutationDisconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
  const view = render(<SupportHarness />)
  const shell = view.getByTestId('shell')
  const composer = shell.querySelector('.composer-dock')!
  const draft = shell.querySelector('textarea')!
  draft.value = 'keep draft'
  expect(shell.style.getPropertyValue('--conversation-interaction-bottom-clearance')).toBe('100px')
  await act(async () => { view.rerender(<SupportHarness task />) })
  const firstRow = shell.querySelector('.composer-support-row')!
  const task = view.getByTestId('task')
  expect(geometry.isObserved(firstRow)).toBe(true)
  expect(geometry.isObserved(task)).toBe(true)
  expect(shell.style.getPropertyValue('--conversation-interaction-bottom-clearance')).toBe('172px')
  await act(async () => { view.rerender(<SupportHarness queue />) })
  const queue = view.getByTestId('queue')
  expect(geometry.isObserved(task)).toBe(false)
  expect(geometry.isObserved(queue)).toBe(true)
  geometry.setHeight(120)
  geometry.resize(queue)
  expect(shell.style.getPropertyValue('--conversation-interaction-bottom-clearance')).toBe('228px')
  await act(async () => { view.rerender(<SupportHarness />) })
  expect(geometry.isObserved(firstRow)).toBe(false)
  expect(geometry.isObserved(queue)).toBe(false)
  expect(shell.style.getPropertyValue('--conversation-interaction-bottom-clearance')).toBe('100px')
  await act(async () => { view.rerender(<SupportHarness queue />) })
  const nextRow = shell.querySelector('.composer-support-row')!
  expect(nextRow).not.toBe(firstRow)
  expect(geometry.isObserved(nextRow)).toBe(true)
  expect(shell.querySelector('.composer-dock')).toBe(composer)
  expect(shell.querySelector('textarea')).toBe(draft)
  expect(draft.value).toBe('keep draft')
  view.unmount()
  expect(geometry.observers.every(observer => observer.disconnect.mock.calls.length > 0)).toBe(true)
  expect(mutationDisconnect).toHaveBeenCalled()
  const observerCount = geometry.observers.length
  // A disconnected MutationObserver must not rebind detached composer children.
  await act(async () => { composer.appendChild(document.createElement('section')) })
  expect(geometry.observers).toHaveLength(observerCount)
  expect(geometry.observers.every(observer => observer.targets.size === 0)).toBe(true)
})

it.each(['hidden', 'aria-hidden'] as const)('ignores %s support ancestors and restores clearance without replacing drafts', async attribute => {
  const geometry = mockSupportGeometry()
  const view = render(<SupportHarness task />)
  const shell = view.getByTestId('shell')
  const draft = shell.querySelector('textarea')!
  const parent = view.getByTestId('support-parent')
  const support = shell.querySelector('.composer-support-row')!
  draft.value = 'hidden-view draft'
  expect(shell.style.getPropertyValue('--conversation-interaction-bottom-clearance')).toBe('172px')
  await act(async () => { parent.setAttribute(attribute, attribute === 'hidden' ? '' : 'true') })
  // Stale non-zero rects from a retained child view must not reserve space.
  expect(shell.style.getPropertyValue('--conversation-interaction-bottom-clearance')).toBe('100px')
  expect(shell.style.getPropertyValue('--conversation-bottom-clearance')).toBe('100px')
  await act(async () => { parent.removeAttribute(attribute) })
  expect(shell.style.getPropertyValue('--conversation-interaction-bottom-clearance')).toBe('172px')
  expect(geometry.isObserved(support)).toBe(true)
  await act(async () => { support.classList.remove('composer-support-row') })
  expect(shell.style.getPropertyValue('--conversation-interaction-bottom-clearance')).toBe('100px')
  expect(geometry.isObserved(support)).toBe(false)
  await act(async () => { support.classList.add('composer-support-row') })
  expect(shell.style.getPropertyValue('--conversation-interaction-bottom-clearance')).toBe('172px')
  expect(geometry.isObserved(support)).toBe(true)
  expect(shell.querySelector('textarea')).toBe(draft)
  expect(draft.value).toBe('hidden-view draft')
})

it('bounds a real support row in a tiny dock instead of hiding the interaction header', async () => {
  let measure = () => {}
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { measure = callback }
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 120)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => 150)
  const composerHeight = (element: HTMLElement) => element.closest('.has-compact-interactions')
    ? Number.parseFloat((element.closest('[data-testid="shell"]') as HTMLElement)
      .style.getPropertyValue('--conversation-composer-max-height')) : 100
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('composer-dock') ? composerHeight(this) : 0
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const composer = this.closest('.composer-dock') as HTMLElement | null
    const inputHeight = composer ? composerHeight(composer) : 0
    const supportHeight = this.closest('.has-compact-support') ? 28 : 64
    const bottom = this.classList.contains('composer-support-row') ? 320 - inputHeight - 8 : 320
    const height = this.classList.contains('composer-support-row') ? supportHeight
      : this.classList.contains('composer-dock') ? inputHeight : 120
    return new DOMRect(40, bottom - height, 600, height)
  })
  function TinyHarness() {
    const ref = useConversationOverlays(false, true)
    return <div ref={ref} data-testid="shell"><div className="composer-dock">
      <div className="composer-support-row"><section>task</section><section>queue</section></div>
      <div className="composer-input-scroll"><textarea defaultValue="draft" /></div>
    </div></div>
  }
  const view = render(<TinyHarness />)
  const shell = view.getByTestId('shell')
  expect(shell.querySelector('.composer-support-row')?.parentElement).toHaveClass('composer-dock')
  await act(async () => { measure() }) // Actual CSS resize follows initial class application.
  expect(shell).toHaveClass('has-compact-support', 'has-compact-interactions')
  expect(shell.style.getPropertyValue('--conversation-support-max-height')).toBe('28px')
  expect(shell.style.getPropertyValue('--conversation-composer-max-height')).toBe('4px')
  expect(shell.style.getPropertyValue('--conversation-interaction-bottom-clearance')).toBe('40px')
  // 120px shell - 40px real bottom extent - 28px stack margins = 52px header.
  expect(120 - 40 - 28).toBeGreaterThanOrEqual(48)
  expect(shell.querySelector('textarea')).toHaveValue('draft')
  const css = readFileSync('src/renderer/src/styles/extension-ui.css', 'utf8')
  expect(css).toContain('.conversation-shell.has-compact-support > .composer-dock > .composer-support-row')
  expect(css).toContain('max-height: var(--conversation-support-max-height)')
})

it('keeps an interaction header reachable in a short dock without replacing the composer', () => {
  let measure = () => {}
  let height = 120
  let naturalComposerHeight = 150
  const observe = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { measure = callback }
    observe = observe
    unobserve = vi.fn()
    disconnect() {}
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('composer-input-scroll') ? naturalComposerHeight : 1_000
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains('composer-dock')) return 0
    return this.parentElement?.classList.contains('has-compact-interactions')
      ? Math.min(naturalComposerHeight, height - 80) : naturalComposerHeight
  })
  function Harness({ pending = true }) {
    const ref = useConversationOverlays(false, pending)
    return <div ref={ref} data-testid="shell"><div className="composer-dock">
      <div className="composer-support-row"><button>排队操作</button></div>
      <div className="composer-input-scroll"><textarea defaultValue="draft" /></div>
    </div></div>
  }
  const view = render(<Harness />)
  const shell = view.getByTestId('shell')
  const draft = shell.querySelector('textarea')
  const support = shell.querySelector('.composer-support-row')!
  expect(support.parentElement).toHaveClass('composer-dock')
  expect(support.closest('.composer-input-scroll')).toBeNull()
  expect(observe).toHaveBeenCalledWith(shell)
  expect(shell).toHaveClass('has-compact-interactions')
  expect(shell.style.getPropertyValue('--conversation-bottom-clearance')).toBe('40px')
  act(() => measure())
  expect(shell).toHaveClass('has-compact-interactions')
  height = 600
  act(() => measure())
  expect(shell).not.toHaveClass('has-compact-interactions')
  height = 120
  act(() => measure())
  naturalComposerHeight = 32
  act(() => measure())
  expect(shell).not.toHaveClass('has-compact-interactions')
  naturalComposerHeight = 150
  act(() => measure())
  view.rerender(<Harness pending={false} />)
  expect(shell).not.toHaveClass('has-compact-interactions')
  expect(shell.querySelector('textarea')).toBe(draft)
  expect(draft?.value).toBe('draft')
  const css = readFileSync('src/renderer/src/styles/extension-ui.css', 'utf8')
  const stack = css.match(/\.session-interaction-panels\s*\{([^}]*)\}/)?.[1] ?? ''
  expect(stack).toContain('bottom: calc(var(--conversation-interaction-bottom-clearance, var(--conversation-bottom-clearance, 0px)) + 14px)')
  expect(css).toContain('.conversation-shell.has-compact-interactions > .composer-dock > .composer-input-scroll')
  expect(css).toContain('max-height: var(--conversation-composer-max-height)')
  expect(css).not.toMatch(/\.composer-dock\s*\{[^}]*overflow-y:\s*auto/)
  expect(shell.style.getPropertyValue('--conversation-composer-max-height')).toBe('40px')
})
