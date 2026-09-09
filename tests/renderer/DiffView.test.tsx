// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { DIFF_PAGE_SIZE, DiffView } from '../../src/renderer/src/features/review/DiffView'

const diff = (count: number) => Array.from({ length: count }, (_, index) => `+${index + 1} line-${index + 1}`).join('\n')

it('bounds the mounted rows of a large diff without dropping later content', () => {
  const count = DIFF_PAGE_SIZE * 3 + 2
  const { container } = render(<DiffView diff={diff(count)} dense />)
  expect(container.querySelectorAll('tr')).toHaveLength(DIFF_PAGE_SIZE)
  expect(screen.getByRole('group', { name: '差异分页' })).toHaveTextContent(`共 ${count} 行`)
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
  for (let page = 1; page < 4; page++) {
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(container.querySelectorAll('tr').length).toBeLessThanOrEqual(DIFF_PAGE_SIZE)
  }
  expect(container.querySelector('.diff-table-scroll')).toHaveTextContent(`line-${count}`)
  expect(container.querySelectorAll('tr')).toHaveLength(2)
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '上一页' }))
  expect(container.querySelectorAll('tr')).toHaveLength(DIFF_PAGE_SIZE)
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
