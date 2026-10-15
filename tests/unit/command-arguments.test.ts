import { describe, expect, it } from 'vitest'
import {
  commandExportPath,
  requireNoCommandArgument
} from '../../src/renderer/src/features/commands/commandArguments'

describe('commandExportPath literal command arguments', () => {
  it('leaves the default export path to the backend when no argument is supplied', () => {
    expect(commandExportPath('')).toBeUndefined()
  })

  it.each([
    ['session.html', 'session.html'],
    ['./exports/session.jsonl', './exports/session.jsonl'],
    ['/tmp/session.html', '/tmp/session.html'],
    ['~/exports/session.jsonl', '~/exports/session.jsonl'],
    ['"exports/My Session.html"', 'exports/My Session.html'],
    ["'exports/My Session.jsonl'", 'exports/My Session.jsonl'],
    ['"导出/会话 一.html"', '导出/会话 一.html'],
    ['"one\'s session.html"', "one's session.html"],
    ["'a \"quoted\" session.jsonl'", 'a "quoted" session.jsonl'],
    ['C:\\exports\\session.jsonl', 'C:\\exports\\session.jsonl'],
    ['"C:\\My Exports\\session.html"', 'C:\\My Exports\\session.html'],
    ['"literal\\n\\t.html"', 'literal\\n\\t.html'],
    ['"$HOME/${USER}/$(touch marker).html"', '$HOME/${USER}/$(touch marker).html'],
    ['"session; echo marker.html"', 'session; echo marker.html'],
    ['$(id).jsonl', '$(id).jsonl']
  ])('removes only a matching outer quote from %j, without shell expansion or unescaping', (argument, path) => {
    expect(commandExportPath(argument)).toBe(path)
  })

  it.each([
    '""', "''", '"missing.html', "'missing.jsonl", '"mismatch.html\'',
    '"one.html" "two.html"', "'one.jsonl' 'two.jsonl'", '"one.html" trailing',
    '"embedded"quote.html"', "'embedded'quote.jsonl'", '"escaped\\\"quote.html"'
  ])('rejects malformed or multiple quoted arguments %j', (argument) => {
    expect(() => commandExportPath(argument)).toThrow('用法：/export')
  })

  it.each(['my session.html', 'one.html two.html', 'a\tb.jsonl', 'a\u00a0b.html'])('requires quotes around whitespace in %j', (argument) => {
    expect(() => commandExportPath(argument)).toThrow('含空格的导出路径请使用单引号或双引号')
  })

  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029', '\0'])('rejects forbidden separator %j inside bare or quoted paths', (separator) => {
    for (const argument of [`one${separator}two.html`, `"one${separator}two.html"`, `'one${separator}two.jsonl'`]) {
      expect(() => commandExportPath(argument)).toThrow('导出路径不能包含换行或空字符')
    }
  })
})

describe('requireNoCommandArgument', () => {
  it('accepts exactly the already-parsed empty argument', () => {
    expect(requireNoCommandArgument('settings', '')).toBeUndefined()
  })

  it.each(['models', ' ', '\t', '\n', '""', 'one two'])('rejects nonempty %j rather than silently dropping it', (argument) => {
    expect(() => requireNoCommandArgument('settings', argument)).toThrow('用法：/settings（不接受参数）')
  })
})
