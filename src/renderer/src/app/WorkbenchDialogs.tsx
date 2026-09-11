import { lazy, Suspense } from 'react'
import type { ComponentProps, ReactElement } from 'react'
import { ConfirmDialog } from '../features/common/ConfirmDialog'
import { OperationsModal } from '../features/operations/OperationsModal'
import { VerificationPanel } from '../features/operations/VerificationPanel'
import { WorkflowPanel } from '../features/operations/WorkflowPanel'

type ConfirmationProps = Pick<ComponentProps<typeof ConfirmDialog>, 'open' | 'onConfirm' | 'onCancel'> & {
  busy: boolean
  error: string
}

type DeferredDialogProps<Props> = {
  mounted: boolean
  dialog: Props
}

const LazyBranchCreateModal = lazy(() => import('../features/project/BranchCreateModal')
  .then((module) => ({ default: module.BranchCreateModal })))
const LazySettingsModal = lazy(() => import('../features/settings/SettingsModal')
  .then((module) => ({ default: module.SettingsModal })))
const LazySkillsToolsModal = lazy(() => import('../features/capabilities/SkillsToolsModal')
  .then((module) => ({ default: module.SkillsToolsModal })))
const LazyPluginStoreModal = lazy(() => import('../features/capabilities/PluginStoreModal')
  .then((module) => ({ default: module.PluginStoreModal })))
const LazyTaskHistoryPanel = lazy(() => import('../features/session/TaskHistoryPanel')
  .then((module) => ({ default: module.TaskHistoryPanel })))

interface WorkbenchDialogsProps {
  operations: {
    kind: ComponentProps<typeof OperationsModal>['kind'] | null
    onClose: ComponentProps<typeof OperationsModal>['onClose']
    workflow: Omit<ComponentProps<typeof WorkflowPanel>, 'embedded'>
    verification: Omit<ComponentProps<typeof VerificationPanel>, 'embedded'>
  }
  confirmations: {
    messageRevert?: ComponentProps<typeof ConfirmDialog>
    rollback: ConfirmationProps
    planModeExit: ConfirmationProps
    yolo: ConfirmationProps
    migration: ConfirmationProps & { projectName: string | null }
  }
  taskHistory: DeferredDialogProps<ComponentProps<typeof LazyTaskHistoryPanel>>
  capabilities: DeferredDialogProps<ComponentProps<typeof LazySkillsToolsModal>>
  pluginStore: DeferredDialogProps<ComponentProps<typeof LazyPluginStoreModal>>
  branch: DeferredDialogProps<Omit<ComponentProps<typeof LazyBranchCreateModal>, 'projectName'> & { projectName?: string }>
  settings: DeferredDialogProps<ComponentProps<typeof LazySettingsModal>>
}

/** Presentation only: App retains the controllers, callbacks and sticky first-mount gates. */
export function WorkbenchDialogs({
  operations,
  confirmations: { rollback, planModeExit, yolo, migration, messageRevert },
  taskHistory,
  capabilities,
  pluginStore,
  branch,
  settings
}: WorkbenchDialogsProps): ReactElement {
  return (
    <>
      {operations.kind && (
        <OperationsModal kind={operations.kind} onClose={operations.onClose}>
          {operations.kind === 'agents' ? (
            <WorkflowPanel embedded {...operations.workflow} />
          ) : (
            <VerificationPanel embedded {...operations.verification} />
          )}
        </OperationsModal>
      )}

      <ConfirmDialog
        open={rollback.open}
        title="撤销本轮修改"
        message="工作区将恢复到发送本轮任务之前。"
        detail={rollback.error || '发送前已有的暂存、未暂存和未跟踪文件会保留；本轮开始后的手动修改也会一并撤销。'}
        confirmLabel="确认撤销"
        tone="accent"
        busy={rollback.busy}
        onConfirm={rollback.onConfirm}
        onCancel={rollback.onCancel}
      />
      <ConfirmDialog
        open={planModeExit.open}
        title="确认进入构建模式"
        message="计划模式只允许资料收集，不会修改文件或创建 Pion 任务。"
        detail={planModeExit.error || '确认后将恢复编辑、写入和终端工具；此操作不会自动开始执行，仍需发送下一条执行请求。'}
        confirmLabel="切换到构建模式"
        tone="accent"
        busy={planModeExit.busy}
        onConfirm={planModeExit.onConfirm}
        onCancel={planModeExit.onCancel}
      />
      <ConfirmDialog
        open={yolo.open}
        title="确认开启 YOLO 模式"
        message="YOLO 模式会自动批准本会话的所有工具权限请求，包括写入文件和执行终端命令。"
        detail={yolo.error || '开启后不再弹出权限确认，也不会写入项目权限规则；发送 /yolo off 或点击 YOLO 标识可随时关闭。'}
        confirmLabel="开启 YOLO"
        tone="danger"
        busy={yolo.busy}
        onConfirm={yolo.onConfirm}
        onCancel={yolo.onCancel}
      />
      <ConfirmDialog
        open={migration.open}
        title="迁移会话到项目"
        message={`将会话迁移到 ${migration.projectName}？`}
        detail={migration.error || '会话文件会移动到目标项目的会话目录，并在那里继续。运行中的会话需要先等待完成。'}
        confirmLabel="迁移"
        tone="accent"
        busy={migration.busy}
        onConfirm={migration.onConfirm}
        onCancel={migration.onCancel}
      />

      {messageRevert && <ConfirmDialog tone="accent" {...messageRevert} />}

      {/* Keep separate, fixed sibling slots: closing a panel must not unmount its host
          or let a different lazy panel's download suspend already mounted dialogs. */}
      {taskHistory.mounted && (
        <Suspense fallback={null}>
          <LazyTaskHistoryPanel {...taskHistory.dialog} />
        </Suspense>
      )}
      {capabilities.mounted && (
        <Suspense fallback={null}>
          <LazySkillsToolsModal {...capabilities.dialog} />
        </Suspense>
      )}
      {pluginStore.mounted && (
        <Suspense fallback={null}>
          <LazyPluginStoreModal {...pluginStore.dialog} />
        </Suspense>
      )}
      {branch.mounted && (
        <Suspense fallback={null}>
          <LazyBranchCreateModal {...branch.dialog} projectName={branch.dialog.projectName ?? '当前项目'} />
        </Suspense>
      )}
      {settings.mounted && (
        <Suspense fallback={null}>
          <LazySettingsModal {...settings.dialog} />
        </Suspense>
      )}
    </>
  )
}
