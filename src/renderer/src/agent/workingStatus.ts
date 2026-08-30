import type { AgentMode } from '../../../shared/types'
import type { TimelineItem, ToolItem } from './types'

export interface WorkingStatus {
  label: string
  face?: string
}

const BUILD_VARIANTS: WorkingStatus[] = [
  { label: '思考中...', face: '( •̀ᴗ•́ )و' },
  { label: '分析中...', face: '(._.)' },
  { label: '梳理上下文中...', face: '(｡•̀ᴗ-)✧' }
]

const DEEP_BUILD_VARIANTS: WorkingStatus[] = [
  { label: '深度思考中...', face: '(ง •̀_•́)ง' },
  { label: '推演方案中...', face: '( •̀ ω •́ )✧' },
  { label: '核对细节中...', face: '(￣▽￣)ゞ' }
]

const PLAN_VARIANTS: WorkingStatus[] = [
  { label: '规划中...', face: '( •̀ ω •́ )✧' },
  { label: '计划中...', face: '(｡•̀ᴗ-)✧' },
  { label: '深度规划中...', face: '(￣▽￣)ノ' }
]

function runningTool(timeline: TimelineItem[]): ToolItem | undefined {
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index]
    if (item.kind === 'tool' && item.tool.status === 'running') return item.tool
    if (item.kind === 'user') break
  }
  return undefined
}

function toolStatus(tool: ToolItem): WorkingStatus {
  const name = tool.name.toLocaleLowerCase()
  if (name === 'plan_mode_question') return { label: '等待计划选择中...', face: '(・_・?)' }
  if (name.startsWith('plan_mode_')) return { label: '整理计划中...', face: '( •̀ ω •́ )✧' }
  if (/pion_task|todo|task/.test(name)) return { label: '整理任务中...', face: '(｡•̀ᴗ-)✧' }
  if (/read|grep|find|glob|list|tree|search_files/.test(name)) return { label: '读取项目中...', face: '( •̀ᴗ•́ )و' }
  if (/edit|write|patch|replace|create_file/.test(name)) return { label: '编辑代码中...', face: '✍(•̀ᴗ•́)' }
  if (/bash|shell|terminal|command|exec/.test(name)) return { label: '操作终端中...', face: '(ง •̀_•́)ง' }
  if (/web|fetch|browser|search/.test(name)) return { label: '检索资料中...', face: '(⌐■_■)' }
  if (/mcp/.test(name)) return { label: '调用 MCP 中...', face: '(ﾉ◕ヮ◕)ﾉ' }
  return { label: '操作工具中...', face: '( •̀ᴗ•́ )و' }
}

export function deriveWorkingStatus({
  timeline,
  mode,
  thinkingLevel,
  cycle = 0
}: {
  timeline: TimelineItem[]
  mode: AgentMode
  thinkingLevel?: string
  cycle?: number
}): WorkingStatus {
  const tool = runningTool(timeline)
  if (tool) return toolStatus(tool)

  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index]
    if (item.kind === 'assistant' && item.streaming && item.text.trim()) {
      return { label: '组织回复中...', face: '✍(•̀ᴗ•́)' }
    }
    if (item.kind === 'user') break
  }

  const variants = mode === 'plan'
    ? PLAN_VARIANTS
    : /^(high|xhigh|max)$/i.test(thinkingLevel ?? '')
      ? DEEP_BUILD_VARIANTS
      : BUILD_VARIANTS
  return variants[Math.abs(cycle) % variants.length]
}
