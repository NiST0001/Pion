import { useCallback, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { AgentMode, ImageContent, PionApi } from '../../../shared/types'
import type { SessionCommandInfo, SessionCommandTarget } from '../../../shared/slash-command-protocol'
import {
  DESKTOP_SLASH_COMMANDS,
  PENDING_PI_SLASH_COMMAND_NAMES,
  parseDesktopSlashCommand
} from '../../../shared/slash-commands'
import type { AgentState } from '../agent/types'
import type { CommandDialogProps } from '../features/commands/CommandDialog'
import type { SettingsNavigationRequest } from '../features/settings/settingsNavigation'
import { commandExportPath, requireNoCommandArgument } from '../features/commands/commandArguments'

interface CommandSelection {
  generation: number
  cwd?: string
  ownerPath?: string
  sessionId?: string
  sessionPath?: string
}

interface SlashCommandActions {
  setModel(provider: string, modelId: string): Promise<void>
  setThinkingLevel(level: string): Promise<void>
  compactNow(instructions?: string): Promise<void>
  renameSession(name: string, sessionPath?: string): Promise<void>
}

interface UseSlashCommandsOptions {
  api: PionApi | undefined
  state: AgentState
  selectionRef: MutableRefObject<CommandSelection>
  enabled: boolean
  actions: SlashCommandActions
  onOpenSettings: (request: Omit<SettingsNavigationRequest, 'id'>) => void
  onNewSession: () => Promise<void>
  onCloneSession: () => Promise<void>
  onSelectSession: (cwd: string, path: string) => Promise<void>
  onOpenOperations: (kind: 'verification' | 'agents') => void
  onModeChange: (mode: AgentMode) => void
  onRequestYolo: (enabled: boolean) => void
}

type Panel = Omit<CommandDialogProps, 'open' | 'onClose'> & { owned: () => boolean }
const pendingCommands = new Set(PENDING_PI_SLASH_COMMAND_NAMES)
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

function sessionInfoText(info: SessionCommandInfo): string {
  const { stats } = info
  return [
    `名称：${info.sessionName || '未命名'}`,
    `会话 ID：${info.sessionId}`,
    `项目：${info.cwd}`,
    `文件：${info.sessionPath || '尚未落盘'}`,
    '',
    `用户消息：${stats.userMessages}   助手消息：${stats.assistantMessages}`,
    `工具调用：${stats.toolCalls}   工具结果：${stats.toolResults}   消息合计：${stats.totalMessages}`,
    '',
    `输入：${stats.tokens.input.toLocaleString()} tokens`,
    `输出：${stats.tokens.output.toLocaleString()} tokens`,
    `缓存读取：${stats.tokens.cacheRead.toLocaleString()} tokens`,
    `缓存写入：${stats.tokens.cacheWrite.toLocaleString()} tokens`,
    `累计：${stats.tokens.total.toLocaleString()} tokens`,
    `SDK 报告费用：$${stats.cost.toFixed(6)}`,
    '',
    '统计直接来自当前 Pi 会话；不是上下文占用、有限运行列表之和或远端账单。'
  ].join('\n')
}

const HOTKEYS = [
  'Pion 输入框',
  'Enter：发送消息；精确原生命令直接执行',
  'Shift+Enter：换行',
  'Tab：补全斜杠命令；普通消息排队，原生命令不入队',
  'Ctrl+Tab：空闲时切换计划/构建模式',
  '↑ / ↓：在输入框首尾浏览消息历史；命令菜单打开时选择命令',
  '输入法组合输入期间不会发送或执行命令',
  '',
  '命令选择弹窗',
  'Tab / Shift+Tab：切换焦点',
  'Enter：选择当前按钮；在搜索框中选择首个可用结果',
  'Escape：关闭（实际操作收口前不可关闭忙碌弹窗）',
  '',
  '这里只列 Pion 实际实现的快捷键，不包含 Pi 终端专属键位。'
].join('\n')

/** Native commands never enter send/queue. Resource commands remain SDK-owned.
 * UI dismissal invalidates publication, not the actual IPC/FS operation slot. */
export function useSlashCommands(options: UseSlashCommandsOptions) {
  const live = useRef(options)
  live.current = options
  const [panel, setPanel] = useState<Panel | null>(null)
  const requestId = useRef(0)
  const activeId = useRef(0)
  const actualPending = useRef(new Set<string>())
  const actualMutations = useRef(new Set<string>())

  const close = useCallback((): void => {
    activeId.current = 0
    setPanel(null)
  }, [])

  const execute = useCallback((text: string, _images?: ImageContent[]): boolean => {
    const command = parseDesktopSlashCommand(text)
    if (!command) return false
    const captured = live.current
    if (!captured.enabled) return true
    const { state, api } = captured
    const selection = { ...captured.selectionRef.current }
    const backendId = state.liveSessionBackendId ?? state.session?.liveState?.backendId
    let invalidated = false
    const owned = (): boolean => {
      if (invalidated) return false
      const current = live.current
      const selected = current.selectionRef.current
      invalidated = !(current.enabled && current.api === api
        && selected.generation === selection.generation && selected.cwd === selection.cwd
        && selected.ownerPath === selection.ownerPath && selected.sessionId === selection.sessionId
        && selected.sessionPath === selection.sessionPath
        && current.state.status.cwd === state.status.cwd
        && current.state.session?.sessionId === state.session?.sessionId
        && current.state.session?.sessionFile === state.session?.sessionFile
        && (current.state.liveSessionBackendId ?? current.state.session?.liveState?.backendId) === backendId)
      // An observed owner/API/visibility change retires this opening forever,
      // even if every visible field later returns to A without a new generation.
      return !invalidated
    }
    const { name, argument } = command
    const id = ++requestId.current
    activeId.current = id
    const current = (): boolean => activeId.current === id && owned()
    const show = (value: Omit<Panel, 'requestId' | 'owned'>): void => {
      if (current()) setPanel({ ...value, requestId: id, owned })
    }
    const update = (value: Partial<Panel>): void => {
      if (current()) setPanel((previous) => previous?.requestId === id ? { ...previous, ...value } : previous)
    }
    const fail = (error: unknown): void => {
      show({ title: `/${name}`, error: errorText(error) })
    }
    const target = (): SessionCommandTarget => {
      if (!owned()) throw new Error('所选会话已变化，未执行命令')
      if (!api || !state.status.cwd || !state.session?.sessionId || live.current.state.status.phase !== 'running') {
        throw new Error('请等待所选会话后端就绪')
      }
      return { cwd: state.status.cwd, sessionId: state.session.sessionId,
        ...(state.session.sessionFile ? { sessionPath: state.session.sessionFile } : {}),
        ...(backendId ? { backendId } : {}) }
    }
    const idle = (): void => {
      target()
      const latest = live.current.state
      if (latest.busy || latest.compacting || latest.session?.isStreaming || latest.session?.isCompacting
        || latest.queued.steering || latest.queued.followUp || latest.session?.pendingMessageCount) {
        throw new Error('请等待当前运行及收尾完成，并处理排队消息')
      }
    }
    const run = (operation: () => Promise<void>, busy = false): void => {
      if (actualPending.current.has(name) || (busy && actualMutations.current.size > 0)) {
        fail(new Error('该命令的实际操作尚未收口，请等待；不会重复调用'))
        return
      }
      actualPending.current.add(name)
      if (busy) actualMutations.current.add(name)
      show({ title: `/${name}`, loading: true, busy })
      // The slot survives dialog close, selection changes, and all late results.
      void Promise.resolve().then(() => {
        if (!owned()) throw new Error('所选会话已变化，未执行命令')
        return operation()
      }).catch(fail).finally(() => {
        actualPending.current.delete(name)
        if (busy) actualMutations.current.delete(name)
        update({ loading: false, busy: false })
      })
    }
    const select = (operation: () => Promise<void>): void => {
      if (!current() || actualPending.current.has(name)) return
      run(operation, true)
    }
    try {
      if (actualPending.current.has(name)) throw new Error('该命令的实际操作尚未收口，请等待；不会重复调用')
      if (pendingCommands.has(name)) {
        throw new Error(`/${name} 的原生桌面交互尚未接入，已保留在后续阶段；本次不会发送给模型或转到终端。`)
      }
      if (!['compact', 'name', 'model', 'thinking', 'login', 'export', 'plan', 'yolo'].includes(name)) {
        requireNoCommandArgument(name, argument)
      }
      if (!['compact', 'name'].includes(name) && /[\r\n\u2028\u2029]/.test(text.trim())) {
        throw new Error(`/${name} 不接受多行参数`)
      }
      if (name === 'settings' || name === 'trust' || name === 'debug' || name === 'login' || name === 'logout') {
        close()
        captured.onOpenSettings({ page: name === 'trust' ? 'security' : name === 'debug' ? 'diagnostics' : 'models',
          ...(name === 'login' || name === 'logout' ? { authIntent: name, providerQuery: argument } : {}) })
      } else if (name === 'model') {
        target()
        const models = state.models
        const exact = argument && models.find((model) => `${model.provider}/${model.id}` === argument)
        if (exact) {
          idle()
          run(async () => {
            await captured.actions.setModel(exact.provider, exact.id)
            update({ text: `已选择 ${exact.provider}/${exact.id}` })
          }, true)
        } else {
          show({ title: '选择模型', initialQuery: argument,
            description: '使用当前会话可用模型目录；精确 provider/model 参数可直接选择。',
            entries: models.map((model) => ({ id: JSON.stringify([model.provider, model.id]),
              label: `${model.provider}/${model.id}`, detail: model.name,
              selected: model.provider === state.session?.provider && model.id === state.session?.modelId })),
            onSelect: (key) => {
              if (!current() || !models.some((item) => JSON.stringify([item.provider, item.id]) === key)) return
              const model = live.current.state.models.find((item) => JSON.stringify([item.provider, item.id]) === key)
              if (!model) { fail(new Error('该模型已不在当前可用目录中，请重新选择')); return }
              try { idle() } catch (error) { fail(error); return }
              select(async () => {
                await captured.actions.setModel(model.provider, model.id)
                update({ text: `已选择 ${model.provider}/${model.id}` })
              })
            } })
        }
      } else if (name === 'thinking') {
        target()
        const levels = state.thinkingLevels
        const choose = (level: string): void => {
          if (!current()) return
          try {
            idle()
            const currentLevels = live.current.state.thinkingLevels
            if (!currentLevels.includes(level)) throw new Error(`当前模型支持：${currentLevels.join('、') || '尚未读取到思考级别'}`)
            select(async () => {
              await captured.actions.setThinkingLevel(level)
              update({ text: `已选择思考级别：${level}` })
            })
          } catch (error) { fail(error) }
        }
        if (argument) choose(argument.toLowerCase())
        else show({ title: '选择思考级别', entries: levels.map((level) => ({ id: level, label: level,
          selected: level === state.session?.thinkingLevel })), onSelect: choose })
      } else if (name === 'resume') {
        if (!api || !state.status.cwd) throw new Error('请先选择项目')
        const cwd = state.status.cwd
        run(async () => {
          const sessions = await api.listSessions(cwd)
          update({ title: '恢复会话', description: `当前项目：${cwd}`,
            entries: sessions.filter((session) => !session.optimistic).map((session) => ({
              id: session.path, label: session.name || session.preview || session.id,
              detail: `${session.path}\n${session.preview}`, selected: session.path === state.session?.sessionFile
            })), onSelect: (path) => {
              if (!current() || !sessions.some((session) => session.path === path && !session.optimistic)) return
              select(async () => { await captured.onSelectSession(cwd, path); if (current()) close() })
            } })
        })
      } else if (name === 'session') {
        const selected = target()
        run(async () => { update({ title: 'Pi 会话信息', text: sessionInfoText(await api!.getSessionCommandInfo(selected)) }) })
      } else if (name === 'name') {
        if (!argument) show({ title: '会话名称', text: state.session?.sessionName || '当前会话未命名。使用 /name 新名称 设置。' })
        else {
          const selected = target()
          run(async () => {
            await captured.actions.renameSession(argument, selected.sessionPath)
            update({ text: `已设置会话名称：${argument}` })
          }, true)
        }
      } else if (name === 'copy') {
        const selected = target()
        run(async () => { update({ text: await api!.copyLastAssistantText(selected)
          ? '已复制当前分支最后一条助手回复。' : '当前分支尚无可复制的助手文字。' }) })
      } else if (name === 'export') {
        const selected = target()
        idle()
        const path = commandExportPath(argument)
        run(async () => {
          const saved = await api!.exportSessionForCommand(selected, path)
          update({ text: `已导出：${saved}\n\nHTML 包含整棵会话树；JSONL 仅导出当前分支。请检查其中的提示词、工具输出和敏感内容后再分享。` })
        }, true)
      } else if (name === 'compact') {
        idle()
        run(async () => { await captured.actions.compactNow(argument || undefined); update({ text: '上下文压缩已完成。' }) }, true)
      } else if (name === 'new') {
        run(async () => { await captured.onNewSession(); if (current()) close() }, true)
      } else if (name === 'clone') {
        idle()
        if (!state.session?.sessionFile) throw new Error('当前会话尚未持久化，无法复制')
        run(async () => { await captured.onCloneSession(); if (current()) close() }, true)
      } else if (name === 'changelog') {
        if (!api) throw new Error('preload 桥未加载')
        run(async () => {
          const log = await api.getPiChangelog()
          update({ title: `Pi ${log.version} 更新日志`, text: log.markdown,
            description: '当前内置 Pi SDK 的日志；Pion 自身的更新记录在设置 → 关于 Pion。' })
        })
      } else if (name === 'hotkeys') {
        show({ title: 'Pion 快捷键', text: HOTKEYS })
      } else if (name === 'quit') {
        if (!api) throw new Error('preload 桥未加载')
        close()
        api.closeWindow()
      } else if (name === 'verify' || name === 'agents') {
        close()
        captured.onOpenOperations(name === 'verify' ? 'verification' : 'agents')
      } else if (name === 'plan') {
        const value = argument.toLowerCase()
        if (!['', 'start', 'exit', 'off'].includes(value)) throw new Error('用法：/plan start 或 /plan exit')
        close()
        captured.onModeChange(value === 'start' ? 'plan' : value ? 'build' : state.mode === 'plan' ? 'build' : 'plan')
      } else if (name === 'yolo') {
        const value = argument.toLowerCase()
        if (!['', 'on', 'start', 'off', 'exit'].includes(value)) throw new Error('用法：/yolo on 或 /yolo off')
        close()
        captured.onRequestYolo(value === 'on' || value === 'start' ? true : value ? false : !state.yolo)
      }
    } catch (error) { fail(error) }
    return true
  }, [close])

  const visible = panel?.owned() ? panel : null
  const dialog: CommandDialogProps | null = visible ? {
    open: true, requestId: visible.requestId, title: visible.title,
    description: visible.description, entries: visible.entries, text: visible.text,
    loading: visible.loading, error: visible.error, busy: visible.busy,
    searchPlaceholder: visible.searchPlaceholder, initialQuery: visible.initialQuery,
    onSelect: visible.onSelect, onClose: close
  } : null
  return { execute, dialog, commands: DESKTOP_SLASH_COMMANDS }
}
