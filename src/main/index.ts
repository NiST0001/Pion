import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, Notification } from 'electron'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir, release } from 'node:os'
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
import { TerminalService } from './terminal-service'
import { WindowEffectsService } from './window-effects'
import { assertSubagentSettingsOwner, SubagentSettingsStore } from './subagent-settings'
import { assertThemeSettingsOwner, ThemeSettingsStore } from './theme-settings'
import { registerAgentIpc } from './ipc/agent'
import { registerGitIpc } from './ipc/git'
import { registerWindowIpc } from './ipc/window'
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
const terminals = new TerminalService()
const appSettings = new AppSettings()
const subagentSettings = new SubagentSettingsStore()
const themeSettings = new ThemeSettingsStore()
let mainWindowId: number | undefined
const windowEffects = new WindowEffectsService(appSettings, {
  platform: process.platform, release: release(), ozonePlatform: app.commandLine.getSwitchValue('ozone-platform'),
  sessionType: process.env.XDG_SESSION_TYPE, desktop: process.env.XDG_CURRENT_DESKTOP,
  hasDisplay: Boolean(process.env.DISPLAY), hasWaylandDisplay: Boolean(process.env.WAYLAND_DISPLAY)
}, () => nativeTheme.shouldUseHighContrastColors)
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

  const ownerId = win.webContents.id
  mainWindowId = ownerId
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
    terminals
  })
  registerAgentIpc({ ipcMain, bridge, projects, pushProjects })
  registerGitIpc({ ipcMain, git })

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
  ipcMain.handle(IPC.ProjectsList, () => projects.list())
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
  nativeTheme.on('updated', () => { void windowEffects.refresh() })
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
  terminals.dispose()
  void Promise.all([bridge.stop(), verification.flush(), workflows.shutdown()])
})
