import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// Source contracts only; actual Chromium scrollbar rendering requires separate GUI validation.
it('reserves the sidebar scrollbar gutter and keeps pending folder controls at their normal opacity', () => {
  const sidebar = readFileSync('src/renderer/src/styles/sidebar.css', 'utf8')
  const scroll = sidebar.match(/\.sidebar-scroll\s*\{([^}]+)\}/)?.[1]
  expect(scroll).toContain('scrollbar-gutter: stable')
  expect(scroll).toContain('overflow-y: auto')
  expect(scroll).not.toMatch(/(?:^|;)\s*height\s*:/)
  const folders = readFileSync('src/renderer/src/styles/session-organization.css', 'utf8')
  const disabled = folders.match(/\.session-folder-tree button:disabled\s*\{([^}]+)\}/)?.[1]
  expect(disabled).toBeDefined()
  expect(disabled).not.toContain('opacity:')
  expect(folders).toContain('.session-folder-content[hidden] { display: none; }')
  const pendingStatus = folders.match(/\.session-folder-status\s*\{([^}]+)\}/)?.[1]
  expect(pendingStatus).toContain('position: absolute')
  expect(pendingStatus).toContain('clip-path: inset(50%)')
  const rows = readFileSync('src/renderer/src/styles/refinements/project.css', 'utf8')
  expect(rows).toMatch(/\.side-session\[aria-disabled='true'\] \.side-session-favorite[^{}]*\{\s*opacity: 1;/)
})
