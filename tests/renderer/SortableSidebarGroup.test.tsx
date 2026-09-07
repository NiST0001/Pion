// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import { moveSidebarKey, orderedKeys, SortableSidebarGroup } from '../../src/renderer/src/features/project/SortableSidebarGroup'

beforeEach(() => localStorage.clear())

it('keeps hidden keys and appends new items while ignoring deleted keys', () => {
  expect(orderedKeys(['a', 'b', 'c'], ['gone', 'b', 'a'])).toEqual(['b', 'a', 'c'])
  expect(moveSidebarKey(['a', 'hidden', 'b'], 'b', 'a')).toEqual(['b', 'a', 'hidden'])
  expect(moveSidebarKey(['a', 'b'], 'foreign', 'a')).toEqual(['a', 'b'])
})

it.each(['project', 'branch'] as const)('persists %s header order across remounts', (kind) => {
  const scope = kind === 'project' ? 'projects' : 'branches:/project'
  const ui = <SortableSidebarGroup scope={scope} kind={kind} items={['a', 'b']}
    allKeys={['a', 'b']} getKey={(item) => item}>
    {(item) => <div draggable data-sidebar-drag-kind={kind}>{item}</div>}
  </SortableSidebarGroup>
  const { container, unmount } = render(ui)
  const data = new Map<string, string>()
  const dataTransfer = {
    types: ['application/x-pion-sidebar-order'],
    setData: (key: string, value: string) => data.set(key, value),
    getData: (key: string) => data.get(key) ?? ''
  }
  fireEvent.dragStart(screen.getByText('b'), { dataTransfer })
  fireEvent.dragOver(screen.getByText('a'), { dataTransfer })
  fireEvent.drop(screen.getByText('a'), { dataTransfer })
  expect([...container.querySelectorAll('[draggable]')].map((node) => node.textContent)).toEqual(['b', 'a'])
  unmount()
  const reopened = render(ui)
  expect([...reopened.container.querySelectorAll('[draggable]')].map((node) => node.textContent)).toEqual(['b', 'a'])
})
