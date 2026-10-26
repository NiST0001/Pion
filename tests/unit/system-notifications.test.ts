import { describe, expect, it } from 'vitest'
import {
  formatSessionCompletionNotification, formatToolPermissionNotification, notificationText
} from '../../src/main/system-notifications'
import type { ToolPermissionCategory, ToolPermissionRequest } from '../../src/shared/types'

function permission(overrides: Partial<ToolPermissionRequest> = {}): ToolPermissionRequest {
  return {
    id: 'permission-1', cwd: '/home/user/project', sessionPath: '/private/sessions/run.jsonl',
    toolName: 'bash', category: 'shell', policyCategories: ['shell'],
    summary: '执行项目命令', detail: 'PRIVATE_DETAIL raw args secret',
    risks: [], canRemember: false, createdAt: 1000,
    timeoutAt: new Date(2026, 5, 1, 14, 5, 9).getTime(),
    ...overrides
  }
}

describe('system notification formatting', () => {
  it('shares safe text cleanup with code-point limits for source summaries', () => {
    expect(notificationText(undefined)).toBe('')
    expect(notificationText('😀'.repeat(61))).toBe('😀'.repeat(59) + '…')
    expect(notificationText('😀'.repeat(181), 180)).toBe('😀'.repeat(179) + '…')
    expect(notificationText('\x1b[31m**完成**\x1b[0m \x1b]0;hidden-title\x07data:text/plain,PRIVATE', 180)).toBe('完成')
  })

  it('keeps each completion attached to its supplied session and actual known turn facts', () => {
    const first = formatSessionCompletionNotification({
      cwd: '/home/user/project/.pion-worktrees/feature-a', sessionName: '修复导航',
      sessionId: '12345678-abcd', sessionPath: '/private/sessions/filename.jsonl',
      durationMs: 3_661_999, toolCount: 4, summary: '**完成导航修复**'
    })
    const second = formatSessionCompletionNotification({
      cwd: '/home/user/project', sessionName: '整理文档', sessionId: 'abcdefgh-other', summary: '文档已更新'
    })
    expect(first.title).toBe('Pion · 输出完成')
    expect(first.body).toContain('项目/工作树：feature-a\n会话：修复导航\nSDK短ID：12345678')
    expect(first.body).toContain('回复摘要：完成导航修复\n本轮耗时：1小时1分1秒\n本轮工具调用：4次')
    expect(first.body).not.toContain('filename.jsonl')
    expect(second.body).toContain('会话：整理文档\nSDK短ID：abcdefgh')
    expect(second.body).not.toMatch(/12345678|修复导航|本轮耗时|本轮工具调用/)
  })

  it('uses explicit session-file basenames across platforms and leaves unknown facts absent', () => {
    for (const [cwd, sessionPath] of [
      ['/home/user/work/project/', '/home/user/.pi/sessions/2026_uuid.jsonl'],
      ['C:\\Users\\someone\\work\\project\\', 'C:\\Users\\someone\\.pi\\sessions\\2026_uuid.jsonl']
    ]) {
      const { body } = formatSessionCompletionNotification({ cwd, sessionPath })
      expect(body).toContain('项目/工作树：project\n会话：未命名\n会话文件：2026_uuid.jsonl')
      expect(body).not.toMatch(/SDK短ID|本轮耗时|本轮工具调用|回复摘要|home|Users|someone/)
    }
    expect(formatSessionCompletionNotification({ cwd: '' }).body).toContain('项目/工作树：未命名')
  })

  it('bounds Unicode text and strips controls and decoration without repeating the settings privacy notice', () => {
    const notice = formatSessionCompletionNotification({
      cwd: '/project', sessionName: '\x1b[31m**会话**\x1b[0m\n\u202e' + '😀'.repeat(100),
      summary: '\x1b]0;hidden-title\x07### `结果`\u0000 ' + '😀'.repeat(5000)
    })
    const name = notice.body.split('\n').find((line) => line.startsWith('会话：'))!.slice(3)
    const summary = notice.body.split('\n').find((line) => line.startsWith('回复摘要：'))!.slice(5)
    expect(Array.from(name).length).toBeLessThanOrEqual(60)
    expect(Array.from(summary).length).toBeLessThanOrEqual(180)
    expect(Array.from(notice.body).length).toBeLessThanOrEqual(650)
    expect(notice.body).not.toMatch(/[\u0000-\u0009\u001b\u202e\ud800-\udfff]/u)
    expect(notice.body).not.toMatch(/hidden-title|\*\*|`|###/)
    expect(notice.body).toContain('结果')
    expect(notice.body).not.toMatch(/锁屏|敏感信息/)
  })

  it('omits ordinary data URIs and embedded media from display text', () => {
    const { body } = formatSessionCompletionNotification({
      cwd: '/project',
      summary: '完成 ![预览](data:image/png;base64,MARKDOWN_IMAGE) data:image/png;base64,RAW_IMAGE '
        + 'data:text/plain,PLAIN_TEXT data:application/json;base64,RAW_JSON <img src="data:image/png;base64,HTML_IMAGE"> '
        + '<audio src="data:audio/wav;base64,AUDIO">MEDIA_FALLBACK</audio> 后续步骤'
    })
    expect(body).toContain('回复摘要：完成 后续步骤')
    expect(body).not.toMatch(/data:|MARKDOWN_IMAGE|RAW_IMAGE|PLAIN_TEXT|RAW_JSON|HTML_IMAGE|AUDIO|MEDIA_FALLBACK|<img|<audio/)
    const longMedia = formatSessionCompletionNotification({
      cwd: '/project', summary: '完成 data:image/png;base64,' + 'A'.repeat(8000)
    }).body
    expect(longMedia).toContain('回复摘要：完成')
    expect(longMedia).not.toMatch(/data:|AAAA/)
    expect(Array.from(longMedia).length).toBeLessThanOrEqual(650)
    const permissionBody = formatToolPermissionNotification(permission({
      summary: '待批准 data:video/mp4;base64,VIDEO'
    })).body
    expect(permissionBody).toContain('请求摘要：待批准')
    expect(permissionBody).not.toMatch(/data:|VIDEO/)
  })

  it('shows permission category, real risks, subagent, summary, and source timeout without copying detail', () => {
    const request = permission({
      risks: ['outside-workspace', 'sensitive-path', 'destructive-command'], subagent: true
    })
    const notice = formatToolPermissionNotification(request, { sessionName: '检查发布', sessionId: 'real-sdk-id' })
    expect(notice.title).toBe('Pion · 需要批准')
    expect(notice.body).toContain('项目/工作树：project\n会话：检查发布\nSDK短ID：real-sdk')
    expect(notice.body).toContain('工具：bash\n类别：执行命令\n风险：项目目录外、敏感路径、高风险命令\n来源：子代理')
    expect(notice.body).toContain('请求摘要：执行项目命令\n本地到期：14:05:09')
    expect(notice.body).not.toMatch(/PRIVATE_DETAIL|raw args|secret|private\/sessions|会话文件|锁屏|敏感信息/)
    expect(notice.body.endsWith('点击返回 Pion 确认')).toBe(true)
    expect(Object.keys(notice).sort()).toEqual(['body', 'title'])

    const plain = formatToolPermissionNotification(permission({ timeoutAt: NaN, summary: '' }))
    expect(plain.body).toContain('会话：未命名\n会话文件：run.jsonl')
    expect(plain.body).not.toMatch(/风险：|来源：子代理|本地到期：|请求摘要：/)
  })

  it('lists all effective policy categories once in whitelist order and falls back to the primary category', () => {
    const { body } = formatToolPermissionNotification(permission({
      policyCategories: ['external', 'network', 'shell', 'write', 'read', 'shell', 'unknown' as ToolPermissionCategory]
    }))
    expect(body).toContain('类别：读取文件、写入文件、执行命令、网络访问、外部工具\n')
    expect(body).not.toContain('unknown')
    for (const policyCategories of [undefined, [], ['unknown' as ToolPermissionCategory]]) {
      const fallback = formatToolPermissionNotification(permission({ policyCategories }))
      expect(fallback.body).toContain('类别：执行命令\n')
    }
  })

  it('omits invalid durations and counts, preserves known zero, and caps even a maximal permission body', () => {
    for (const invalid of [-1, NaN, Infinity, -Infinity]) {
      const { body } = formatSessionCompletionNotification({ cwd: '/project', durationMs: invalid, toolCount: invalid })
      expect(body).not.toMatch(/本轮耗时|本轮工具调用/)
    }
    const zero = formatSessionCompletionNotification({ cwd: '/project', durationMs: 0, toolCount: 0 })
    expect(zero.body).toContain('本轮耗时：<1秒\n本轮工具调用：0次')
    const long = '😀'.repeat(5000)
    const maximal = formatToolPermissionNotification(permission({
      cwd: `/${long}`, sessionPath: `/${long}`, toolName: long, summary: long,
      policyCategories: ['read', 'write', 'shell', 'network', 'external'],
      risks: ['outside-workspace', 'sensitive-path', 'destructive-command'], subagent: true
    }), { sessionName: long })
    expect(Array.from(maximal.body).length).toBeLessThanOrEqual(650)
    expect(maximal.body).toContain('类别：读取文件、写入文件、执行命令、网络访问、外部工具')
    expect(maximal.body).toContain('本地到期：14:05:09')
    expect(maximal.body).not.toMatch(/锁屏|敏感信息/)
    expect(maximal.body.endsWith('点击返回 Pion 确认')).toBe(true)
  })
})
