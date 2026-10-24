import type { SlashCommandInfo } from './types'

/** Pi's 24 core commands, its desktop diagnostics/router entries, and Pion commands.
 * Resource commands (extensions, prompt templates and skills) remain SDK-owned. */
export const DESKTOP_SLASH_COMMANDS: SlashCommandInfo[] = [
  { name: 'settings', description: '打开 Pion 设置', source: 'builtin' },
  { name: 'model', description: '选择模型，可指定 provider/model', source: 'builtin' },
  { name: 'thinking', description: '选择思考级别，可指定 level', source: 'builtin' },
  { name: 'scoped-models', description: '配置交互轮换模型（待接入）', source: 'builtin' },
  { name: 'login', description: '打开提供商认证，可指定提供商', source: 'builtin' },
  { name: 'logout', description: '打开提供商认证管理，显式选择后退出登录', source: 'builtin' },
  { name: 'new', description: '在当前项目中新建会话', source: 'builtin' },
  { name: 'resume', description: '打开已保存的会话列表', source: 'builtin' },
  { name: 'name', description: '设置当前会话名称，省略参数查看名称', source: 'builtin' },
  { name: 'session', description: '查看当前会话信息与统计', source: 'builtin' },
  { name: 'tree', description: '浏览并切换会话树分支（待接入）', source: 'builtin' },
  { name: 'fork', description: '从历史用户消息创建分叉会话（待接入）', source: 'builtin' },
  { name: 'clone', description: '复制当前活动分支为新会话', source: 'builtin' },
  { name: 'compact', description: '手动压缩上下文，可附加摘要要求', source: 'builtin' },
  { name: 'import', description: '导入并恢复 JSONL 会话（待接入）', source: 'builtin' },
  { name: 'copy', description: '复制最后一条助手回复', source: 'builtin' },
  { name: 'export', description: '导出当前会话，可指定 HTML 或 JSONL 路径', source: 'builtin' },
  { name: 'share', description: '上传会话并生成分享链接（待接入）', source: 'builtin' },
  { name: 'bug', description: '准备发送给 Pi 开发者的私密问题报告（待接入）', source: 'builtin' },
  { name: 'trust', description: '打开项目安全与信任设置', source: 'builtin' },
  { name: 'reload', description: '重新加载扩展、技能、模板与配置（待接入）', source: 'builtin' },
  { name: 'hotkeys', description: '查看 Pion 键盘快捷键', source: 'builtin' },
  { name: 'changelog', description: '查看 Pi SDK 更新日志', source: 'builtin' },
  { name: 'quit', description: '关闭 Pion 窗口', source: 'builtin' },
  { name: 'debug', description: '打开 Pion 桌面诊断', source: 'builtin' },
  { name: 'llama', description: '管理 llama.cpp 路由器中的模型（待接入）', source: 'builtin' },
  { name: 'plan', description: '切换 Pion 只读计划模式，不直接执行实现', source: 'pion' },
  { name: 'yolo', description: '请求切换本会话 YOLO 工具权限模式', source: 'pion' },
  { name: 'verify', description: '打开项目自动验证面板', source: 'pion' },
  { name: 'agents', description: '打开隔离多 Agent 工作流面板', source: 'pion' },
  { name: 'stats', description: '查看所有会话的 Token 与费用使用总览', source: 'pion' }
]

export const DESKTOP_SLASH_COMMAND_NAMES: string[] = DESKTOP_SLASH_COMMANDS.map((command) => command.name)

export const PENDING_PI_SLASH_COMMAND_NAMES: string[] = [
  'scoped-models', 'tree', 'fork', 'import', 'share', 'bug', 'reload', 'llama'
]

/** Pure desktop entry points plus the existing guarded Pion modes. Never use
 * backend mutations as sendDisabled exceptions just because they are native. */
export const PREPARATION_SLASH_COMMAND_NAMES: string[] = [
  'settings', 'resume', 'session', 'trust', 'hotkeys', 'changelog', 'debug',
  'plan', 'yolo', 'verify', 'agents', 'stats',
  ...PENDING_PI_SLASH_COMMAND_NAMES
]

const desktopCommandNames = new Set(DESKTOP_SLASH_COMMAND_NAMES)

/** Recognize complete native names only, including multiline arguments. The
 * desktop handler validates arguments; a newline must not turn a known native
 * command into a model prompt. Resources and prose remain SDK-owned. */
export function parseDesktopSlashCommand(text: string): { name: string; argument: string } | null {
  const trimmed = text.trim()
  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  const name = match[1].toLowerCase()
  if (!desktopCommandNames.has(name)) return null
  return { name, argument: (match[2] ?? '').trim() }
}
