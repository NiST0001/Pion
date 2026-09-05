import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '../..')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

test('boots the Electron shell with an immediately editable composer', async ({}, testInfo) => {
  const userData = testInfo.outputPath('user-data')
  const piAgentDir = join(userData, 'pi-agent')
  const workspace = testInfo.outputPath('workspace')
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(piAgentDir, { recursive: true }),
    mkdir(workspace, { recursive: true })
  ])
  const now = Date.now()
  await Promise.all([
    writeFile(join(userData, 'projects.json'), JSON.stringify({
      projects: [{ cwd: workspace, name: 'workspace', addedAt: now, lastUsedAt: now }]
    })),
    writeFile(join(userData, 'pion-runs.json'), JSON.stringify({
      version: 1,
      runs: [{
        id: 'e2e-run',
        cwd: workspace,
        kind: 'prompt',
        state: 'completed',
        createdAt: now - 31_000,
        agentStartedAt: now - 31_000,
        settledAt: now,
        modelId: 'e2e-model',
        prompt: { message: 'metrics fixture', images: [] },
        promptPreview: 'metrics fixture',
        usage: { input: 20_000, output: 3_000, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 23_000, costUsd: 0.06 },
        contextTokens: 42_000,
        contextWindow: 100_000,
        contextPressure: 0.42,
        tools: [],
        compactions: [],
        revision: 1
      }]
    }))
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
    await expect(page.locator('.workflow-panel')).toHaveCount(0)
    await expect(page.locator('.verification-panel')).toHaveCount(0)
    const metrics = page.locator('.main > .run-metrics-strip')
    await expect(metrics).toContainText('23k tokens')
    await expect(metrics).toContainText('$0.060')
    await expect(page.locator('.composer-dock .run-metrics-strip')).toHaveCount(0)
    const contextRing = page.locator('.send-context-ring')
    await expect(contextRing).toHaveAttribute('role', 'progressbar')
    await expect(contextRing).toHaveAttribute('aria-valuenow', '42')
    await expect(page.locator('.send-button-context')).toHaveAttribute('title', /42%.*42,000 \/ 100,000 tokens/)

    await composer.fill('/agents')
    await composer.press('Enter')
    await expect(page.getByRole('dialog', { name: '隔离多 Agent' })).toBeVisible()
    await expect(page.locator('.operations-modal .workflow-panel.embedded')).toBeVisible()
    await page.getByRole('button', { name: '关闭隔离多 Agent' }).click()

    await composer.fill('/verify')
    await composer.press('Enter')
    await expect(page.getByRole('dialog', { name: '项目自动验证' })).toBeVisible()
    await expect(page.locator('.operations-modal .verification-panel.embedded')).toBeVisible()
    await page.getByRole('button', { name: '关闭项目自动验证' }).click()
    await expect(page.locator('.operations-modal')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('uninstalls an npm plugin when npm is unavailable', async ({}, testInfo) => {
  const userData = testInfo.outputPath('plugin-user-data')
  const piAgentDir = join(userData, 'pi-agent')
  const binDir = testInfo.outputPath('plugin-bin')
  const logPath = testInfo.outputPath('package-manager.log')
  await Promise.all([
    mkdir(join(piAgentDir, 'npm'), { recursive: true }),
    mkdir(binDir, { recursive: true })
  ])
  await writeFile(join(piAgentDir, 'settings.json'), JSON.stringify({ packages: ['npm:pi-subagents'] }))
  await writeFile(join(piAgentDir, 'npm', 'package.json'), JSON.stringify({
    private: true,
    dependencies: { 'pi-subagents': '1.0.0' }
  }))
  const bunPath = join(binDir, 'bun')
  await writeFile(bunPath, '#!/bin/sh\nprintf "%s\\n" "$@" > "$PION_FAKE_PM_LOG"\n')
  await chmod(bunPath, 0o755)

  const app = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      PATH: binDir,
      PION_USER_DATA_DIR: userData,
      PI_CODING_AGENT_DIR: piAgentDir,
      PION_FAKE_PM_LOG: logPath,
      PION_E2E: '1'
    }
  })

  try {
    const page = await app.firstWindow()
    const result = await page.evaluate(() => window.pion.uninstallPlugin('npm:pi-subagents'))
    expect(result.output).toContain('已使用 bun 卸载 npm:pi-subagents')
    expect(await readFile(logPath, 'utf8')).toContain('uninstall\npi-subagents\n--cwd\n')
    const settings = JSON.parse(await readFile(join(piAgentDir, 'settings.json'), 'utf8')) as { packages?: string[]; npmCommand?: string[] }
    expect(settings.packages).toEqual([])
    expect(settings.npmCommand).toBeUndefined()
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
  await mkdir(join(repo, 'src', 'components'), { recursive: true })
  await writeFile(join(repo, 'src', 'components', 'file.txt'), 'before\n')
  git(repo, 'add', 'src/components/file.txt')
  git(repo, 'commit', '-qm', 'base')
  await writeFile(join(repo, 'src', 'components', 'file.txt'), 'after\n')
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
    await expect(page.getByRole('tree', { name: '修改文件树' })).toBeVisible()
    await expect(page.getByRole('treeitem', { name: '收起目录 src' })).toBeVisible()
    await expect(page.getByRole('treeitem', { name: '收起目录 src/components' })).toBeVisible()
    const file = page.getByTitle('src/components/file.txt').last()
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
