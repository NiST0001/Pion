import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '../..')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

test('boots the Electron shell with an immediately editable composer', async ({}, testInfo) => {
  const userData = testInfo.outputPath('user-data')
  const piAgentDir = join(userData, 'pi-agent')
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(piAgentDir, { recursive: true })
  ])

  const app = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      PION_USER_DATA_DIR: userData,
      PI_CODING_AGENT_DIR: piAgentDir,
      PION_E2E: '1'
    }
  })

  try {
    const page = await app.firstWindow()
    await expect(page).toHaveTitle(/Pion/)
    const composer = page.locator('.composer textarea')
    await expect(composer).toBeVisible()
    await expect(composer).toBeEditable()
    await composer.fill('draft survives agent preparation')
    await expect(composer).toHaveValue('draft survives agent preparation')
    await expect(page.locator('.titlebar')).toBeVisible()
    await expect(page.locator('.sidebar')).toBeVisible()
    await expect(page.locator('.workflow-panel')).toBeVisible()
    await page.locator('.workflow-toggle').click()
    await expect(page.getByText('创建一个有边界、可见、可取消的隔离多 Agent 工作流。')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('reviews, stages, and commits a live Git worktree', async ({}, testInfo) => {
  const userData = testInfo.outputPath('git-user-data')
  const piAgentDir = join(userData, 'pi-agent')
  const repo = testInfo.outputPath('repo')
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(piAgentDir, { recursive: true }),
    mkdir(repo, { recursive: true })
  ])
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.name', 'Pion E2E')
  git(repo, 'config', 'user.email', 'pion-e2e@example.invalid')
  await writeFile(join(repo, 'file.txt'), 'before\n')
  git(repo, 'add', 'file.txt')
  git(repo, 'commit', '-qm', 'base')
  await writeFile(join(repo, 'file.txt'), 'after\n')
  await writeFile(join(userData, 'projects.json'), JSON.stringify({
    projects: [{ cwd: repo, name: 'repo', addedAt: Date.now(), lastUsedAt: Date.now() }]
  }))

  const app = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      PION_USER_DATA_DIR: userData,
      PI_CODING_AGENT_DIR: piAgentDir,
      PION_E2E: '1'
    }
  })

  try {
    const page = await app.firstWindow()
    const file = page.getByTitle('file.txt').last()
    await expect(file).toBeVisible()
    await file.click()
    await expect(page.locator('.git-diff-hunk')).toBeVisible()
    await page.getByRole('button', { name: '暂存文件' }).click()
    await expect(page.getByText('已暂存', { exact: true }).first()).toBeVisible()
    await page.getByPlaceholder('提交说明').fill('commit from Pion')
    await page.getByRole('button', { name: /提交 1 个文件/ }).click()
    await expect(page.getByText('工作区干净', { exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})
