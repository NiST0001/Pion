import type { TokenUsage } from './operations'

export type UsageOverviewQuery = { year?: string; month?: string; date?: string; startDay?: number }

export type UsageOverviewPeriod = { year?: string; month?: string; date?: string; startDay: number; startAt: number; endAt: number }

export interface UsageProjectTotals {
  cwd: string
  sessions: number
  usage: TokenUsage
}

export interface UsageModelTotals {
  /** Tool/summary aggregates must not be attributed to the parent model. */
  source: 'model' | 'tool-summary'
  provider?: string
  modelId?: string
  usage: TokenUsage
}

export interface UsageDayTotals {
  /** Actual UTC dates: latest 30 days for all-time, the entire selected year/month/day otherwise. */
  date: string
  usage: TokenUsage
}

export type UsageOverviewWarning =
  | 'incomplete-history'
  | 'unresolved-lineage'
  | 'collection-failed'

/** Durable, deduplicated local ledger. Not a provider invoice or context usage. */
export interface UsageOverview {
  revision: number
  collectedAt: number
  firstRecordAt: number | null
  totals: TokenUsage
  sessions: number
  projects: number
  /** Unique persisted usage records, not model requests or individual tools. */
  records: number
  byProject: UsageProjectTotals[]
  byModel: UsageModelTotals[]
  daily: UsageDayTotals[]
  period?: UsageOverviewPeriod
  availableMonths?: string[]
  availableYears?: string[]
  availableDates?: string[]
  coverage: {
    discoveredSessions: number
    collectedSessions: number
    unavailableSessions: number
    unresolvedSessions: number
    /** Compatibility field; collection no longer has a configured capacity limit. */
    limitReached: false
  }
  warnings: UsageOverviewWarning[]
}

/** Host-only integration. Never receives paths from the overview renderer. */
export interface UsageLedgerCollector {
  scheduleSession(path: string): void
  /** Persist the latest readable snapshot before destructive history removal. */
  captureSession(path: string): Promise<void>
}
