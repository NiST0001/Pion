import { expect, it, vi } from 'vitest'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { askUserTool } from '../../src/main/agent/ask-user'

function context(hasUI = true) {
  const ui = { select: vi.fn<ExtensionContext['ui']['select']>(), input: vi.fn<ExtensionContext['ui']['input']>() }
  return { ui, ctx: { hasUI, ui } as unknown as ExtensionContext }
}
const question = '目标平台是什么？'

it('waits for an explicit choice and returns the original answer', async () => {
  const { ui, ctx } = context()
  ui.select.mockResolvedValue('2. Linux')
  const result = await askUserTool.execute('q', { question, options: ['Windows', 'Linux'] }, undefined, undefined, ctx)
  expect(ui.select).toHaveBeenCalledWith(`AI 提问：${question}`, ['1. Windows', '2. Linux', '自定义回答…'], { signal: undefined })
  expect(result.details).toMatchObject({ question, answer: 'Linux', status: 'answered' })
  expect(ui.input).not.toHaveBeenCalled()
})

it('supports both custom answers after choices and direct free text', async () => {
  const { ui, ctx } = context()
  ui.select.mockResolvedValue('自定义回答…')
  ui.input.mockResolvedValue('  macOS  ')
  expect((await askUserTool.execute('q', { question, options: ['Windows', 'Linux'] }, undefined, undefined, ctx)).details).toMatchObject({ answer: 'macOS' })
  ui.select.mockClear()
  await askUserTool.execute('q2', { question }, undefined, undefined, ctx)
  expect(ui.select).not.toHaveBeenCalled()
})

it('never treats cancellation, headless execution or abort as consent', async () => {
  const { ui, ctx } = context()
  ui.select.mockResolvedValue(undefined)
  const result = await askUserTool.execute('q', { question, options: ['A', 'B'] }, undefined, undefined, ctx)
  expect(result.details).toMatchObject({ status: 'cancelled', answer: undefined })
  expect(result.terminate).toBe(true)
  expect(ui.input).not.toHaveBeenCalled()
  const headless = context(false)
  expect((await askUserTool.execute('q', { question }, undefined, undefined, headless.ctx)).details).toMatchObject({ status: 'unavailable' })
  expect(headless.ui.input).not.toHaveBeenCalled()
  const controller = new AbortController()
  controller.abort()
  expect((await askUserTool.execute('q', { question }, controller.signal, undefined, ctx)).details).toMatchObject({ status: 'aborted' })
})

it('checks abort between dialogs and marks long answers as truncated', async () => {
  const { ui, ctx } = context()
  const controller = new AbortController()
  ui.select.mockImplementation(async () => { controller.abort(); return '自定义回答…' })
  await askUserTool.execute('q', { question, options: ['A', 'B'] }, controller.signal, undefined, ctx)
  expect(ui.input).not.toHaveBeenCalled()
  ui.input.mockResolvedValue('a'.repeat(9000))
  const result = await askUserTool.execute('q2', { question }, undefined, undefined, ctx)
  expect(result.details).toMatchObject({ truncated: true, answer: 'a'.repeat(8000) })
})
