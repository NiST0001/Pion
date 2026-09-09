import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  ChevronRight,
  CircleHelp,
  FileDiff,
  ListTodo,
  Loader2,
  Sparkles,
  Terminal,
  Wrench,
  X
} from 'lucide-react'
import type { AgentCapabilities, SkillInfo, ToolInfo } from '../../../../shared/types'

type CapabilityPage = 'skills' | 'tools'

interface BuiltinToolInfo {
  name: string
  title: string
  description: string
}

const EMPTY_CAPABILITIES: AgentCapabilities = { skills: [], tools: [] }

const BUILTIN_TOOLS: BuiltinToolInfo[] = [
  {
    name: 'read',
    title: '读取文件',
    description: '查看文本文件、图片和项目中的现有内容。'
  },
  {
    name: 'write',
    title: '写入文件',
    description: '创建新文件或完整覆盖已有文件内容。'
  },
  {
    name: 'edit',
    title: '编辑文件',
    description: '通过精确文本替换修改代码，保留变更边界。'
  },
  {
    name: 'bash',
    title: '执行命令',
    description: '在当前项目目录运行构建、测试和其他 Shell 命令。'
  },
  {
    name: 'pion_task',
    title: '任务计划',
    description: 'Pion 原生的本轮任务规划、状态更新和会话历史归档工具。'
  },
  {
    name: 'pion_ask_user',
    title: '向用户提问',
    description: '遇到关键歧义时等待用户回答，支持选项、自定义回答与取消；普通和计划模式均可使用，无需插件。'
  },
  {
    name: 'pion_subagents',
    title: '并行子代理',
    description: '输入框内按会话开启；数量、超时和轮数可在设置 → 会话中调整，下一批生效。沿用主会话工具权限与检查点，关闭会中止子任务。产生额外模型用量，后端重建后默认关闭。'
  }
]

export function SkillsToolsModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): ReactElement | null {
  const [page, setPage] = useState<CapabilityPage>('skills')
  const [capabilities, setCapabilities] = useState<AgentCapabilities>(EMPTY_CAPABILITIES)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Capability discovery is intentionally tied only to an open transition.
  // Streaming agent updates rerender App frequently; an inline onClose callback
  // must never reset this page or launch another resource-loader scan.
  useEffect(() => {
    if (!open) return
    setPage('skills')
    setCapabilities(EMPTY_CAPABILITIES)
    setError('')
    setLoading(true)
    let active = true

    void window.pion.getCapabilities()
      .then((loadedCapabilities) => {
        if (active) setCapabilities(loadedCapabilities)
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="modal-backdrop capabilities-backdrop" onClick={onClose}>
      <div
        className="modal capabilities-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="capabilities-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <div className="modal-kicker">PION CAPABILITIES</div>
            <h2 id="capabilities-title">技能与工具</h2>
          </div>
          <button type="button" className="icon-button capabilities-close" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="capabilities-body">
          <nav className="capabilities-nav" aria-label="能力分类">
            <div className="capabilities-nav-label">能力目录</div>
            <CapabilityNavItem
              page="skills"
              active={page === 'skills'}
              icon={<Sparkles size={15} />}
              label="技能"
              description="工作流与方法"
              onClick={() => setPage('skills')}
            />
            <CapabilityNavItem
              page="tools"
              active={page === 'tools'}
              icon={<Wrench size={15} />}
              label="工具"
              description="文件与命令"
              onClick={() => setPage('tools')}
            />
          </nav>

          <main className="capabilities-content">
            {page === 'skills' ? (
              <SkillsPage skills={capabilities.skills} loading={loading} error={error} />
            ) : (
              <ToolsPage tools={capabilities.tools} loading={loading} error={error} />
            )}
          </main>
        </div>
      </div>
    </div>
  )
}

function CapabilityNavItem({
  page,
  active,
  icon,
  label,
  description,
  onClick
}: {
  page: CapabilityPage
  active: boolean
  icon: ReactElement
  label: string
  description: string
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      data-page={page}
      className={`capabilities-nav-item${active ? ' active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <span className="capabilities-nav-icon">{icon}</span>
      <span className="capabilities-nav-copy">
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <ChevronRight size={13} className="capabilities-nav-arrow" />
    </button>
  )
}

function SkillsPage({
  skills,
  loading,
  error
}: {
  skills: SkillInfo[]
  loading: boolean
  error: string
}): ReactElement {
  return (
    <section className="capabilities-page" data-page="skills">
      <div className="capabilities-page-heading">
        <div className="capabilities-page-kicker">SKILLS</div>
        <h3>技能</h3>
        <p>技能是可复用的工作方法，会根据当前工作区和用户配置自动加载。</p>
      </div>

      <div className="capabilities-toolbar">
        <span className="capabilities-count">
          {loading ? '正在读取…' : `${skills.length} 项已加载`}
        </span>
        <span className="capabilities-source">当前工作区 · 用户配置 · 已安装插件</span>
      </div>

      {error && <div className="capabilities-error">读取技能失败：{error}</div>}
      {loading && (
        <div className="capabilities-empty">
          <Loader2 size={16} className="spin" />
          <span>正在读取可用技能…</span>
        </div>
      )}
      {!loading && skills.length === 0 && !error && (
        <div className="capabilities-empty">
          <Sparkles size={18} />
          <span>当前没有发现可用技能</span>
        </div>
      )}
      {!loading && skills.length > 0 && (
        <div className="capabilities-grid">
          {skills.map((skill) => (
            <CapabilityCard
              key={skill.name}
              kind="skill"
              icon={<Sparkles size={16} />}
              name={skill.name}
              source={formatCapabilitySource(skill.source)}
              description={skill.description || '可调用的工作技能。'}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function ToolsPage({
  tools,
  loading,
  error
}: {
  tools: ToolInfo[]
  loading: boolean
  error: string
}): ReactElement {
  return (
    <section className="capabilities-page" data-page="tools">
      <div className="capabilities-page-heading">
        <div className="capabilities-page-kicker">TOOLS</div>
        <h3>工具</h3>
        <p>工具是 agent 在当前工作区中可以直接调用的文件、终端和已安装插件能力。</p>
      </div>

      <div className="capabilities-toolbar">
        <span className="capabilities-count">
          {loading ? '正在读取…' : `${BUILTIN_TOOLS.length + tools.length} 项可用`}
        </span>
        <span className="capabilities-source">Pi 内置工具 · 已安装插件</span>
      </div>

      {error && <div className="capabilities-error">读取插件工具失败：{error}</div>}
      {loading && (
        <div className="capabilities-loading-note">
          <Loader2 size={14} className="spin" />
          <span>正在读取插件工具…</span>
        </div>
      )}

      <div className="capabilities-grid">
        {BUILTIN_TOOLS.map((tool) => (
          <CapabilityCard
            key={`builtin:${tool.name}`}
            kind="tool"
            icon={tool.name === 'bash'
              ? <Terminal size={16} />
              : tool.name === 'pion_task'
                ? <ListTodo size={16} />
                : tool.name === 'pion_ask_user'
                  ? <CircleHelp size={16} />
                  : <FileDiff size={16} />}
            name={tool.name}
            title={tool.title}
            source={tool.name.startsWith('pion_') ? 'Pion 内置' : 'Pi 内置'}
            description={tool.description}
          />
        ))}
        {tools.map((tool) => (
          <CapabilityCard
            key={`plugin:${tool.source ?? 'unknown'}:${tool.name}`}
            kind="tool"
            icon={<Wrench size={16} />}
            name={tool.name}
            title={tool.label || tool.name}
            source={formatCapabilitySource(tool.source)}
            description={tool.description || '已安装插件提供的工具。'}
          />
        ))}
      </div>
    </section>
  )
}

function formatCapabilitySource(source?: string): string | undefined {
  if (!source) return undefined
  if (source === 'auto') return '自动发现'
  return source.replace(/^npm:/, '')
}

function CapabilityCard({
  kind,
  icon,
  name,
  title,
  source,
  description
}: {
  kind: 'skill' | 'tool'
  icon: ReactElement
  name: string
  title?: string
  source?: string
  description: string
}): ReactElement {
  return (
    <article className={`capability-card capability-card-${kind} ${kind}-card`}>
      <span className="capability-card-icon">{icon}</span>
      <div className="capability-card-copy">
        <div className="capability-card-name-row">
          <strong>{title || name}</strong>
          <code>{kind === 'skill' ? `/${name}` : name}</code>
        </div>
        {source && <span className="capability-card-source">{source}</span>}
        <p>{description}</p>
      </div>
    </article>
  )
}
