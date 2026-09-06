import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification } from 'electron'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { AgentBridge } from './agent/agent-bridge'
import { AppSettings } from './app-settings'
import { RunStore } from './run-store'
import { VerificationService } from './verification'
import { GitService } from './git-service'
import { ToolPermissionStore } from './tool-permissions'
import { VerificationWorkflowRunner, WorkflowManager } from './workflow-manager'
import { PluginManager } from './plugin-manager'
import { ProjectStore } from './projects'
import { IPC, IPC_EVENTS } from '../shared/ipc'
import type {
  AddModelProviderInput,
  ExtensionUiResponse,
  GitDiffScope,
  GitSelectionRequest,
  ImageContent,
  ModelProviderAuthType,
  ProjectMeta,
  RunTelemetryQuery,
  StartVerificationOptions,
  ToolPermissionRequest,
  ToolPermissionResolution,
  VerificationPolicy,
  ToolPermissionRules
} from '../shared/types'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const userDataOverride = process.env.PION_USER_DATA_DIR?.trim()
if (userDataOverride) app.setPath('userData', resolve(userDataOverride))

const runStore = new RunStore(join(app.getPath('userData'), 'pion-runs.json'))
const appSettings = new AppSettings()
const bridge = new AgentBridge(runStore, appSettings)
const verification = new VerificationService(join(app.getPath('userData'), 'pion-verification.json'))
const workflowPermissionStore = new ToolPermissionStore()
const workflows = new WorkflowManager({
  filePath: join(app.getPath('userData'), 'pion-workflows.json'),
  worktreeRoot: join(app.getPath('userData'), 'workflow-worktrees'),
  permissionExtensionPath: () => workflowPermissionStore.ensureExtension(),
  verification: new VerificationWorkflowRunner(verification),
  projectTrusted: (cwd) => bridge.getProjectTrust(cwd).decision === 'trusted'
})
const git = new GitService()
const plugins = new PluginManager()
const projects = new ProjectStore()
let completionNotificationsEnabled = true

function focusMainWindow(): void {
  const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function showSessionCompletionNotification({ cwd }: { cwd: string; sessionPath?: string }): void {
  if (!completionNotificationsEnabled || !Notification.isSupported()) return
  const projectName = basename(cwd) || '当前项目'
  try {
    const notification = new Notification({
      title: 'Pion · 输出完成',
      body: `${projectName} 会话输出已完成`
    })
    notification.on('click', focusMainWindow)
    notification.show()
  } catch (error) {
    console.error('[pion] failed to show session completion notification:', error)
  }
}

function showToolPermissionNotification(request: ToolPermissionRequest): void {
  if (!Notification.isSupported()) return
  const projectName = basename(request.cwd) || '当前项目'
  const summary = request.summary.trim() || `${request.toolName} 请求执行操作`
  try {
    const notification = new Notification({
      title: 'Pion · 需要批准',
      body: `${projectName}：${summary.slice(0, 180)}`
    })
    notification.on('click', focusMainWindow)
    notification.show()
  } catch (error) {
    console.error('[pion] failed to show tool permission notification:', error)
  }
}

bridge.onSessionCompleted(showSessionCompletionNotification)
bridge.onToolPermissionRequested(showToolPermissionNotification)
bridge.onRunCompleted((run) => verification.handleAgentRunCompleted(run))
verification.setAutoRepairHandler((run, prompt) =>
  bridge.startVerificationRepair(run.sessionPath, run.cwd, prompt)
)

let projectsPush = (list: ProjectMeta[]): void => {
  // replaced once a window exists
  void list
}

function pushProjects(): void {
  projectsPush(projects.list())
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    title: 'Pion',
    backgroundColor: '#14161b',
    show: false,
    frame: false, // 自绘标题栏
    webPreferences: {
      preload: join(MODULE_DIR, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // required for ESM preload scripts
      webviewTag: true,
      spellcheck: false
    }
  })

  const push = (list: ProjectMeta[]): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.Projects, list)
  }
  projectsPush = push
  push(projects.list())

  const pushMaximized = (): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.WindowState, win.isMaximized())
  }
  win.on('maximize', pushMaximized)
  win.on('unmaximize', pushMaximized)
  win.once('ready-to-show', () => {
    win.show()
    pushMaximized()
  })
  win.on('closed', () => {
    bridge.unbind(win)
    verification.unbind(win)
    workflows.unbind(win)
    git.unbind(win)
  })
  bridge.bind(win)
  verification.bind(win)
  workflows.bind(win)
  git.bind(win)

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[pion] page load FAILED: ${code} ${desc} ${url}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[pion] renderer GONE: ${details.reason} ${details.exitCode ?? ''}`)
  })
  win.webContents.on('console-message', (event) => {
    if (event.level === 'warning' || event.level === 'error') {
      console.error(`[pion:renderer] ${event.message}`)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(MODULE_DIR, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  // agent lifecycle -----------------------------------------------------------
  ipcMain.handle(IPC.AgentStart, async (_event, cwd: string) => {
    const result = await bridge.start(cwd)
    projects.touch(cwd)
    pushProjects()
    return result
  })
  ipcMain.handle(IPC.AgentStop, () => bridge.stop())
  ipcMain.handle(IPC.AgentSend, (_event, message: string, images?: ImageContent[]) => bridge.send(message, images))
  ipcMain.handle(IPC.AgentQueue, (_event, message: string, images?: ImageContent[]) => bridge.queue(message, images))
  ipcMain.handle(
    IPC.AgentSendQueued,
    (_event, kind: 'steering' | 'followUp', index: number) => bridge.sendQueuedMessage(kind, index)
  )
  ipcMain.handle(
    IPC.AgentRemoveQueued,
    (_event, kind: 'steering' | 'followUp', index: number) => bridge.removeQueuedMessage(kind, index)
  )
  ipcMain.handle(IPC.AgentMigrateProject, (_event, cwd: string) => bridge.migrateSessionToProject(cwd))
  ipcMain.handle(IPC.AgentAbort, () => bridge.abort())
  ipcMain.handle(IPC.AgentRunCheckpoint, () => bridge.getRunCheckpoint())
  ipcMain.handle(IPC.AgentRollbackCheckpoint, () => bridge.rollbackRunCheckpoint())
  ipcMain.handle(IPC.AgentRunTelemetry, (_event, query?: RunTelemetryQuery) =>
    bridge.getRunTelemetry(query)
  )
  ipcMain.handle(IPC.AgentRunRecovery, (_event, query?: RunTelemetryQuery) =>
    bridge.getRunRecoveryCandidates(query)
  )
  ipcMain.handle(IPC.AgentResumeRun, (_event, runId: string) => bridge.resumeRun(runId))
  ipcMain.handle(IPC.AgentDiscardRunRecovery, (_event, runId: string) =>
    bridge.discardRunRecovery(runId)
  )
  ipcMain.handle(IPC.AgentRestoreRecoveredCheckpoint, (_event, runId: string) =>
    bridge.restoreRecoveredCheckpoint(runId)
  )
  ipcMain.handle(IPC.AgentState, () => bridge.getSessionInfo())
  ipcMain.handle(IPC.AgentStderr, () => bridge.getStderr())

  // automatic verification --------------------------------------------------
  ipcMain.handle(IPC.VerificationDiscover, (_event, cwd: string, force?: boolean) =>
    verification.discover(cwd, force)
  )
  ipcMain.handle(IPC.VerificationRuns, (_event, cwd?: string, sessionPath?: string) =>
    verification.listRuns(cwd, sessionPath)
  )
  ipcMain.handle(
    IPC.VerificationStart,
    (_event, cwd: string, options?: StartVerificationOptions) => verification.start(cwd, options)
  )
  ipcMain.handle(IPC.VerificationRerun, (_event, runId: string) => verification.rerun(runId))
  ipcMain.handle(IPC.VerificationCancel, (_event, runId: string) => verification.cancel(runId))
  ipcMain.handle(IPC.VerificationPolicyGet, (_event, cwd: string) => verification.getPolicy(cwd))
  ipcMain.handle(
    IPC.VerificationPolicySet,
    (_event, cwd: string, updates: Partial<Omit<VerificationPolicy, 'cwd'>>) =>
      verification.setPolicy(cwd, updates)
  )

  // bounded multi-agent workflows ------------------------------------------
  ipcMain.handle(IPC.WorkflowList, (_event, cwd?: string) => workflows.list(cwd))
  ipcMain.handle(IPC.WorkflowCreate, (_event, request) => workflows.create(request))
  ipcMain.handle(IPC.WorkflowStart, (_event, id: string) => workflows.start(id))
  ipcMain.handle(IPC.WorkflowApprovePlan, (_event, id: string) => workflows.approvePlan(id))
  ipcMain.handle(IPC.WorkflowRepair, (_event, id: string) => workflows.repair(id))
  ipcMain.handle(IPC.WorkflowWaiveTests, (_event, id: string) => workflows.waiveTests(id))
  ipcMain.handle(IPC.WorkflowResume, (_event, id: string) => workflows.resume(id))
  ipcMain.handle(IPC.WorkflowCancel, (_event, id: string) => workflows.cancel(id))
  ipcMain.handle(IPC.WorkflowMerge, (_event, id: string) => workflows.merge(id))
  ipcMain.handle(IPC.WorkflowCleanup, (_event, id: string) => workflows.cleanup(id))

  // session management ----------------------------------------------------------
  ipcMain.handle(IPC.AgentNewSession, () => bridge.newSession())
  ipcMain.handle(IPC.AgentFork, (_event, entryId: string) => bridge.forkAt(entryId))
  ipcMain.handle(IPC.AgentSwitchSession, (_event, sessionPath: string) =>
    bridge.switchSession(sessionPath)
  )
  ipcMain.handle(IPC.AgentDeleteSession, (_event, sessionPath: string) =>
    bridge.deleteSession(sessionPath)
  )
  ipcMain.handle(IPC.AgentCopySession, (_event, sessionPath: string) =>
    bridge.copySession(sessionPath)
  )
  ipcMain.handle(IPC.AgentSessionForkMessages, (_event, sessionPath: string) =>
    bridge.getSessionForkMessages(sessionPath)
  )
  ipcMain.handle(IPC.AgentForkSession, (_event, sessionPath: string, entryId: string) =>
    bridge.forkSession(sessionPath, entryId)
  )
  ipcMain.handle(IPC.AgentEntries, () => bridge.getEntries())
  ipcMain.handle(IPC.AgentHistoryIndex, (_event, sessionPath?: string) =>
    bridge.getHistoryIndex(sessionPath)
  )
  ipcMain.handle(IPC.AgentTaskHistory, (_event, sessionPath: string) =>
    bridge.getSessionTaskHistory(sessionPath)
  )
  ipcMain.handle(IPC.AgentRunningSessions, () => bridge.getRunningSessionPaths())
  ipcMain.handle(
    IPC.AgentEntriesPage,
    (_event, before?: number, limit?: number, sessionPath?: string) =>
      bridge.getEntriesPage(before, limit, sessionPath)
  )
  ipcMain.handle(IPC.AgentTree, () => bridge.getTree())
  ipcMain.handle(IPC.AgentSessions, (_event, cwd?: string) => bridge.listSessions(cwd))

  // commands, modes, model & thinking -------------------------------------------
  ipcMain.handle(IPC.AgentCommands, () => bridge.getCommands())
  ipcMain.handle(IPC.AgentSetMode, (_event, mode: 'build' | 'plan') => bridge.setMode(mode))
  ipcMain.handle(IPC.AgentSetYolo, (_event, enabled: boolean) => bridge.setYoloMode(enabled === true))
  ipcMain.handle(IPC.AgentModels, () => bridge.getModels())
  ipcMain.handle(IPC.AgentModelProviders, () => bridge.getModelProviders())
  ipcMain.handle(
    IPC.AgentLoginModelProvider,
    (_event, providerId: string, authType: ModelProviderAuthType) =>
      bridge.loginModelProvider(providerId, authType)
  )
  ipcMain.handle(IPC.AgentLogoutModelProvider, (_event, providerId: string) =>
    bridge.logoutModelProvider(providerId)
  )
  ipcMain.handle(IPC.AgentModelProviderAuthState, () => bridge.getModelProviderAuthState())
  ipcMain.handle(IPC.AgentCancelModelProviderAuth, () => bridge.cancelModelProviderAuth())
  ipcMain.handle(IPC.AgentOpenModelProviderAuthUrl, (_event, url: string) =>
    bridge.openModelProviderAuthUrl(url)
  )
  ipcMain.handle(IPC.AgentAddModelProvider, (_event, input: AddModelProviderInput) =>
    bridge.addModelProvider(input)
  )
  ipcMain.handle(IPC.AgentSkills, () => bridge.getSkills())
  ipcMain.handle(IPC.AgentCapabilities, () => bridge.getCapabilities())
  ipcMain.handle(IPC.AgentSetModel, (_event, provider: string, modelId: string) =>
    bridge.setModel(provider, modelId)
  )
  ipcMain.handle(IPC.AgentThinkingLevels, () => bridge.getThinkingLevels())
  ipcMain.handle(IPC.AgentSetThinking, (_event, level: string) =>
    bridge.setThinkingLevel(level)
  )

  // plugin store --------------------------------------------------------------
  ipcMain.handle(IPC.PluginsCatalog, () => plugins.getCatalog())
  ipcMain.handle(IPC.PluginsInstalled, () => plugins.getInstalled())
  ipcMain.handle(IPC.PluginsInstall, (_event, source: string) => plugins.install(source))
  ipcMain.handle(IPC.PluginsUninstall, (_event, source: string) => plugins.uninstall(source))

  // app settings ------------------------------------------------------------------
  ipcMain.handle(IPC.GetCompletionNotifications, () => completionNotificationsEnabled)
  ipcMain.handle(IPC.SetCompletionNotifications, async (_event, enabled: boolean) => {
    completionNotificationsEnabled = enabled === true
    try {
      await appSettings.setCompletionNotificationsEnabled(completionNotificationsEnabled)
    } catch (error) {
      console.error('[pion] failed to persist notification setting:', error)
    }
  })
  ipcMain.handle(IPC.ToolPermissionPolicyGet, (_event, cwd: string) =>
    bridge.getToolPermissionPolicy(cwd)
  )
  ipcMain.handle(
    IPC.ToolPermissionPolicySet,
    (_event, cwd: string, updates: Partial<ToolPermissionRules> | null) =>
      bridge.setToolPermissionPolicy(cwd, updates)
  )
  ipcMain.handle(IPC.ToolPermissionPending, () => bridge.getPendingToolPermissionRequests())
  ipcMain.handle(
    IPC.ToolPermissionResolve,
    (_event, requestId: string, resolution: ToolPermissionResolution) =>
      bridge.resolveToolPermission(requestId, resolution)
  )
  ipcMain.handle(IPC.ExtensionUiPending, () => bridge.getPendingExtensionUiRequests())
  ipcMain.handle(
    IPC.ExtensionUiResolve,
    (_event, requestId: string, response: ExtensionUiResponse) =>
      bridge.resolveExtensionUiRequest(requestId, response)
  )

  // agent settings ----------------------------------------------------------------
  ipcMain.handle(IPC.AgentSetAutoCompaction, (_event, enabled: boolean) =>
    bridge.setAutoCompaction(enabled)
  )
  ipcMain.handle(IPC.AgentSetAutoRetry, (_event, enabled: boolean) =>
    bridge.setAutoRetry(enabled)
  )
  ipcMain.handle(IPC.AgentCompact, (_event, customInstructions?: string) =>
    bridge.compactNow(customInstructions)
  )
  ipcMain.handle(IPC.AgentExportHtml, () => bridge.exportSessionHtml())
  ipcMain.handle(IPC.AgentRenameSession, (_event, name: string, sessionPath?: string) =>
    bridge.renameSession(name, sessionPath)
  )
  ipcMain.handle(IPC.AgentSetSteeringMode, (_event, mode: 'all' | 'one-at-a-time') =>
    bridge.setSteeringMode(mode)
  )
  ipcMain.handle(IPC.AgentSetFollowUpMode, (_event, mode: 'all' | 'one-at-a-time') =>
    bridge.setFollowUpMode(mode)
  )

  // window ----------------------------------------------------------------------
  ipcMain.handle(IPC.WindowState, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isMaximized() ?? false
  })
  ipcMain.on(IPC.WindowControl, (event, action: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    if (action === 'minimize') win.minimize()
    else if (action === 'toggle-maximize') {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    } else if (action === 'close') win.close()
  })

  // projects ----------------------------------------------------------------------
  ipcMain.handle(IPC.ProjectsList, () => projects.list())
  ipcMain.handle(IPC.ProjectTrustGet, (_event, cwd: string) => bridge.getProjectTrust(cwd))
  ipcMain.handle(IPC.ProjectTrustSet, (_event, cwd: string, decision: boolean | null) =>
    bridge.setProjectTrust(cwd, decision)
  )
  ipcMain.handle(IPC.BranchesList, (_event, cwd: string) => bridge.listBranches(cwd))
  ipcMain.handle(IPC.BranchCreate, (_event, cwd: string, name: string) => bridge.createBranch(cwd, name))
  ipcMain.handle(IPC.BranchRename, (_event, cwd: string, oldName: string, newName: string) =>
    bridge.renameBranch(cwd, oldName, newName))
  ipcMain.handle(IPC.GitStatus, (_event, cwd: string) => git.getStatus(cwd))
  ipcMain.handle(IPC.GitDiff, (_event, cwd: string, path: string, scope: GitDiffScope) =>
    git.getDiff(cwd, path, scope)
  )
  ipcMain.handle(IPC.GitStagePaths, (_event, cwd: string, snapshotId: string, paths: string[]) =>
    git.stagePaths(cwd, snapshotId, paths)
  )
  ipcMain.handle(IPC.GitUnstagePaths, (_event, cwd: string, snapshotId: string, paths: string[]) =>
    git.unstagePaths(cwd, snapshotId, paths)
  )
  ipcMain.handle(IPC.GitDiscardPaths, (_event, cwd: string, snapshotId: string, paths: string[]) =>
    git.discardPaths(cwd, snapshotId, paths)
  )
  ipcMain.handle(IPC.GitApplySelection, (_event, request: GitSelectionRequest) =>
    git.applySelection(request)
  )
  ipcMain.handle(IPC.GitCommit, (_event, cwd: string, snapshotId: string, message: string) =>
    git.commit(cwd, snapshotId, message)
  )
  ipcMain.handle(IPC.GitConflictRead, (_event, cwd: string, path: string) =>
    git.readConflict(cwd, path)
  )
  ipcMain.handle(
    IPC.GitConflictResolve,
    (_event, cwd: string, snapshotId: string, path: string, strategy: 'ours' | 'theirs' | 'content', content?: string) =>
      git.resolveConflict(cwd, snapshotId, path, strategy, content)
  )
  ipcMain.handle(IPC.GitOperationContinue, (_event, cwd: string, snapshotId: string) =>
    git.continueOperation(cwd, snapshotId)
  )
  ipcMain.handle(IPC.GitOperationAbort, (_event, cwd: string, snapshotId: string) =>
    git.abortOperation(cwd, snapshotId)
  )
  ipcMain.handle(IPC.ProjectsAdd, (_event, cwd: string) => {
    projects.touch(cwd)
    pushProjects()
    return projects.list()
  })
  ipcMain.handle(IPC.ProjectsRemove, (_event, cwd: string) => {
    projects.remove(cwd)
    pushProjects()
    return projects.list()
  })

  // misc --------------------------------------------------------------------------
  ipcMain.handle(IPC.ClipboardImage, async () => {
    const items = await clipboard.read()
    for (const item of items) {
      const mimeType = item.types.find((type) => type.startsWith('image/'))
      if (!mimeType) continue
      const blob = await item.getType(mimeType) as Blob
      return {
        type: 'image' as const,
        data: Buffer.from(await blob.arrayBuffer()).toString('base64'),
        mimeType
      }
    }
    return null
  })
  ipcMain.handle(IPC.PickWorkspace, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择工作目录'
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  ipcMain.handle(IPC.DefaultWorkspace, () => homedir())
}

app.whenReady().then(async () => {
  await Promise.all([appSettings.load(), bridge.loadToolPermissions(), verification.load(), workflows.load()])
  completionNotificationsEnabled = appSettings.completionNotificationsEnabled
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void Promise.all([bridge.stop(), verification.flush(), workflows.shutdown()])
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void Promise.all([bridge.stop(), verification.flush(), workflows.shutdown()])
})
