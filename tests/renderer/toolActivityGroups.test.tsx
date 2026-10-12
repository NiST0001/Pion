import { describe, expect, it } from 'vitest'
import { groupToolActivity, summarizeToolActivity } from '../../src/renderer/src/agent/toolActivityGroups'
import type { ToolTimelineItem } from '../../src/renderer/src/agent/toolActivityGroups'
import type { TimelineItem, ToolItem } from '../../src/renderer/src/agent/types'

function tool(id: number, name: string, extra: Partial<ToolItem> = {}): ToolTimelineItem {
  return { kind: 'tool', id, tool: { id: `call-${id}`, name, status: 'done', isError: false, ...extra } }
}

const emptyAssistant: TimelineItem = {
  kind: 'assistant', id: 100, text: '', thinking: '', streaming: false
}

describe('groupToolActivity', () => {
  it('keeps only directly adjacent tools together, including singleton groups', () => {
    const first = tool(1, 'read')
    const second = tool(2, 'edit')
    const timeline: TimelineItem[] = [
      { kind: 'user', id: 0, text: 'hello' }, first, second,
      emptyAssistant, tool(3, 'bash'),
      { kind: 'compaction', id: 101, summary: '' }, tool(4, 'grep'),
      { kind: 'user', id: 102, text: '' }, tool(5, 'find')
    ]
    const original = timeline.slice()
    for (const item of timeline) Object.freeze(item)
    Object.freeze(timeline)
    const groups = groupToolActivity(timeline)
    expect(groups.map(({ firstIndex, lastIndex }) => [firstIndex, lastIndex])).toEqual([
      [1, 2], [4, 4], [6, 6], [8, 8]
    ])
    expect(groups[0].items).toEqual([first, second])
    expect(groups[0].items[0]).toBe(first)
    expect(groups[0].items[1]).toBe(second)
    expect(timeline).toEqual(original)
    expect(groups[0].items).not.toBe(timeline)
  })

  it('returns no groups for empty or message-only input', () => {
    expect(groupToolActivity([])).toEqual([])
    expect(groupToolActivity([emptyAssistant])).toEqual([])
  })

  it('does not merge across a message boundary even for the same real tool ID', () => {
    const item = tool(1, 'read')
    const groups = groupToolActivity([item, emptyAssistant, item])
    expect(groups).toHaveLength(2)
    expect(groups.map(group => summarizeToolActivity(group.items).total)).toEqual([1, 1])
  })
})

describe('summarizeToolActivity', () => {
  it('classifies exact tool names into mutually exclusive categories', () => {
    const items = [
      tool(1, 'read', { path: 'a.ts' }), tool(2, 'read', { path: 'b.ts' }),
      tool(3, 'edit', { path: 'a.ts' }), tool(4, 'write', { path: 'a.ts' }),
      tool(5, 'grep'), tool(6, 'find'), tool(7, 'tool_search'), tool(8, 'web_search'),
      tool(9, 'custom'), tool(10, 'Read'), tool(11, 'bash', { command: 'rg term .' })
    ]
    expect(summarizeToolActivity(items)).toEqual({
      label: '读取2个文件 · 编辑1个文件 · 搜索4次 · 其他工具2次 · 终端1次',
      total: 11, running: 0, errors: 0
    })
    expect(summarizeToolActivity([tool(12, 'powershell')]).label).toBe('终端1次')
  })

  it('deduplicates raw paths per file category without normalizing filesystem spelling', () => {
    const paths = ['a.ts', './a.ts', 'dir/../a.ts', 'A.ts', 'dir\\a.ts', 'dir/a.ts']
    const items = paths.map((path, index) => tool(index, 'read', { path }))
    items.push(tool(10, 'read', { path: 'a.ts' }), tool(11, 'edit', { path: 'a.ts' }))
    expect(summarizeToolActivity(items)).toEqual({
      label: '读取6个文件 · 编辑1个文件', total: 8, running: 0, errors: 0
    })
  })

  it('counts unique real call IDs rather than display IDs or equal metadata', () => {
    const first = tool(1, 'grep')
    const duplicate = tool(2, 'grep', { id: first.tool.id })
    const distinct = tool(1, 'grep', { id: 'another-real-call' })
    expect(summarizeToolActivity([first, duplicate, distinct])).toEqual({
      label: '搜索2次', total: 2, running: 0, errors: 0
    })
  })

  it('preserves both error and running evidence from conflicting duplicate projections', () => {
    const projections = [
      tool(1, 'edit', { id: 'same', path: 'a.ts', status: 'running' }),
      tool(2, 'edit', { id: 'same', path: 'a.ts', status: 'error' }),
      tool(3, 'edit', { id: 'same', path: 'a.ts', status: 'done' })
    ]
    const expected = { label: '编辑1个文件', total: 1, running: 1, errors: 1 }
    expect(summarizeToolActivity(projections)).toEqual(expected)
    expect(summarizeToolActivity([...projections].reverse())).toEqual(expected)
    expect(summarizeToolActivity([tool(4, 'bash', { isError: true })])).toEqual({
      label: '终端1次', total: 1, running: 0, errors: 1
    })
  })

  it('includes failed and unfinished attempts without inventing unknown file counts', () => {
    expect(summarizeToolActivity([
      tool(1, 'read', { status: 'running' }),
      tool(2, 'read', { path: '', status: 'error' }),
      tool(3, 'edit', { status: 'error', isError: true }),
      tool(4, 'write', { status: 'running' }),
      tool(5, 'edit', { path: 'known.ts' })
    ])).toEqual({
      label: '读取2次（路径未知） · 编辑1个文件 · 编辑2次（路径未知）',
      total: 5, running: 2, errors: 2
    })
  })

  it('reads only bounded header metadata and leaves frozen projections untouched', () => {
    const item = tool(1, 'read', { path: 'a.ts' })
    for (const key of ['command', 'diff', 'writeContent', 'outputText', 'images', 'args', 'subagentBatch', 'todos']) {
      Object.defineProperty(item.tool, key, {
        get() { throw new Error(`Unexpected detail access: ${key}`) }
      })
    }
    Object.freeze(item.tool)
    Object.freeze(item)
    const items = Object.freeze([item, item])
    expect(summarizeToolActivity(items)).toEqual({
      label: '读取1个文件', total: 1, running: 0, errors: 0
    })
    expect(groupToolActivity(items)[0].items[0]).toBe(item)
    expect(item.tool.status).toBe('done')
  })

  it('omits every zero category for empty input', () => {
    expect(summarizeToolActivity([])).toEqual({ label: '', total: 0, running: 0, errors: 0 })
  })
})
