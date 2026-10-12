import { afterEach, expect, it, vi } from 'vitest'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { askUserTool, createAskUserTool } from '../../src/main/agent/ask-user'
import { QUESTION_WAIT_WIDGET_KEY } from '../../src/shared/question-settings'

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

function context(hasUI = true) {
  const ui = { select: vi.fn<ExtensionToolContext['ui']['select']>(), input: vi.fn<ExtensionToolContext['ui']['input']>() }
  return { ui, ctx: { hasUI, ui, tools: [], executeTool: vi.fn(async () => { throw new Error('Unexpected tool delegation') }) } as unknown as ExtensionToolContext }
}
const question = '目标平台是什么？'

it('waits for an explicit choice and returns the original answer', async () => {
  const { ui, ctx } = context()
  ui.select.mockResolvedValue('2. Linux')
  const result = await askUserTool.execute('q', { question, options: ['Windows', 'Linux'] }, undefined, undefined, ctx)
  expect(ui.select).toHaveBeenCalledWith(`AI 提问：${question}`, ['1. Windows', '2. Linux', '自定义回答…'], { signal: undefined, timeout: expect.any(Number) })
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

it('captures settings once and preserves the question deadline across custom-answer dialogs', async () => {
  let now = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const read = vi.fn().mockResolvedValue({ timeoutMinutes: 300 })
  const tool = createAskUserTool(read)
  const { ui, ctx } = context()
  ui.select.mockImplementation(async () => {
    now += 60_000
    read.mockResolvedValue({ timeoutMinutes: 1 })
    return '自定义回答…'
  })
  ui.input.mockResolvedValue('answer')
  await tool.execute('q', { question, options: ['A', 'B'] }, undefined, undefined, ctx)
  expect(read).toHaveBeenCalledTimes(1)
  expect(ui.select.mock.calls[0][2]?.timeout).toBe(300 * 60_000)
  expect(ui.input.mock.calls[0][2]?.timeout).toBe(299 * 60_000)
  await tool.execute('next', { question }, undefined, undefined, ctx)
  expect(ui.input.mock.calls[1][2]?.timeout).toBe(60_000)
})

it('omits SDK timeout for unlimited waits and publishes bounded private metadata without question or answer', async () => {
  vi.stubEnv('PION_QUESTION_UI_NONCE', 'backend-nonce')
  const { ui, ctx } = context()
  const widget = vi.fn()
  ctx.ui.setWidget = widget
  ui.input.mockResolvedValue('private answer')
  await createAskUserTool(async () => ({ timeoutMinutes: null })).execute('actual-tool-id', { question }, undefined, undefined, ctx)
  expect(ui.input.mock.calls[0][2]).toEqual({ signal: undefined })
  expect(widget).toHaveBeenCalledTimes(2)
  expect(widget.mock.calls[0][0]).toBe(QUESTION_WAIT_WIDGET_KEY)
  expect(JSON.parse(widget.mock.calls[0][1][0])).toEqual({ version: 1, nonce: 'backend-nonce', toolCallId: 'actual-tool-id', phase: 'begin', timeoutMs: null })
  expect(JSON.parse(widget.mock.calls[1][1][0]).phase).toBe('end')
  expect(JSON.stringify(widget.mock.calls)).not.toContain(question)
  expect(JSON.stringify(widget.mock.calls)).not.toContain('private answer')
})

it('cancelling an unlimited dialog still terminates without an answer or automatic re-question', async () => {
  const { ui, ctx } = context()
  ui.input.mockResolvedValue(undefined)
  const result = await createAskUserTool(async () => ({ timeoutMinutes: null })).execute('q', { question }, undefined, undefined, ctx)
  expect(result.terminate).toBe(true)
  expect(result.details).toMatchObject({ status: 'cancelled', answer: undefined })
  expect(ui.input).toHaveBeenCalledTimes(1)
})

it('configuration failure does not open a dialog or manufacture consent', async () => {
  const { ui, ctx } = context()
  const tool = createAskUserTool(async () => { throw new Error('configuration unavailable') })
  await expect(tool.execute('q', { question }, undefined, undefined, ctx)).rejects.toThrow('configuration unavailable')
  expect(ui.input).not.toHaveBeenCalled()
})
