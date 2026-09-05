// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_HISTORY_NAV_MAX_VISIBLE,
  readHistoryNavMaxVisible,
  saveHistoryNavMaxVisible
} from '../../src/renderer/src/utils/historyNavigatorSettings'

beforeEach(() => localStorage.clear())

describe('history navigator settings', () => {
  it('persists the user-selected visible marker limit', () => {
    expect(saveHistoryNavMaxVisible(27)).toBe(27)
    expect(localStorage.getItem('pion:history-nav-max-visible')).toBe('27')
    expect(readHistoryNavMaxVisible()).toBe(27)
  })

  it('clamps writes and ignores invalid persisted values', () => {
    expect(saveHistoryNavMaxVisible(999)).toBe(120)
    expect(saveHistoryNavMaxVisible(1)).toBe(8)
    localStorage.setItem('pion:history-nav-max-visible', 'not-a-number')
    expect(readHistoryNavMaxVisible()).toBe(DEFAULT_HISTORY_NAV_MAX_VISIBLE)
  })
})
