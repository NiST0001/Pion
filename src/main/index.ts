import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, Notification } from 'electron'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir, release } from 'node:os'
import { fileURLToPath } from 'node:url'
import { AgentBridge } from './agent/agent-bridge'
import { AppSettings } from './app-settings'
import { RunStore } from './run-store'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { UsageLedger } from './usage-ledger'
import { UsageLedgerError } from './usage-ledger-store'
import { VerificationService } from './verification'
import { GitService } from './git-service'
import { ToolPermissionStore } from './tool-permissions'
import { VerificationWorkflowRunner, WorkflowManager } from './workflow-manager'
import { PluginManager } from './plugin-manager'
import { ProjectStore } from './projects'
import { IPC, IPC_EVENTS } from '../shared/ipc'
import { TerminalService } from './terminal-service'
import { bindBrowserSecurity } from './browser-security'
import { WindowEffectsService } from './window-effects'
import { assertSubagentSettingsOwner, SubagentSettingsStore } from './subagent-settings'
import { CapabilitySettingsStore } from './capability-settings'
import { QuestionSettingsStore } from './question-settings'
import { assertThemeSettingsOwner, ThemeSettingsStore } from './theme-settings'
import { ProviderVisibilityStore } from './provider-visibility'
import { registerAgentIpc } from './ipc/agent'
import { registerUsageIpc } from './ipc/usage'
import { registerGitIpc } from './ipc/git'
import { registerWindowIpc } from './ipc/window'
import { registerComputerUseIpc, projectComputerUseState } from './ipc/computer-use'
import { ComputerUseService } from './computer-use/service'
import { WaylandComputerUseDriver } from './computer-use/wayland-driver'
import { sameComputerUseOwner, type ComputerUseOwner } from '../shared/computer-use'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type {
  ProjectMeta,
  StartVerificationOptions,
  ToolPermissionRequest,
  VerificationPolicy
} from '../shared/types'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const userDataOverride = process.env.PION_USER_DATA_DIR?.trim()
if (userDataOverride) app.setPath('userData', resolve(userDataOverride))

const runStore = new RunStore(join(app.getPath('userData'), 'pion-runs.json'))
const usageLedger = new UsageLedger({
  ledgerPath: join(app.getPath('userData'), 'pion-usage-ledger.json'),
  sessionRoot: join(getAgentDir(), 'sessions')
})
const terminals = new TerminalService()
const appSettings = new AppSettings()
const subagentSettings = new SubagentSettingsStore()
const questionSettings = new QuestionSettingsStore()
const themeSettings = new ThemeSettingsStore()
let mainWindowId: number | undefined
// Host-only manual workflow ledger. These tokens never claim SDK/run/tool identity.
let localCaptureOwner: ComputerUseOwner | undefined
let localCaptureGeneration = 0
let localCaptureApproved = false
// Host-owned document incarnation; a WebContents id survives renderer reloads.
let captureDocument: { windowId: number; generation: number; ready: boolean; frame?: Electron.WebFrameMain } | undefined
let captureDocumentGeneration = 0
let localCaptureDocumentGeneration: number | undefined
let localCaptureFrame: Electron.WebFrameMain | undefined
let computerUseQuitting = false

function requireCaptureDocument(windowId: number, statusOnly = false): Electron.WebFrameMain {
  const win = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed() && candidate.webContents.id === windowId)
  const document = captureDocument
  if ((computerUseQuitting && !statusOnly) || windowId !== mainWindowId || !document || document.windowId !== windowId || !document.ready || !win || win.webContents.isDestroyed()) throw new Error('ComputerUse document unavailable')
  const frame = win.webContents.mainFrame
  if (!frame || frame.detached || frame !== document.frame) throw new Error('ComputerUse document unavailable')
  return frame
}

function requireLocalCaptureOwner(windowId: number): ComputerUseOwner {
  const frame = requireCaptureDocument(windowId)
  if (!localCaptureApproved || !localCaptureOwner || localCaptureOwner.ownerWindowId !== windowId || localCaptureDocumentGeneration !== captureDocument?.generation || localCaptureFrame !== frame) throw new Error('ComputerUse local owner unavailable')
  return { ...localCaptureOwner }
}

function createLocalCaptureOwner(windowId: number): ComputerUseOwner {
  const frame = requireCaptureDocument(windowId)
  const state = computerUse.getState()
  if (state.actualPending || state.owner) throw new Error('ComputerUse desktop lease occupied')
  localCaptureOwner = { ownerWindowId: windowId, backendId: 'local-preview', runtimeId: `local-preview-${windowId}-${captureDocument!.generation}`, runId: `local-preview-${randomUUID()}`, generation: ++localCaptureGeneration }
  localCaptureDocumentGeneration = captureDocument!.generation
  localCaptureFrame = frame
  localCaptureApproved = true
  return { ...localCaptureOwner }
}

function bindCaptureDocument(contents: Electron.WebContents): void {
  const windowId = contents.id
  // The initial host load has not committed yet and cannot carry approval.
  captureDocument = { windowId, generation: ++captureDocumentGeneration, ready: false }
  const invalidate = (): void => {
    if (captureDocument?.windowId !== windowId || mainWindowId !== windowId) return
    captureDocument = { windowId, generation: ++captureDocumentGeneration, ready: false }
    void stopLocalCapture(windowId).catch(error => console.error('[pion] ComputerUse document cleanup unverified:', error))
  }
  // Electron 44 details are authoritative; positional arguments are deprecated.
  // will-navigate excludes in-page changes and does not cover host loadURL/reload.
  contents.on('will-navigate', () => invalidate())
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument && (!details.frame || details.frame === contents.mainFrame)) invalidate()
  })
  contents.on('did-finish-load', () => {
    if (captureDocument?.windowId !== windowId || mainWindowId !== windowId || contents.isDestroyed() || contents.mainFrame.detached) return
    captureDocument.frame = contents.mainFrame
    captureDocument.ready = true
  })
  contents.on('render-process-gone', invalidate)
  contents.once('destroyed', invalidate)
}
const computerUse = new ComputerUseService({
  clock: () => performance.now(),
  randomId: () => randomUUID(),
  driverFactory: () => {
    // Native packaging is not configured: no asar binary, download or fallback.
    if (app.isPackaged || process.platform !== 'linux' || process.env.XDG_SESSION_TYPE !== 'wayland') throw new Error('ComputerUse helper unavailable')
    return new WaylandComputerUseDriver(join(app.getAppPath(), 'native/computer-use/target/debug/pion-computer-use-helper'))
  },
  assertOwned: (owner) => {
    const win = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed() && candidate.webContents.id === mainWindowId)
    const approvedOwner = requireLocalCaptureOwner(owner.ownerWindowId)
    if (!sameComputerUseOwner(owner, approvedOwner) || !win || win.webContents.isDestroyed()) throw new Error('ComputerUse local approval revoked')
    // This is manual local UI, not an Agent tool: no YOLO or SDK plan-mode grant.
  },
  publish: (state) => {
    const win = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed() && candidate.webContents.id === mainWindowId)
    if (!win || win.webContents.isDestroyed() || mainWindowId === undefined) return
    // Reading redacted status needs a live document, not a still-valid grant.
    // Otherwise host revocation would hide the very stopping/quarantine update.
    try { requireCaptureDocument(mainWindowId, true) } catch { return }
    win.webContents.send(IPC_EVENTS.ComputerUseState, projectComputerUseState(state))
  }
})
function stopLocalCapture(windowId?: number): Promise<import('../shared/computer-use').ComputerUseStatus> {
  if (windowId !== undefined && windowId !== mainWindowId) return Promise.resolve(computerUse.getState())
  const owner = localCaptureOwner
  localCaptureApproved = false
  localCaptureOwner = undefined
  localCaptureDocumentGeneration = undefined
  localCaptureFrame = undefined
  if (owner) computerUse.revoke(owner)
  // No new owner can be installed until this physical lease actually settles.
  return computerUse.stop(undefined, 'host-lifecycle')
}
const windowEffects = new WindowEffectsService(appSettings, {
  platform: process.platform, release: release(), ozonePlatform: app.commandLine.getSwitchValue('ozone-platform'),
  sessionType: process.env.XDG_SESSION_TYPE, desktop: process.env.XDG_CURRENT_DESKTOP,
  hasDisplay: Boolean(process.env.DISPLAY), hasWaylandDisplay: Boolean(process.env.WAYLAND_DISPLAY)
}, () => nativeTheme.shouldUseHighContrastColors)
const providerVisibility = new ProviderVisibilityStore(join(app.getPath('userData'), 'pion-provider-visibility.json'))
const bridge = new AgentBridge(runStore, appSettings, undefined, undefined, providerVisibility)
const capabilitySettings = new CapabilitySettingsStore(join(app.getPath('userData'), 'pion-capabilities.json'))
bridge.configureCapabilitySettings(capabilitySettings)
bridge.configureUsageLedger(usageLedger)
const verification = new VerificationService(join(app.getPath('userData'), 'pion-verification.json'))
const workflowPermissionStore = new ToolPermissionStore()
const workflows = new WorkflowManager({
  filePath: join(app.getPath('userData'), 'pion-workflows.json'),
  worktreeRoot: join(app.getPath('userData'), 'workflow-worktrees'),
  permissionExtensionPath: () => workflowPermissionStore.ensureExtension(),
  verification: new VerificationWorkflowRunner(verification),
  projectTrusted: (cwd) => bridge.getProjectTrust(cwd).decision === 'trusted'
})
terminals.setMutationGuard(() => bridge.assertWorktreeMutationAvailable())
workflows.setMutationGuard(() => bridge.assertWorktreeMutationAvailable())
verification.setMutationGuard(() => bridge.assertWorktreeMutationAvailable())
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

let projectsPushRevision = 0

async function pushProjects(): Promise<void> {
  const revision = ++projectsPushRevision
  const push = projectsPush
  const ownerId = mainWindowId
  const list = await projects.listGrouped()
  if (revision !== projectsPushRevision || push !== projectsPush || ownerId !== mainWindowId) return
  push(list)
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    title: 'Pion',
    ...windowEffects.windowOptions(),
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

  bindBrowserSecurity(win)
  const ownerId = win.webContents.id
  mainWindowId = ownerId
  bindCaptureDocument(win.webContents)
  const push = (list: ProjectMeta[]): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.Projects, list)
  }
  projectsPush = push
  void pushProjects()

  const pushMaximized = (): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.WindowState, win.isMaximized())
  }
  win.on('maximize', pushMaximized)
  win.on('unmaximize', pushMaximized)
  win.once('ready-to-show', () => {
    win.show()
    pushMaximized()
  })
  let captureCloseSettled = false
  let captureClosePending = false
  win.on('close', (event) => {
    if (captureCloseSettled) return
    event.preventDefault()
    if (captureClosePending) return
    captureClosePending = true
    void stopLocalCapture(ownerId).then(state => {
      if (state.actualPending) return // Unknown physical exit stays quarantined.
      captureCloseSettled = true
      if (!win.isDestroyed()) win.close()
    }).catch(error => console.error('[pion] ComputerUse close unverified:', error))
  })
  win.webContents.once('destroyed', () => {
    void stopLocalCapture(ownerId).catch(error => console.error('[pion] ComputerUse destroyed cleanup unverified:', error))
  })
  win.on('closed', () => {
    if (mainWindowId === ownerId) mainWindowId = undefined
    bridge.unbind(win)
    verification.unbind(win)
    workflows.unbind(win)
    git.unbind(win)
  })
  windowEffects.bind(win)
  terminals.bind(win)
  bridge.bind(win)
  verification.bind(win)
  workflows.bind(win)
  git.bind(win)

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[pion] page load FAILED: ${code} ${desc} ${url}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    void stopLocalCapture(ownerId).catch(error => console.error('[pion] ComputerUse renderer cleanup unverified:', error))
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
  registerComputerUseIpc({
    ipcMain, service: computerUse, getMainWindowId: () => mainWindowId,
    createLocalOwner: createLocalCaptureOwner,
    getLocalOwner: requireLocalCaptureOwner
  })
  ipcMain.handle(IPC.GetTheme, (event) => {
    assertThemeSettingsOwner(event, mainWindowId)
    return themeSettings.get()
  })
  ipcMain.handle(IPC.SetTheme, (event, theme: unknown) => {
    assertThemeSettingsOwner(event, mainWindowId)
    return themeSettings.set(theme)
  })
  ipcMain.handle(IPC.GetSubagentSettings, (event) => {
    assertSubagentSettingsOwner(event, mainWindowId)
    return subagentSettings.get()
  })
  ipcMain.handle(IPC.SetSubagentSettings, (event, settings: unknown) => {
    assertSubagentSettingsOwner(event, mainWindowId)
    return subagentSettings.set(settings)
  })
  registerWindowIpc({
    ipcMain,
    windowFromWebContents: (sender) => BrowserWindow.fromWebContents(sender),
    windowEffects,
    terminals,
    questionSettings,
    getMainWindowId: () => mainWindowId,
    reserveMutation: (operation) => bridge.withSessionOperation(operation)
  })
  registerUsageIpc({ ipcMain, ledger: usageLedger, appSettings, getMainWindowId: () => mainWindowId })
  registerAgentIpc({ ipcMain, bridge, projects, pushProjects, getMainWindowId: () => mainWindowId,
    assertWorktreeDeletionIdle: (cwd) => {
      terminals.assertWorktreeDeletionIdle(cwd)
      workflows.assertWorktreeDeletionIdle(cwd)
      verification.assertWorktreeDeletionIdle(cwd)
    }
  })
  registerGitIpc({ ipcMain, git, getMainWindowId: () => mainWindowId })

  // automatic verification --------------------------------------------------
  ipcMain.handle(IPC.VerificationDiscover, (_event, cwd: string, force?: boolean) =>
    verification.discover(cwd, force)
  )
  ipcMain.handle(IPC.VerificationRuns, (_event, cwd?: string, sessionPath?: string) =>
    verification.listRuns(cwd, sessionPath)
  )
  ipcMain.handle(
    IPC.VerificationStart,
    (_event, cwd: string, options?: StartVerificationOptions) => bridge.withSessionOperation(() => verification.start(cwd, options))
  )
  ipcMain.handle(IPC.VerificationRerun, (_event, runId: string) => bridge.withSessionOperation(() => verification.rerun(runId)))
  ipcMain.handle(IPC.VerificationCancel, (_event, runId: string) => verification.cancel(runId))
  ipcMain.handle(IPC.VerificationPolicyGet, (_event, cwd: string) => verification.getPolicy(cwd))
  ipcMain.handle(
    IPC.VerificationPolicySet,
    (_event, cwd: string, updates: Partial<Omit<VerificationPolicy, 'cwd'>>) =>
      verification.setPolicy(cwd, updates)
  )

  // bounded multi-agent workflows ------------------------------------------
  ipcMain.handle(IPC.WorkflowList, (_event, cwd?: string) => workflows.list(cwd))
  ipcMain.handle(IPC.WorkflowCreate, (_event, request) => bridge.withSessionOperation(() => workflows.create(request)))
  ipcMain.handle(IPC.WorkflowStart, (_event, id: string) => bridge.withSessionOperation(() => workflows.start(id)))
  ipcMain.handle(IPC.WorkflowApprovePlan, (_event, id: string) => bridge.withSessionOperation(() => workflows.approvePlan(id)))
  ipcMain.handle(IPC.WorkflowRepair, (_event, id: string) => bridge.withSessionOperation(() => workflows.repair(id)))
  ipcMain.handle(IPC.WorkflowWaiveTests, (_event, id: string) => bridge.withSessionOperation(() => workflows.waiveTests(id)))
  ipcMain.handle(IPC.WorkflowResume, (_event, id: string) => bridge.withSessionOperation(() => workflows.resume(id)))
  ipcMain.handle(IPC.WorkflowCancel, (_event, id: string) => workflows.cancel(id))
  ipcMain.handle(IPC.WorkflowMerge, (_event, id: string) => bridge.withSessionOperation(() => workflows.merge(id)))
  ipcMain.handle(IPC.WorkflowCleanup, (_event, id: string) => bridge.withSessionOperation(() => workflows.cleanup(id)))

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

  // projects ----------------------------------------------------------------------
  ipcMain.handle(IPC.ProjectsList, () => projects.listGrouped())
  ipcMain.handle(IPC.ProjectsAdd, async (_event, cwd: string) => {
    await projects.touchCanonical(cwd)
    await pushProjects()
    return projects.listGrouped()
  })
  ipcMain.handle(IPC.ProjectsRemove, async (_event, cwd: string) => {
    await projects.removeCanonical(cwd)
    await pushProjects()
    return projects.listGrouped()
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
  usageLedger.setBackgroundCollectionEnabled(appSettings.usageBackgroundCollectionEnabled)
  registerIpc()
  nativeTheme.on('updated', () => { void windowEffects.refresh() })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let windowShutdown: Promise<unknown> = Promise.resolve()
app.on('window-all-closed', () => {
  windowShutdown = Promise.all([bridge.stop(), verification.flush(), workflows.shutdown()])
  void windowShutdown.catch((error) => console.error('[pion] window shutdown incomplete:', error))
  if (process.platform !== 'darwin') app.quit()
})

let captureQuitSettled = false
let captureQuitPending = false
app.on('before-quit', (event) => {
  usageLedger.stopBackgroundCollection()
  if (!captureQuitSettled) {
    event.preventDefault()
    computerUseQuitting = true
    if (!captureQuitPending) {
      captureQuitPending = true
      void stopLocalCapture().then(async state => {
        if (state.actualPending) return // Never force-exit an unknown helper lease.
        await windowShutdown
        await bridge.stop()
        try { await usageLedger.flush() } catch (error) {
          // Data collection failures do not trap quit. Unknown physical closes do.
          if (error instanceof UsageLedgerError && error.closeUnknown) throw error
          console.warn('[pion] usage collection incomplete at quit:', error)
        }
        captureQuitSettled = true
        app.quit()
      }).catch(error => console.error('[pion] shutdown unverified:', error))
    }
    return
  }
  bridge.disposeSubagentSessions()
  terminals.dispose()
  void Promise.all([bridge.stop(), verification.flush(), workflows.shutdown()])
})
