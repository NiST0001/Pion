import { describe, expect, it } from 'vitest'
import { formatMessageTime, formatTurnDuration } from '../../src/renderer/src/utils/conversationTime'

describe('conversation time formatting', () => {
  it('uses local calendar fields and pads through seconds', () => {
    const local = new Date(2025, 0, 2, 3, 4, 5, 678)
    expect(formatMessageTime(local.getTime())).toBe('2025-01-02 03:04:05')
    expect(formatMessageTime(new Date(2025, 10, 23, 14, 15, 16).getTime()))
      .toBe('2025-11-23 14:15:16')
  })

  it('keeps absent, nonfinite, nonpositive and out-of-range dates unknown', () => {
    for (const timestamp of [NaN, Infinity, -Infinity, 0, -1, 8.64e15 + 1]) {
      expect(formatMessageTime(timestamp)).toBeUndefined()
    }
  })

  it('shows compact elapsed whole seconds without rounding up', () => {
    const examples: Array<[number, string]> = [
      [0, '<1秒'], [999, '<1秒'], [1000, '1秒'], [1999, '1秒'],
      [60_000, '1分'], [83_000, '1分23秒'], [3_600_000, '1小时'],
      [7_384_000, '2小时3分4秒'], [86_400_000, '24小时']
    ]
    for (const [duration, formatted] of examples) {
      expect(formatTurnDuration(duration)).toBe(formatted)
    }
  })

  it('keeps unreliable elapsed durations unknown', () => {
    for (const duration of [-1, NaN, Infinity, -Infinity]) {
      expect(formatTurnDuration(duration)).toBeUndefined()
    }
  })
})
