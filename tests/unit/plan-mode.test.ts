import { describe, expect, it } from 'vitest'
import { nativePlanModeExtensionSource } from '../../src/main/agent/plan-mode'
import { nativeTaskExtensionSource } from '../../src/main/agent/task-planning'

describe('Pion native plan mode', () => {
  it('uses a command and execution gate instead of model-facing plan tools', () => {
    const source = nativePlanModeExtensionSource()

    expect(source).toContain('registerCommand("plan"')
    expect(source).toContain('READ_ONLY_TOOL_NAMES')
    expect(source).toContain('tool_call')
    expect(source).toContain('pion_task')
    expect(source).not.toContain('registerTool')
    expect(source).not.toContain('plan_mode_question')
    expect(source).not.toContain('plan_mode_complete')
  })

  it('restores the previous active tools after leaving plan mode', () => {
    const source = nativePlanModeExtensionSource()

    expect(source).toContain('toolsBeforePlanMode = pi.getActiveTools()')
    expect(source).toContain('pi.setActiveTools(previous && previous.length > 0 ? previous : normalTools())')
    expect(source).toContain('只有用户明确切换回构建模式并发送执行请求后')
  })

  it('does not reactivate the task tool while a plan session is restored', () => {
    const source = nativeTaskExtensionSource()

    expect(source).toContain('function planModeEnabled(ctx)')
    expect(source).toContain('if (!planModeEnabled(ctx)) ensureToolActive()')
  })
})
