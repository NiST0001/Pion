import { describe, expect, it } from 'vitest'
import { BUILTIN_SLASH_COMMANDS } from '../../src/main/agent/constants'
import {
  DESKTOP_SLASH_COMMANDS,
  DESKTOP_SLASH_COMMAND_NAMES,
  PENDING_PI_SLASH_COMMAND_NAMES,
  PREPARATION_SLASH_COMMAND_NAMES,
  parseDesktopSlashCommand
} from '../../src/shared/slash-commands'

const PI_CORE_COMMAND_NAMES = [
  'settings', 'model', 'thinking', 'scoped-models', 'login', 'logout',
  'new', 'resume', 'name', 'session', 'tree', 'fork', 'clone', 'compact', 'import',
  'copy', 'export', 'share', 'bug', 'trust', 'reload', 'hotkeys', 'changelog', 'quit'
]

describe('desktop slash command catalog', () => {
  it('includes all 24 Pi core commands, diagnostics, llama and Pion commands exactly once', () => {
    expect(PI_CORE_COMMAND_NAMES).toHaveLength(24)
    expect(DESKTOP_SLASH_COMMAND_NAMES).toEqual([
      ...PI_CORE_COMMAND_NAMES, 'debug', 'llama', 'plan', 'yolo', 'verify', 'agents', 'stats'
    ])
    expect(DESKTOP_SLASH_COMMAND_NAMES).toEqual(DESKTOP_SLASH_COMMANDS.map((command) => command.name))
    expect(new Set(DESKTOP_SLASH_COMMAND_NAMES).size).toBe(DESKTOP_SLASH_COMMAND_NAMES.length)
    expect(DESKTOP_SLASH_COMMANDS.filter((command) => command.source === 'pion').map((command) => command.name))
      .toEqual(['plan', 'yolo', 'verify', 'agents', 'stats'])
    expect(DESKTOP_SLASH_COMMANDS.filter((command) => command.source === 'builtin')).toHaveLength(26)
    expect(BUILTIN_SLASH_COMMANDS).toBe(DESKTOP_SLASH_COMMANDS)
  })

  it('marks exactly the first-stage pending integrations, without implying that they execute', () => {
    expect(PENDING_PI_SLASH_COMMAND_NAMES).toEqual([
      'scoped-models', 'tree', 'fork', 'import', 'share', 'bug', 'reload', 'llama'
    ])
    expect(DESKTOP_SLASH_COMMANDS.filter((command) => command.description?.includes('待接入')).map((command) => command.name).sort())
      .toEqual([...PENDING_PI_SLASH_COMMAND_NAMES].sort())
    expect(DESKTOP_SLASH_COMMANDS.find((command) => command.name === 'debug')?.description).toContain('桌面诊断')
    expect(DESKTOP_SLASH_COMMANDS.find((command) => command.name === 'changelog')?.description).toBe('查看 Pi SDK 更新日志')
  })

  it('keeps backend mutations out of preparation exceptions, while allowing UI, Pion modes and pending notices', () => {
    expect(new Set(PREPARATION_SLASH_COMMAND_NAMES).size).toBe(PREPARATION_SLASH_COMMAND_NAMES.length)
    for (const name of PREPARATION_SLASH_COMMAND_NAMES) expect(DESKTOP_SLASH_COMMAND_NAMES).toContain(name)
    for (const name of [
      'settings', 'resume', 'session', 'trust', 'hotkeys', 'changelog', 'debug',
      'plan', 'yolo', 'verify', 'agents', 'stats', ...PENDING_PI_SLASH_COMMAND_NAMES
    ]) expect(PREPARATION_SLASH_COMMAND_NAMES).toContain(name)
    for (const name of ['compact', 'new', 'name', 'clone', 'model', 'thinking', 'login', 'logout', 'export', 'quit']) {
      expect(PREPARATION_SLASH_COMMAND_NAMES).not.toContain(name)
    }
  })
})

describe('parseDesktopSlashCommand', () => {
  it.each(DESKTOP_SLASH_COMMAND_NAMES)('recognizes the complete /%s name case-insensitively', (name) => {
    expect(parseDesktopSlashCommand(` \t/${name.toUpperCase()} \t`)).toEqual({ name, argument: '' })
  })

  it('preserves argument case and interior whitespace rather than splitting resource-style arguments', () => {
    expect(parseDesktopSlashCommand('/MODEL  Provider/Model-X  ')).toEqual({ name: 'model', argument: 'Provider/Model-X' })
    expect(parseDesktopSlashCommand('/export "My Session.jsonl"')).toEqual({ name: 'export', argument: '"My Session.jsonl"' })
    expect(parseDesktopSlashCommand('/plan  start')).toEqual({ name: 'plan', argument: 'start' })
  })

  it.each(DESKTOP_SLASH_COMMAND_NAMES)('keeps known /%s routed natively across line breaks for handler validation', (name) => {
    for (const separator of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
      expect(parseDesktopSlashCommand(`/${name.toUpperCase()}${separator}first line${separator}second  line`))
        .toEqual({ name, argument: `first line${separator}second  line` })
      expect(parseDesktopSlashCommand(`/${name} first line${separator}second  line`))
        .toEqual({ name, argument: `first line${separator}second  line` })
    }
  })

  it.each([
    '', '/', 'settings', '/setting', '/models', '/newer', '/compact.extra', '/clone/path',
    '/review security', '/skill:pdf extract', '/my-template a b',
    'Explain /settings', 'first line\n/settings', 'Explain /settings\nordinary body',
    '/settings.md\nordinary body', '/review security\nordinary body',
    '/skill:pdf\nextract all pages', '```\n/settings\n```',
    'first line\u2028/debug', 'first line\r\n/model Provider/Model'
  ])('does not consume partial names, resources or ordinary multiline text %j', (text) => {
    expect(parseDesktopSlashCommand(text)).toBeNull()
  })
})
