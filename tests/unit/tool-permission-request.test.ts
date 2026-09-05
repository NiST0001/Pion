import { describe, expect, it } from 'vitest'
import { parseToolPermissionMetadata } from '../../src/main/agent/tool-permission-request'
import { TOOL_PERMISSION_MARKER } from '../../src/main/tool-permissions'

function titleFor(metadata: unknown): string {
  return `${TOOL_PERMISSION_MARKER}${JSON.stringify(metadata)}`
}

describe('parseToolPermissionMetadata', () => {
  it('parses a valid permission request and clamps field sizes', () => {
    const parsed = parseToolPermissionMetadata(titleFor({
      cwd: '/tmp/project',
      sessionPath: '/tmp/session.jsonl',
      toolName: 'write',
      category: 'write',
      policyCategories: ['write', 'write'],
      summary: 'x'.repeat(600),
      detail: 'y'.repeat(5000),
      risks: ['sensitive-path', 'bogus'],
      canRemember: true
    }))

    expect(parsed).toMatchObject({
      cwd: '/tmp/project',
      sessionPath: '/tmp/session.jsonl',
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
      cwd: '/tmp/project',
      toolName: 'bash',
      category: 'shell',
      policyCategories: [],
      summary: 's',
      detail: 'd'
    }))).toBeNull()
    expect(parseToolPermissionMetadata(titleFor({
      cwd: '/tmp/project',
      toolName: 'bash',
      category: 'bogus',
      policyCategories: ['shell'],
      summary: 's',
      detail: 'd'
    }))).toBeNull()
  })
})
