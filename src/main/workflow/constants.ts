import type { VerificationRunState } from '../../shared/operations'

export const MAX_OUTPUT = 24_000
export const MAX_PROMPT_CONTEXT = 48_000
export const WORKER_TIMEOUT_MS = 30 * 60 * 1_000
export const MAX_ACTIVE_WORKERS = 2
export const ACTIVE_VERIFICATION = new Set<VerificationRunState>(['queued', 'running'])
