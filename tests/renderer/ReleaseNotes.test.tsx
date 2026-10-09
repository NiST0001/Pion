// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { ReleaseNotes } from '../../src/renderer/src/features/settings/ReleaseNotes'
import { RELEASE_NOTES } from '../../src/shared/release-notes'

it('shows bundled versions and expands only the newest release by default', () => {
  const { container } = render(<ReleaseNotes />)
  expect(screen.getByRole('region', { name: '更新日志' })).toBeInTheDocument()
  expect(screen.getByText(/不会联网检查更新/)).toBeInTheDocument()
  const details = [...container.querySelectorAll('details')]
  expect(details).toHaveLength(RELEASE_NOTES.length)
  for (const [index, release] of RELEASE_NOTES.entries()) {
    expect(screen.getByText(`v${release.version}`)).toBeInTheDocument()
    expect(details[index].open).toBe(index === 0)
    const changes = [...details[index].querySelectorAll('li')]
    expect(changes).toHaveLength(release.changes.length)
    expect(changes.map((change) => change.textContent)).toEqual([...release.changes])
  }
})

it('keeps bundled versions unique and in descending numeric order', () => {
  const versions = RELEASE_NOTES.map((release) => release.version)
  expect(new Set(versions).size).toBe(versions.length)
  for (const version of versions) expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  const newestFirst = [...versions].sort((a, b) => {
    const left = a.split('.').map(Number)
    const right = b.split('.').map(Number)
    return right[0] - left[0] || right[1] - left[1] || right[2] - left[2]
  })
  expect(versions).toEqual(newestFirst)
})

it('adds 0.1.68 while preserving existing entries and omitting local install-only versions', () => {
  const versions = RELEASE_NOTES.map((release) => release.version)
  expect(versions[0]).toBe('0.1.68')
  expect(versions[1]).toBe('0.1.67')
  // Keep every already-bundled release without fabricating local install history.
  expect(versions.slice(1)).toEqual([
    '0.1.67', '0.1.51', '0.1.50', '0.1.49', '0.1.47', '0.1.44', '0.1.41',
    '0.1.40', '0.1.38', '0.1.37', '0.1.33', '0.1.30', '0.1.27', '0.1.26'
  ])
  for (let patch = 52; patch <= 66; patch++) {
    expect(versions).not.toContain(`0.1.${patch}`)
  }
})

it('documents restoration, read-only MCP status and scoped cleanup without overstating availability', () => {
  const changes = RELEASE_NOTES[0].changes
  expect(changes).toHaveLength(4)
  const [restoration, mcpPage, mcpStatus, cleanup] = changes
  expect(restoration).toMatch(/会话状态、缓存与磁盘历史.*重复显示消息.*真实消息身份与撤销关联/)
  expect(restoration).toContain('长轮次跨页恢复的消息与工具顺序')
  expect(restoration).toContain('归并移动已有行时保留阅读位置')
  expect(restoration).toMatch(/迟到增量与终态.*相同文字的真实重发不按文本合并或删除/)
  expect(mcpPage).toMatch(/技能与工具.*MCP 状态页.*现有后端.*服务器状态.*登记工具数.*曝光方式/)
  expect(mcpPage).toContain('不代表当前可执行或已获准的工具数')
  expect(mcpStatus).toContain('状态未知、禁用、旧插件接管及超时/过期均有明确提示')
  expect(mcpStatus).toContain('刷新仅读取缓存，不创建连接、重连或触发认证')
  expect(mcpStatus).toContain('原生 MCP 启动仍可能连接服务器、执行配置命令或触发认证')
  expect(mcpStatus).toContain('真实 MCP 兼容性尚未验证')
  expect(cleanup).toMatch(/Git 差异生成与文件状态解析.*任务\/队列折叠偏好.*原生\/插件工具卡片/)
  expect(cleanup).toContain('移除未使用的旧布局辅助代码')
  expect(cleanup).toContain('保留原有默认值、存储键和安全防护')
})
