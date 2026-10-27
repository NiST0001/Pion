import { describe, expect, it } from 'vitest'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { initialState } from '../../src/renderer/src/agent/types'

describe('reading jump projection', () => {
  it('retains the exact local request receipt and finite reading offset', () => {
    const token = {}
    const state = reducer(initialState, { type: 'historyJump', entryId: 'real-user-entry', nonce: 1,
      readingOffset: -320.5, readingToken: token })
    expect(state.historyJump).toEqual({ entryId: 'real-user-entry', nonce: 1,
      readingOffset: -320.5, readingToken: token })
    expect(state.historyJump?.readingToken).toBe(token)
    expect(reducer(state, { type: 'resetHistoryNavigation' }).historyJump).toBeNull()
  })

  it('keeps ordinary jumps unchanged and discards a nonfinite reading receipt', () => {
    expect(reducer(initialState, { type: 'historyJump', entryId: 'entry', nonce: 2 }).historyJump)
      .toEqual({ entryId: 'entry', nonce: 2 })
    expect(reducer(initialState, { type: 'historyJump', entryId: 'entry', nonce: 3,
      readingOffset: Number.NaN, readingToken: {} }).historyJump)
      .toEqual({ entryId: 'entry', nonce: 3 })
  })
})
