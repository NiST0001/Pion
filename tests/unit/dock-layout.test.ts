import { expect, it } from 'vitest'
import { defaultDockLayout, resizeDockSplit } from '../../src/renderer/src/utils/dockLayout'

it('preserves layout identity for unchanged effective ratios and missing split paths', () => {
  const layout = defaultDockLayout()
  expect(resizeDockSplit(layout, '', 0.2)).toBe(layout)
  expect(resizeDockSplit(layout, '10', 0.7)).toBe(layout)
  for (const path of ['0', '000', 'invalid']) expect(resizeDockSplit(layout, path, 0.4)).toBe(layout)
  for (const ratio of [NaN, Infinity, -Infinity]) expect(resizeDockSplit(layout, '', ratio)).toBe(layout)
  const minimum = resizeDockSplit(layout, '10', -10)
  expect(resizeDockSplit(minimum, '10', 0.08)).toBe(minimum)
  expect(resizeDockSplit(minimum, '10', -100)).toBe(minimum)
  const maximum = resizeDockSplit(layout, '10', 10)
  expect(resizeDockSplit(maximum, '10', 0.92)).toBe(maximum)
  expect(resizeDockSplit(maximum, '10', 100)).toBe(maximum)
})

it('copies only the ancestors of a changed split', () => {
  const layout = defaultDockLayout()
  const resized = resizeDockSplit(layout, '10', 0.3)
  expect(resized).not.toBe(layout)
  if (layout.root.type !== 'split' || resized.root.type !== 'split') throw new Error('expected root splits')
  expect(resized.root.first).toBe(layout.root.first)
  if (layout.root.second.type !== 'split' || resized.root.second.type !== 'split') throw new Error('expected nested splits')
  expect(resized.root.second.second).toBe(layout.root.second.second)
  expect(resized.root.second.first).not.toBe(layout.root.second.first)
  if (layout.root.second.first.type !== 'split' || resized.root.second.first.type !== 'split') throw new Error('expected resized splits')
  expect(resized.root.second.first.ratio).toBe(0.3)
  expect(resized.root.second.first.first).toBe(layout.root.second.first.first)
  expect(resized.root.second.first.second).toBe(layout.root.second.first.second)
})
