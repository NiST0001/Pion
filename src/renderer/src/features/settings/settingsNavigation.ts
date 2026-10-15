export type SettingsPage = 'models' | 'session' | 'security' | 'appearance' | 'about' | 'diagnostics'

export interface SettingsNavigationRequest {
  /** Consumed only while open. Strictly increasing safe integer per host; same/older ids never replay. */
  id: number
  page: SettingsPage
  providerQuery?: string
  /** Directory guidance only; authentication still requires an explicit user action. */
  authIntent?: 'login' | 'logout'
}
