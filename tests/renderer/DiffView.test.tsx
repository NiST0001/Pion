// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { DIFF_PAGE_SIZE, DiffView } from '../../src/renderer/src/features/review/DiffView'

const diff = (count: number) => Array.from({ length: count }, (_, index) => `+${index + 1} line-${index + 1}`).join('\n')

it('bounds the mounted rows of a large diff without dropping later content', () => {
  const pageTotal = 17
  const count = DIFF_PAGE_SIZE * (pageTotal - 1) + 2
  const { container } = render(<DiffView diff={diff(count)} dense />)
  expect(container.querySelectorAll('tr')).toHaveLength(DIFF_PAGE_SIZE)
  expect(screen.getByRole('group', { name: '差异分页' })).toHaveTextContent(`共 ${count} 行`)
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
  for (let page = 1; page < pageTotal; page++) {
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(container.querySelectorAll('tr').length).toBeLessThanOrEqual(DIFF_PAGE_SIZE)
  }
  expect(container.querySelector('.diff-table-scroll')).toHaveTextContent(`line-${count}`)
  expect(container.querySelectorAll('tr')).toHaveLength(2)
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '上一页' }))
  expect(container.querySelectorAll('tr')).toHaveLength(DIFF_PAGE_SIZE)
})

it('preserves empty-line filtering, markers, gaps and line numbers', () => {
  const { container, rerender } = render(<DiffView diff={'\n+1 added\n\n-2 removed\n 3 context\n ...\n ....\n \n+9\nx42\n'} />)
  const rows = [...container.querySelectorAll('tr')]
  expect(rows.map((row) => [row.className, ...[...row.querySelectorAll('td')].map((cell) => cell.textContent)])).toEqual([
    ['diff-add', '1', '+', 'added'],
    ['diff-del', '2', '-', 'removed'],
    ['diff-ctx', '3', '', 'context'],
    ['diff-gap', '', '', '⋯'],
    ['diff-gap', '', '', '⋯'],
    ['diff-gap', '', '', '⋯'],
    ['diff-add', '', '+', '9'],
    ['diff-ctx', '', '', '42']
  ])
  rerender(<DiffView diff="" />)
  expect(container.querySelectorAll('tr')).toHaveLength(0)
})

it('indexes appended partial lines and trailing newlines and discards replaced indexes', () => {
  const prefix = `${diff(DIFF_PAGE_SIZE)}\n+121 tail`
  const { container, rerender } = render(<DiffView diff={prefix} />)
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  rerender(<DiffView diff={`${prefix} continued\n\n-122 removed\n`} />)
  expect(screen.getByRole('group', { name: '差异分页' })).toHaveTextContent('共 122 行')
  expect(container.querySelectorAll('tr')).toHaveLength(2)
  expect(container.querySelector('.diff-table-scroll')).toHaveTextContent('tail continued')
  rerender(<DiffView diff={`${prefix} continued\n\n-122 removed\n 123 context`} />)
  expect(screen.getByRole('group', { name: '差异分页' })).toHaveTextContent('共 123 行')
  expect(container.querySelectorAll('tr')).toHaveLength(3)
  expect(container.querySelector('.diff-table-scroll')).toHaveTextContent('context')
  rerender(<DiffView diff={`${diff(DIFF_PAGE_SIZE)}\n-999 replacement\n`} />)
  expect(screen.getByRole('group', { name: '差异分页' })).toHaveTextContent('共 121 行')
  expect(container.querySelectorAll('tr')).toHaveLength(1)
  expect(container.querySelector('.diff-del')).toHaveTextContent('replacement')
})

it('preserves the selected page on append and clamps it when the diff shrinks', () => {
  const { container, rerender } = render(<DiffView diff={diff(DIFF_PAGE_SIZE * 2)} dense />)
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  const scroller = container.querySelector('.diff-table-scroll') as HTMLElement
  scroller.scrollTop = 80
  rerender(<DiffView diff={diff(DIFF_PAGE_SIZE * 3)} dense />)
  expect(screen.getByRole('group', { name: '差异分页' })).toHaveTextContent('第 2 / 3 页')
  expect(scroller.scrollTop).toBe(80)
  rerender(<DiffView diff={diff(2)} dense />)
  expect(screen.queryByRole('group', { name: '差异分页' })).not.toBeInTheDocument()
  expect(container.querySelectorAll('tr')).toHaveLength(2)
  rerender(<DiffView diff={diff(DIFF_PAGE_SIZE * 3)} dense />)
  expect(screen.getByRole('group', { name: '差异分页' })).toHaveTextContent('第 1 / 3 页')
})
