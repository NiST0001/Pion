import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseToolPermissionMetadata } from '../../src/main/agent/tool-permission-request'
import { TOOL_PERMISSION_MARKER } from '../../src/main/tool-permissions'

function titleFor(metadata: unknown): string {
  return `${TOOL_PERMISSION_MARKER}${JSON.stringify(metadata)}`
}

// 用平台无关的绝对路径，避免 '/tmp/project' 这类 POSIX 路径在 Windows 上被解析到当前盘符
const projectCwd = resolve(join(tmpdir(), 'pion-permission-project'))
const sessionPath = resolve(join(tmpdir(), 'pion-permission-session.jsonl'))

describe('parseToolPermissionMetadata', () => {
  it('parses a valid permission request and clamps field sizes', () => {
    const parsed = parseToolPermissionMetadata(titleFor({
      cwd: projectCwd,
      sessionPath,
      toolName: 'write',
      category: 'write',
      policyCategories: ['write', 'write'],
      summary: 'x'.repeat(600),
      detail: 'y'.repeat(5000),
      risks: ['sensitive-path', 'bogus'],
      canRemember: true
    }))

    expect(parsed).toMatchObject({
      cwd: projectCwd,
      sessionPath,
      toolName: 'write',
      category: 'write',
      policyCategories: ['write'],
      risks: ['sensitive-path'],
      canRemember: true
    })
    expect(parsed?.summary).toHaveLength(500)
    expect(parsed?.detail).toHaveLength(4000)
  })

  it('rejects malformed or incomplete metadata', () => {
    expect(parseToolPermissionMetadata('no marker')).toBeNull()
    expect(parseToolPermissionMetadata(`${TOOL_PERMISSION_MARKER}not-json`)).toBeNull()
    expect(parseToolPermissionMetadata(titleFor({ toolName: 'write' }))).toBeNull()
    expect(parseToolPermissionMetadata(titleFor({
      cwd: projectCwd,
      toolName: 'bash',
      category: 'shell',
      policyCategories: [],
      summary: 's',
      detail: 'd'
    }))).toBeNull()
    expect(parseToolPermissionMetadata(titleFor({
      cwd: projectCwd,
      toolName: 'bash',
      category: 'bogus',
      policyCategories: ['shell'],
      summary: 's',
      detail: 'd'
    }))).toBeNull()
  })
})
