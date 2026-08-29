export type SessionPreviewDensity = 'compact' | 'comfortable' | 'detailed'

export const SESSION_PREVIEW_OPTIONS: Array<{
  value: SessionPreviewDensity
  label: string
  description: string
}> = [
  { value: 'compact', label: '紧凑', description: '只保留会话标题' },
  { value: 'comfortable', label: '舒适', description: '标题与时间信息' },
  { value: 'detailed', label: '详细', description: '标题、摘要与完整信息' }
]

const SESSION_PREVIEW_STORAGE_KEY = 'pion:session-preview-density'
const DEFAULT_SESSION_PREVIEW_DENSITY: SessionPreviewDensity = 'comfortable'

export function readSessionPreviewDensity(): SessionPreviewDensity {
  try {
    const value = window.localStorage.getItem(SESSION_PREVIEW_STORAGE_KEY)
    return isSessionPreviewDensity(value) ? value : DEFAULT_SESSION_PREVIEW_DENSITY
  } catch {
    return DEFAULT_SESSION_PREVIEW_DENSITY
  }
}

export function saveSessionPreviewDensity(density: SessionPreviewDensity): void {
  try {
    window.localStorage.setItem(SESSION_PREVIEW_STORAGE_KEY, density)
  } catch {
    // Preferences are best effort when local storage is unavailable.
  }
}

function isSessionPreviewDensity(value: string | null): value is SessionPreviewDensity {
  return value === 'compact' || value === 'comfortable' || value === 'detailed'
}
