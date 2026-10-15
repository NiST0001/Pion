/** A command target is a selection fence, never a request to start/load a backend. */
export interface SessionCommandTarget {
  cwd: string
  sessionId: string
  sessionPath?: string
  backendId?: string
}

/** Pi's full-session accounting, not context occupancy or Pion's telemetry window. */
export interface SessionCommandInfo {
  cwd: string
  sessionId: string
  sessionPath?: string
  sessionName?: string
  stats: {
    userMessages: number
    assistantMessages: number
    toolCalls: number
    toolResults: number
    totalMessages: number
    tokens: {
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      total: number
    }
    cost: number
  }
}

export interface PiChangelog {
  version: string
  markdown: string
}
