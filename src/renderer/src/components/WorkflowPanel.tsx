import { useMemo, useState } from 'react'
import {
  Bot,
  Check,
  ChevronDown,
  GitMerge,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  Square,
  Trash2,
  Users,
  X
} from 'lucide-react'
import {
  isWorkflowRunning,
  workflowStateLabel,
  type WorkflowSnapshot,
  type WorkflowWorker
} from '../../../shared/workflows'
import { ConfirmDialog } from './ConfirmDialog'

interface WorkflowPanelProps {
  cwd?: string
  embedded?: boolean
  workflows: WorkflowSnapshot[]
  selected: WorkflowSnapshot | null
  loading: boolean
  busy: boolean
  error: string
  onSelect(id: string): void
  onCreate(goal: string): Promise<unknown>
  onStart(id: string): Promise<unknown>
  onApprovePlan(id: string): Promise<unknown>
  onRepair(id: string): Promise<unknown>
  onWaiveTests(id: string): Promise<unknown>
  onResume(id: string): Promise<unknown>
  onCancel(id: string): Promise<unknown>
  onMerge(id: string): Promise<unknown>
  onCleanup(id: string): Promise<unknown>
}

type Confirmation = 'start' | 'cancel' | 'merge' | 'cleanup' | 'waive' | null

const roleNames: Record<WorkflowWorker['role'], string> = {
  planner: 'Planner',
  implementer: 'Implementer',
  reviewer: 'Reviewer',
  tester: 'Tester'
}

function WorkerRow({ worker }: { worker: WorkflowWorker }) {
  return (
    <details className={`workflow-worker ${worker.status}`}>
      <summary>
        <span className="workflow-worker-icon">
          {worker.status === 'running' ? <Loader2 size={12} className="spin" />
            : worker.status === 'completed' ? <Check size={12} />
              : worker.status === 'failed' ? <X size={12} />
                : <Bot size={12} />}
        </span>
        <strong>{roleNames[worker.role]}</strong>
        <span>{worker.kind === 'command' ? '命令执行器' : '隔离 Agent'}</span>
        <span className="workflow-worker-state">{worker.status}</span>
      </summary>
      <div className="workflow-worker-detail">
        <p><ShieldCheck size={11} />{worker.permission.note}</p>
        {worker.worktreePath && <code title={worker.worktreePath}>{worker.worktreePath}</code>}
        {worker.outputTail && <pre>{worker.outputTail}</pre>}
        {worker.error && <div className="workflow-error">{worker.error}</div>}
      </div>
    </details>
  )
}

export function WorkflowPanel({
  cwd,
  embedded = false,
  workflows,
  selected,
  loading,
  busy,
  error,
  onSelect,
  onCreate,
  onStart,
  onApprovePlan,
  onRepair,
  onWaiveTests,
  onResume,
  onCancel,
  onMerge,
  onCleanup
}: WorkflowPanelProps) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [goal, setGoal] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation>(null)
  const expanded = embedded || open
  const running = selected ? isWorkflowRunning(selected.state) : false
  const canRepair = selected?.state === 'blocked'
    && selected.blockedReason !== 'no-verification'
    && selected.repairAttempts < selected.maxRepairAttempts
  const canCleanup = Boolean(selected && !running && !selected.cleanupCompletedAt && Object.keys(selected.worktrees).length > 0)

  const confirmationCopy = useMemo(() => {
    if (confirmation === 'start') return {
      title: '启动隔离多 Agent 工作流？',
      message: 'Pion 将创建独立 Git worktree，并按 Planner → Implementer → Reviewer → Tester 顺序运行。',
      detail: 'Implementer 仅获候选 worktree 的内置读写工具；其他角色只读。Shell、网络、外部工具、项目插件、递归委派、push 与自动合并均禁用。',
      label: '创建并启动'
    }
    if (confirmation === 'merge') return {
      title: '快进合并候选提交？',
      message: '仅当目标仍是原始基准、工作区干净、审查通过且验证通过或已明确豁免时执行。',
      detail: 'Pion 只运行 git merge --ff-only，不会自动解决冲突或重写目标分支。',
      label: '确认快进合并'
    }
    if (confirmation === 'cleanup') return {
      title: '清理工作流 worktree？',
      message: '所有隔离 worktree 和候选分支将被删除。',
      detail: '如果候选尚未合并，其中的提交和未提交修改会被永久丢弃。',
      label: '删除隔离资源'
    }
    if (confirmation === 'waive') return {
      title: '明确豁免自动验证？',
      message: '项目未发现 typecheck、lint、test 或 build 命令。',
      detail: '合并前仍保留 Reviewer 结论，但候选提交将没有自动测试通过证据。',
      label: '豁免并允许合并'
    }
    return {
      title: '取消多 Agent 工作流？',
      message: '当前 Agent 或验证进程会被终止。',
      detail: '隔离 worktree 不会自动删除，可在检查后单独清理。',
      label: '终止工作流'
    }
  }, [confirmation])

  const confirm = async (): Promise<void> => {
    if (!selected && confirmation !== 'start') return
    const action = confirmation
    setConfirmation(null)
    if (action === 'start') {
      let workflow = selected
      if (creating || !workflow) {
        const created = await onCreate(goal.trim()) as WorkflowSnapshot | null
        workflow = created ?? null
        if (workflow) {
          setGoal('')
          setCreating(false)
        }
      }
      if (workflow) await onStart(workflow.id)
    } else if (action === 'cancel') await onCancel(selected!.id)
    else if (action === 'merge') await onMerge(selected!.id)
    else if (action === 'cleanup') await onCleanup(selected!.id)
    else if (action === 'waive') await onWaiveTests(selected!.id)
  }

  return (
    <section className={`workflow-panel${expanded ? ' open' : ''}${embedded ? ' embedded' : ''}${running ? ' running' : ''}`}>
      {!embedded && (
        <button type="button" className="workflow-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <Users size={13} />
          <strong>多 Agent</strong>
          {selected ? <><span>{workflowStateLabel(selected.state)}</span><span className="workflow-role-count">{selected.workers.length} workers</span></> : <span>未启动</span>}
          {running && <Loader2 size={12} className="spin" />}
          <ChevronDown size={13} className="workflow-chevron" />
        </button>
      )}

      {expanded && (
        <div className="workflow-content">
          <div className="workflow-topbar">
            <div className="workflow-tabs" role="tablist" aria-label="多 Agent 工作流">
              {workflows.slice(0, 5).map((workflow) => (
                <button
                  key={workflow.id}
                  type="button"
                  className={workflow.id === selected?.id ? 'active' : ''}
                  onClick={() => { onSelect(workflow.id); setCreating(false) }}
                  title={workflow.goal}
                >
                  {workflowStateLabel(workflow.state)} · {workflow.goal.slice(0, 20)}
                </button>
              ))}
            </div>
            <button type="button" className="workflow-new" disabled={!cwd || busy} onClick={() => setCreating(true)}>
              <Plus size={12} />新工作流
            </button>
          </div>

          {creating ? (
            <div className="workflow-create">
              <textarea
                autoFocus
                value={goal}
                maxLength={8000}
                placeholder="描述需要 Planner、Implementer、Reviewer 和 Tester 协作完成的目标…"
                onChange={(event) => setGoal(event.target.value)}
              />
              <div>
                <span>候选修改只存在于隔离 worktree，最终合并必须手动确认。</span>
                <button type="button" disabled={busy || !goal.trim()} onClick={() => setConfirmation('start')}><Play size={11} />审查权限并启动</button>
              </div>
            </div>
          ) : loading && !selected ? (
            <div className="workflow-empty"><Loader2 size={15} className="spin" />读取工作流…</div>
          ) : selected ? (
            <div className="workflow-body">
              <header>
                <div>
                  <span className={`workflow-state ${selected.state}`}>{workflowStateLabel(selected.state)}</span>
                  <strong>{selected.goal}</strong>
                </div>
                <div className="workflow-actions">
                  {(selected.state === 'awaiting_start' || selected.state === 'draft') && (
                    <button type="button" disabled={busy} onClick={() => setConfirmation('start')}><Play size={11} />启动</button>
                  )}
                  {selected.state === 'awaiting_plan' && (
                    <button type="button" disabled={busy} onClick={() => void onApprovePlan(selected.id)}><Check size={11} />批准计划并实现</button>
                  )}
                  {canRepair && (
                    <button type="button" disabled={busy} onClick={() => void onRepair(selected.id)}><RotateCcw size={11} />按反馈修复 {selected.repairAttempts}/{selected.maxRepairAttempts}</button>
                  )}
                  {selected.state === 'blocked' && selected.blockedReason === 'no-verification' && (
                    <button type="button" disabled={busy} onClick={() => setConfirmation('waive')}><ShieldCheck size={11} />明确豁免测试</button>
                  )}
                  {selected.state === 'interrupted' && (
                    <button type="button" disabled={busy} onClick={() => void onResume(selected.id)}><RotateCcw size={11} />显式恢复</button>
                  )}
                  {selected.state === 'awaiting_merge' && (
                    <button type="button" className="primary" disabled={busy} onClick={() => setConfirmation('merge')}><GitMerge size={11} />审查后合并</button>
                  )}
                  {running && selected.state !== 'cancelling' && selected.state !== 'merging' && (
                    <button type="button" className="danger" disabled={busy} onClick={() => setConfirmation('cancel')}><Square size={10} />取消</button>
                  )}
                  {canCleanup && (
                    <button type="button" className="danger ghost" disabled={busy} title="清理隔离 worktree" onClick={() => setConfirmation('cleanup')}><Trash2 size={11} /></button>
                  )}
                </div>
              </header>

              {selected.error && <div className="workflow-error">{selected.error}</div>}
              <div className="workflow-workers">
                {selected.workers.map((worker) => <WorkerRow key={worker.id} worker={worker} />)}
                {selected.workers.length === 0 && <span>尚未启动 worker。</span>}
              </div>
              {selected.plan && (
                <details className="workflow-artifact" open={selected.state === 'awaiting_plan'}>
                  <summary>Planner 计划</summary>
                  <pre>{selected.plan}</pre>
                </details>
              )}
              {selected.review && (
                <details className={`workflow-artifact review-${selected.review.verdict}`}>
                  <summary>Reviewer · {selected.review.verdict}</summary>
                  <pre>{selected.review.summary}</pre>
                </details>
              )}
              {selected.verification && (
                <div className={`workflow-verification ${selected.verification.state}`}>
                  <ShieldCheck size={12} />
                  <strong>验证 {selected.verification.state}</strong>
                  <span>{selected.verification.summary}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="workflow-empty">
              <Users size={18} />
              <span>创建一个有边界、可见、可取消的隔离多 Agent 工作流。</span>
              <button type="button" disabled={!cwd || busy} onClick={() => setCreating(true)}><Plus size={11} />新工作流</button>
            </div>
          )}
          {error && <div className="workflow-error">{error}</div>}
        </div>
      )}

      <ConfirmDialog
        open={confirmation !== null}
        title={confirmationCopy.title}
        message={confirmationCopy.message}
        detail={confirmationCopy.detail}
        confirmLabel={confirmationCopy.label}
        tone={confirmation === 'merge' || confirmation === 'start' ? 'accent' : 'danger'}
        busy={busy}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => void confirm()}
      />
    </section>
  )
}
