import type { IpcMain } from 'electron'
import type { GitService } from '../git-service'
import { IPC } from '../../shared/ipc'
import type { GitDiffScope, GitSelectionRequest } from '../../shared/types'
import type { GitCommitTreeCursor } from '../../shared/git-commit-tree'

interface GitIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  git: GitService
  getMainWindowId: () => number | undefined
}

export function registerGitIpc({ ipcMain, git, getMainWindowId }: GitIpcDependencies): void {
  ipcMain.handle(IPC.GitCommitTree, (event, cwd: string, cursor?: GitCommitTreeCursor) => {
    const owner = getMainWindowId()
    const sender = event.sender
    const frame = event.senderFrame
    const assertCurrent = (): void => {
      if (owner === undefined || getMainWindowId() !== owner || sender.id !== owner
        || sender.isDestroyed() || !frame || event.senderFrame !== frame || sender.mainFrame !== frame) {
        throw new Error('只允许所属主窗口读取 Git 提交树')
      }
    }
    assertCurrent()
    return git.getCommitTree(cwd, cursor).then((page) => {
      assertCurrent()
      return page
    })
  })
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
}
