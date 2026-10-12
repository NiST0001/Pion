import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Removing the global rendering/polling entry must not remove the backend's
// explicit recovery APIs, discard operation records or unlock paused queues.
describe('global interrupted-run banner removal', () => {
  it('does not wire the recovery banner into App', () => {
    const source = readFileSync(resolve('src/renderer/src/App.tsx'), 'utf8')
    expect(source).not.toMatch(/import\s*\{\s*RunRecoveryBanner\s*\}/)
    expect(source).not.toContain('<RunRecoveryBanner')
    expect(source).not.toContain('useRunRecovery')
    const backend = readFileSync(resolve('src/main/agent/agent-bridge.ts'), 'utf8')
    expect(backend).toContain('async getRunRecoveryCandidates(')
    expect(backend).toContain('async resumeRun(')
    expect(backend).toContain('async discardRunRecovery(')
    expect(backend).toContain('async restoreRecoveredCheckpoint(')
  })
})
