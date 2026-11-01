import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/src/styles.css'
import type { GitFileDiff } from '../../src/shared/types'
import type { ToolItem } from '../../src/renderer/src/agent/types'
import { GitDiffView } from '../../src/renderer/src/features/review/GitDiffView'
import { DiffView } from '../../src/renderer/src/features/review/DiffView'
import { ToolCallItem } from '../../src/renderer/src/features/chat/ToolCallItem'
import { ReviewRevealText } from '../../src/renderer/src/features/review/ReviewRevealText'
import { watchLineReveals } from '../../src/renderer/src/utils/lineReveal'

// ToolCallItem renders this same DiffView; keep the direct fixture import explicit.
export { DiffView }

const scenarios = ['git-many-lines', 'tool-many-lines', 'tool-single-line', 'review-single-line'] as const
type Scenario = typeof scenarios[number]
type State = { scenario: Scenario; open: boolean; generation: number }
type Profile = {
  prepare: (scenario: string) => Promise<void>
  open: () => void
  scroll: (fraction: number) => void
  close: () => void
  snapshot: () => object
  scenarios: string[]
}
declare global { interface Window { __PION_RENDER_PROFILE__?: Profile } }

// Deterministic, synthetic data; lengths are UTF-16 code units. Unicode stays in BMP.
const single = 'synthetic 渲染 data 0123456789 abcdefghijklmnopqrstuvwxyz '.repeat(6000).slice(0, 262144)
const lines = Array.from({ length: 2400 }, (_, index) =>
  `line ${String(index + 1).padStart(4, '0')} 渲染 ${'abcdefghijklmnopqrstuvwxyz0123456789 '.repeat(3)}`.slice(0, 90))
const gitDiff: GitFileDiff = {
  snapshotId: 'synthetic', path: 'synthetic/profile.txt', scope: 'unstaged', binary: false,
  additions: 1200, deletions: 1200, selectable: true, rawPatch: '',
  hunks: [{
    id: 'synthetic-hunk', header: '@@ -1,1200 +1,1200 @@', oldStart: 1, oldLines: 1200,
    newStart: 1, newLines: 1200,
    lines: lines.map((text, index) => ({
      id: `line-${index}`, kind: index % 2 ? 'add' : 'delete', text,
      ...(index % 2 ? { newLine: Math.floor(index / 2) + 1 } : { oldLine: Math.floor(index / 2) + 1 })
    }))
  }]
}
const manyDiff = lines.map((text, index) => `${index % 2 ? '+' : '-'}${Math.floor(index / 2) + 1} ${text}`).join('\n')
const tools: Record<'tool-many-lines' | 'tool-single-line', ToolItem> = {
  'tool-many-lines': { id: 'synthetic-many', name: 'edit', status: 'done', isError: false, path: 'synthetic/many.txt', diff: manyDiff },
  'tool-single-line': { id: 'synthetic-single', name: 'edit', status: 'done', isError: false, path: 'synthetic/single.txt', diff: `+1 ${single}` }
}
const selected = new Set<string>()
const noop = (): void => {}
const twoFrames = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

function App() {
  const [state, setState] = useState<State>({ scenario: scenarios[0], open: false, generation: 0 })
  const stateRef = useRef(state)
  stateRef.current = state
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLElement>(null)
  const generation = useRef(0)
  const scrollPlan = useRef<{ target: HTMLElement; distance: number; vertical: boolean } | null>(null)
  const toolScenario = state.scenario === 'tool-many-lines' || state.scenario === 'tool-single-line'

  useLayoutEffect(() => {
    if (toolScenario && scrollRef.current) return watchLineReveals(scrollRef.current)
  }, [state.generation, toolScenario])

  useEffect(() => {
    const prepare = async (scenario: string): Promise<void> => {
      if (!scenarios.includes(scenario as Scenario)) throw new Error('Unknown profile scenario')
      const ticket = ++generation.current
      scrollPlan.current = null
      flushSync(() => setState({ scenario: scenario as Scenario, open: false, generation: ticket }))
      await twoFrames()
      if (ticket !== generation.current) throw new Error('Profile preparation superseded')
    }
    const open = (): void => {
      scrollPlan.current = null
      if (stateRef.current.scenario.startsWith('tool-')) {
        const button = rootRef.current?.querySelector<HTMLButtonElement>('.tool-head')
        if (!button) throw new Error('Tool header unavailable')
        if (button.getAttribute('aria-expanded') !== 'true') flushSync(() => button.click())
      } else {
        flushSync(() => setState(previous => ({ ...previous, open: true })))
      }
    }
    const close = (): void => {
      const ticket = ++generation.current
      scrollPlan.current = null
      // A fresh keyed tool unmounts the disclosure, its observers and timers.
      flushSync(() => setState(previous => ({ ...previous, open: false, generation: ticket })))
    }
    const scroll = (fraction: number): void => {
      if (!Number.isFinite(fraction)) throw new Error('Invalid scroll fraction')
      const outer = scrollRef.current
      if (!outer) return
      if (!scrollPlan.current || !scrollPlan.current.target.isConnected) {
        const inner = outer.querySelector<HTMLElement>('.diff-table-scroll')
        const target = inner && (inner.scrollHeight > inner.clientHeight || inner.scrollWidth > inner.clientWidth) ? inner : outer
        const vertical = Math.max(0, target.scrollHeight - target.clientHeight)
        scrollPlan.current = { target, vertical: vertical > 0,
          distance: vertical || Math.max(0, target.scrollWidth - target.clientWidth) }
      }
      const { target, vertical, distance } = scrollPlan.current
      const position = Math.max(0, Math.min(1, fraction)) * distance
      if (vertical) target.scrollTop = position
      else target.scrollLeft = position
    }
    const snapshot = (): object => {
      const root = scrollRef.current
      if (!root) return { nodes: 0, elements: 0, textLength: 0, chars: 0, pending: 0, rows: 0, scrollHeight: 0, viewport: 0, visibility: 'unavailable' }
      let nodes = 0, textLength = 0
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL)
      while (walker.nextNode()) {
        nodes++
        if (walker.currentNode.nodeType === Node.TEXT_NODE) textLength += walker.currentNode.nodeValue?.length ?? 0
      }
      const inner = root.querySelector<HTMLElement>('.diff-table-scroll')
      const target = inner && (inner.scrollHeight > inner.clientHeight || inner.scrollWidth > inner.clientWidth) ? inner : root
      const viewportRect = root.getBoundingClientRect()
      const viewport = { top: viewportRect.top + root.clientTop, left: viewportRect.left + root.clientLeft,
        bottom: viewportRect.top + root.clientTop + root.clientHeight, right: viewportRect.left + root.clientLeft + root.clientWidth }
      const styles = new Map<HTMLElement, CSSStyleDeclaration>()
      const visible = (element: HTMLElement): boolean => {
        const rect = element.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        let top = Math.max(0, viewport.top), bottom = Math.min(innerHeight, viewport.bottom)
        let left = Math.max(0, viewport.left), right = Math.min(innerWidth, viewport.right)
        for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
          if (parent.hidden || parent.getAttribute('aria-hidden') === 'true') return false
          let style = styles.get(parent)
          if (!style) { style = getComputedStyle(parent); styles.set(parent, style) }
          if (style.display === 'none' || /^(hidden|collapse)$/.test(style.visibility)) return false
          if (parent === element) continue
          const clipX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX || style.overflow)
          const clipY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY || style.overflow)
          if (clipX || clipY) {
            const bounds = parent.getBoundingClientRect()
            const contentLeft = bounds.left + parent.clientLeft, contentTop = bounds.top + parent.clientTop
            if (clipX) { left = Math.max(left, contentLeft); right = Math.min(right, contentLeft + parent.clientWidth) }
            if (clipY) { top = Math.max(top, contentTop); bottom = Math.min(bottom, contentTop + parent.clientHeight) }
          }
        }
        return right > left && bottom > top && rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom
      }
      const visiblePending = [...root.querySelectorAll<HTMLElement>('[data-text-reveal-pending="true"]')].filter(visible)
      const details = visiblePending.slice(0, 6).map(element => {
        const parents = []
        for (let node: HTMLElement | null = element; node && parents.length < 9; node = node.parentElement) {
          const rect = node.getBoundingClientRect(), style = getComputedStyle(node)
          parents.push({ tag: node.tagName, class: node.className.slice(0, 100),
            ready: node.dataset.lineRevealReady, start: node.dataset.lineRevealStart, textReady: node.dataset.textRevealReady,
            rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
            client: { left: node.clientLeft, top: node.clientTop, width: node.clientWidth, height: node.clientHeight },
            overflow: [style.overflowX, style.overflowY], visibility: style.visibility, opacity: style.opacity })
        }
        return parents
      })
      return {
        nodes, elements: root.querySelectorAll('*').length, textLength,
        chars: root.querySelectorAll('[data-screen-reveal-character]').length,
        pending: root.querySelectorAll('[data-text-reveal-pending="true"]').length,
        visiblePending: visiblePending.length, visiblePendingDetails: details,
        visiblePendingLines: [...root.querySelectorAll<HTMLElement>('.screen-text-reveal-line:not([data-line-reveal-ready="true"])')].filter(visible).length,
        rows: root.querySelectorAll('tr').length,
        scrollHeight: target.scrollHeight, scrollWidth: target.scrollWidth,
        scrollTop: target.scrollTop, scrollLeft: target.scrollLeft, viewport: target.clientHeight, viewportWidth: target.clientWidth,
        visibility: getComputedStyle(root).visibility
      }
    }
    const api: Profile = { prepare, open, scroll, close, snapshot, scenarios: [...scenarios] }
    window.__PION_RENDER_PROFILE__ = api
    return () => { if (window.__PION_RENDER_PROFILE__ === api) delete window.__PION_RENDER_PROFILE__ }
  }, [])

  return <div className="profile-shell" ref={rootRef}>
    <header className="profile-controls">
      <h1>Pion isolated renderer profile</h1>
      <div className="profile-scenarios" role="group" aria-label="Profile scenario">
        {scenarios.map(scenario => <button key={scenario} type="button" aria-pressed={state.scenario === scenario}
          onClick={() => { void window.__PION_RENDER_PROFILE__?.prepare(scenario) }}>{scenario}</button>)}
      </div>
      <button type="button" onClick={() => window.__PION_RENDER_PROFILE__?.open()}>Open</button>
      <button type="button" onClick={() => window.__PION_RENDER_PROFILE__?.close()}>Close / reset</button>
    </header>
    {toolScenario ? <main key={state.generation} ref={scrollRef} className="chat-scroll profile-viewport" data-line-reveal-owner="true" data-line-reveal-scope="synthetic">
      <div className="chat-scroll-surface"><div className="timeline">
        <ToolCallItem tool={tools[state.scenario as keyof typeof tools]} historical readOnly />
      </div></div>
    </main> : <main key={state.generation} ref={scrollRef} className="review-detail-body profile-viewport">
      {state.open && (state.scenario === 'git-many-lines'
        ? <GitDiffView diff={gitDiff} action="stage" selectedLineIds={selected} disabled={false} onToggleLine={noop} onApplyHunk={noop} />
        : <div className="profile-wrapped"><ReviewRevealText text={single} /></div>)}
    </main>}
  </div>
}

const mount = document.getElementById('root')
if (!mount) throw new Error('Profile root missing')
createRoot(mount).render(<App />)
