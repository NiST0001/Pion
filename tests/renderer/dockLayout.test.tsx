// @vitest-environment jsdom
import { useEffect } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { DOCK_PANELS, moveDockPanel, normalizeDockLayout } from '../../src/renderer/src/utils/dockLayout'
import { useDockLayout } from '../../src/renderer/src/hooks/useDockLayout'
import { DockHeader } from '../../src/renderer/src/features/chrome/DockHeader'

beforeEach(() => localStorage.clear())
it('validates saved layouts and swaps occupied slots without losing modules', () => {
  const initial = normalizeDockLayout(null)
  const moved = moveDockPanel(initial, 'chat', 'bottom')
  expect(moved.slots.chat).toBe('bottom')
  expect(moved.slots.terminal).toBe('center')
  expect(new Set(Object.values(moved.slots)).size).toBe(4)
  expect(normalizeDockLayout({ slots: { projects: 'left', chat: 'left' }, left: Infinity })).toEqual(initial)
})

it('moves modules with the keyboard-accessible selector without remounting content', () => {
  const mounted = vi.fn()
  function Content() { useEffect(() => { mounted() }, []); return <input aria-label="draft" defaultValue="retained draft" /> }
  function Workspace() {
    const dock = useDockLayout({ projects: true, chat: true, review: true, terminal: true })
    return <div ref={dock.rootRef} style={dock.rootStyle}>
      {DOCK_PANELS.map((panel) => <div key={panel} {...dock.panelProps(panel)}>
        <DockHeader title={panel} slot={dock.layout.slots[panel]} onMove={(slot) => dock.movePanel(panel, slot)} dragProps={dock.dragProps(panel)} />
        {panel === 'chat' && <Content />}
      </div>)}
    </div>
  }
  const { container, unmount } = render(<Workspace />)
  fireEvent.change(screen.getByLabelText('chat停靠位置'), { target: { value: 'bottom' } })
  expect((container.querySelector('[data-dock-panel="chat"]') as HTMLElement).style.gridArea).toBe('bottom')
  expect(mounted).toHaveBeenCalledTimes(1)
  expect((screen.getByLabelText('draft') as HTMLInputElement).value).toBe('retained draft')
  unmount()
  const reopened = render(<Workspace />)
  expect((reopened.container.querySelector('[data-dock-panel="chat"]') as HTMLElement).style.gridArea).toBe('bottom')
})
