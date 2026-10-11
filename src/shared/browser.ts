// No persist: prefix: browsing state is isolated from Pion and lasts only this process.
export const BROWSER_PARTITION = 'pion-browser'
export const BROWSER_BLANK_URL = 'about:blank'
export const BROWSER_URL_MAX_LENGTH = 4096

/** Strict navigation admission; unlike the address bar this never repairs a URL. */
export function isAllowedBrowserUrl(input: unknown): input is string {
  if (typeof input !== 'string' || !input || input.length > BROWSER_URL_MAX_LENGTH || /[\u0000-\u0020\u007f\\]/.test(input)) return false
  if (input === BROWSER_BLANK_URL) return true
  if (!/^https?:\/\//i.test(input) || /^https?:\/\/[^/?#]*@/i.test(input)) return false
  try {
    const url = new URL(input)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname && !url.username && !url.password
  } catch { return false }
}

/** Address-bar convenience only. Invalid input returns null, never an external URL. */
export function normalizeBrowserUrl(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > BROWSER_URL_MAX_LENGTH) return null
  let value = input.trim()
  if (value === BROWSER_BLANK_URL) return value
  const local = /^(?:localhost|127\.0\.0\.1)(?::\d+)?(?:[/?#]|$)/i.test(value)
  if (local) value = `http://${value}`
  else if (/^[^/:?#]+\.\w+:\d+(?:[/?#]|$)/.test(value) || !/^[a-z][a-z\d+.-]*:/i.test(value)) value = `https://${value}`
  if (!isAllowedBrowserUrl(value)) return null
  const normalized = new URL(value).href
  return isAllowedBrowserUrl(normalized) ? normalized : null
}
