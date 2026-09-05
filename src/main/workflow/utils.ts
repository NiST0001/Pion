import { MAX_OUTPUT } from './constants'

export function clip(value: string, max = MAX_OUTPUT): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false }
  return { text: `…${value.slice(value.length - max)}`, truncated: true }
}
