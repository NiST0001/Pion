import { _electron as electron, expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const projectRoot = resolve(import.meta.dirname, '../..')

test('switching from a scrolled long session to a short session leaves no stale blank scroll range', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const userData = testInfo.outputPath('user-data')
  const agentDir = join(userData, 'pi-agent')
  const workspace = testInfo.outputPath('workspace')
  const sessionDir = join(agentDir, 'sessions', `--${workspace.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)
  await Promise.all([mkdir(sessionDir, { recursive: true }), mkdir(workspace, { recursive: true })])
  // Avoid inheriting the surrounding Pion repository as this fixture's branch.
  execFileSync('git', ['init', '-b', 'main', workspace], { stdio: 'ignore' })
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(workspace, '.no-hooks')}`, 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'ignore' })
  await writeFile(join(userData, 'projects.json'), JSON.stringify({ projects: [{ cwd: workspace, name: 'scroll-fixture', addedAt: Date.now(), lastUsedAt: Date.now() }] }))
  for (const [label, turns] of [['LONG_SCROLL_FIXTURE', 16], ['SHORT_SCROLL_FIXTURE', 1]] as const) {
    const id = randomUUID()
    const lines: unknown[] = [{ type: 'session', version: 3, id, cwd: workspace, timestamp: new Date().toISOString() }]
    let parentId: string | null = null
    for (let n = 0; n < turns; n++) {
      const userId = `user-${n}`, assistantId = `assistant-${n}`
      lines.push({ type: 'message', id: userId, parentId, timestamp: new Date().toISOString(),
        message: { role: 'user', timestamp: Date.now(), content: [{ type: 'text', text: n === 0 ? label : `Question ${n}` }] } })
      lines.push({ type: 'message', id: assistantId, parentId: userId, timestamp: new Date().toISOString(),
        message: { role: 'assistant', timestamp: Date.now(), api: 'openai-responses', provider: 'fixture', model: 'fixture', stopReason: 'stop',
          content: [{ type: 'text', text: turns === 1 ? 'SHORT_SESSION_END' : (`Paragraph ${n}: retained history content.\n\n`).repeat(18) }],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } })
      parentId = assistantId
    }
    await writeFile(join(sessionDir, `${label}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  }
  const app = await electron.launch({
    args: [projectRoot, ...(process.platform === 'linux' ? ['--ozone-platform=x11', '--disable-gpu'] : [])],
    cwd: projectRoot,
    env: { ...process.env, PION_USER_DATA_DIR: userData, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PION_E2E: '1' }
  })
  try {
    const page = await app.firstWindow()
    const long = page.locator('[data-session-path]').filter({ hasText: 'LONG_SCROLL_FIXTURE' })
    const short = page.locator('[data-session-path]').filter({ hasText: 'SHORT_SCROLL_FIXTURE' })
    await expect(long).toBeVisible({ timeout: 45_000 })
    // Inject the delayed/no-movement browser scroll delivery while the actual
    // Electron DOM displays its loading placeholder, without synthesizing a
    // wheel or pointer gesture that could legitimately preserve blank space.
    const scrollProbe = await page.evaluateHandle(() => {
      let deliveries = 0
      let delivered = false
      const observer = new MutationObserver(() => {
        const surface = document.querySelector<HTMLElement>('.chat-scroll-surface')
        const scroller = document.querySelector<HTMLElement>('.chat-scroll')
        if (surface?.querySelector('.timeline')) delivered = false
        if (!delivered && surface?.style.minHeight && scroller && !surface.querySelector('.timeline')) {
          delivered = true
          deliveries++
          scroller.dispatchEvent(new Event('scroll'))
        }
      })
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] })
      return { get deliveries() { return deliveries } }
    })
    for (let pass = 0; pass < 3; pass++) {
      await long.click()
      await expect(page.locator('.timeline')).toContainText('Paragraph')
      const scroller = page.locator('.chat-scroll')
      await scroller.hover()
      await page.mouse.wheel(0, -500)
      await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(20)
      await short.click()
      await expect(page.locator('.timeline')).toContainText('SHORT_SESSION_END')
      await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(2)
      await expect(page.locator('.chat-scroll-surface')).not.toHaveAttribute('style', /min-height:\s*\d/)
      await scroller.hover()
      await page.mouse.wheel(0, 700)
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(2)
    }
    expect(await scrollProbe.evaluate((probe) => probe.deliveries)).toBeGreaterThan(0)
    await expect(page.locator('.composer textarea')).not.toHaveAttribute('placeholder', /正在准备/, { timeout: 45_000 })
    await expect.poll(() => page.locator('.chat-scroll').evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(2)
    await expect(page.locator('.bubble-assistant')).toHaveCSS('opacity', '1')
    await expect(page.locator('.bubble-user')).toHaveCSS('opacity', '1')
    await page.screenshot({ path: testInfo.outputPath('short-session-no-blank.png') })
  } finally { await app.close() }
})
