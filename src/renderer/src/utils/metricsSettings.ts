/** User preferences for the run metrics strip, persisted in localStorage. */

const SHOW_DURATION_KEY = 'pion:metrics:show-duration'
const SHOW_COST_KEY = 'pion:metrics:show-cost'

/** 显示用时，默认开启。 */
export function readShowMetricDuration(): boolean {
  const raw = localStorage.getItem(SHOW_DURATION_KEY)
  return raw === null ? true : raw === 'true'
}

export function saveShowMetricDuration(value: boolean): void {
  localStorage.setItem(SHOW_DURATION_KEY, String(value))
}

/** 显示计费，默认关闭。 */
export function readShowMetricCost(): boolean {
  return localStorage.getItem(SHOW_COST_KEY) === 'true'
}

export function saveShowMetricCost(value: boolean): void {
  localStorage.setItem(SHOW_COST_KEY, String(value))
}
