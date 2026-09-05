// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../../src/renderer/src/features/chat/Markdown'

describe('markdown streaming perf', () => {
  it('measures streaming rerender cost', () => {
    const base = '这是一段用于性能测量的文本，包含一些**加粗**和 `代码` 片段。\n'.repeat(50)
    const view = render(<Markdown text={base} revealMode="live" />)
    const t0 = performance.now()
    let text = base
    for (let i = 0; i < 60; i++) {
      text += `追加的第 ${i} 块内容。\n`
      view.rerender(<Markdown text={text} revealMode="live" />)
    }
    const elapsed = performance.now() - t0
    console.log(`[bench] 60 rerenders, final ${text.length} chars: ${elapsed.toFixed(0)}ms total, ${(elapsed / 60).toFixed(1)}ms/token`)
    expect(elapsed).toBeGreaterThan(0)
  })
})
