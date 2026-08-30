import { describe, expect, it } from 'vitest'
import type { TimelineItem } from '../../src/renderer/src/agent/types'
import { deriveWorkingStatus } from '../../src/renderer/src/agent/workingStatus'

function runningTool(name: string): TimelineItem[] {
  return [
    { kind: 'user', id: 1, text: 'do it' },
    { kind: 'tool', id: 2, tool: { id: 'tool-1', name, status: 'running', isError: false } }
  ]
}

describe('deriveWorkingStatus', () => {
  it('always uses an animated ellipsis-friendly thinking label', () => {
    const status = deriveWorkingStatus({ timeline: [], mode: 'build', cycle: 0 })
    expect(status.label).toBe('思考中...')
    expect(status.face).toBeTruthy()
  })

  it('cycles through planning and deep-thinking variants', () => {
    expect(deriveWorkingStatus({ timeline: [], mode: 'plan', cycle: 0 }).label).toBe('规划中...')
    expect(deriveWorkingStatus({ timeline: [], mode: 'plan', cycle: 1 }).label).toBe('计划中...')
    expect(deriveWorkingStatus({ timeline: [], mode: 'build', thinkingLevel: 'max', cycle: 0 }).label)
      .toBe('深度思考中...')
  })

  it.each([
    ['read', '读取项目中...'],
    ['edit', '编辑代码中...'],
    ['bash', '操作终端中...'],
    ['web_search', '检索资料中...'],
    ['mcp', '调用 MCP 中...'],
    ['unknown_tool', '操作工具中...'],
    ['plan_mode_question', '等待计划选择中...']
  ])('maps %s to a specific tool status', (tool, label) => {
    expect(deriveWorkingStatus({ timeline: runningTool(tool), mode: 'build' }).label).toBe(label)
  })

  it('shows reply organization once assistant text is streaming', () => {
    const timeline: TimelineItem[] = [
      { kind: 'user', id: 1, text: 'answer' },
      { kind: 'assistant', id: 2, text: 'partial', thinking: '', streaming: true }
    ]
    expect(deriveWorkingStatus({ timeline, mode: 'build' }).label).toBe('组织回复中...')
  })
})
