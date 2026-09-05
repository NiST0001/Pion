import type { RpcSessionState, RpcClient } from '@earendil-works/pi-coding-agent'
import type { SessionModelPreferenceStore } from '../app-settings'

export async function restoreSessionModelPreference(
  client: RpcClient,
  initialState: RpcSessionState,
  requestedSessionPath: string | undefined,
  preferences?: SessionModelPreferenceStore
): Promise<RpcSessionState> {
  const sessionPath = requestedSessionPath ?? initialState.sessionFile
  if (!sessionPath || !preferences) return initialState

  const preference = preferences.getSessionModel(sessionPath)
  const current = initialState.model
  const differs = Boolean(
    preference
    && (current?.provider !== preference.provider || current.id !== preference.modelId)
  )
  // Pi restores the model recorded in a conversation, but deliberately treats
  // an empty transcript as a new session. Pion's preference closes that gap
  // without overriding a newer model already restored from real messages.
  if (preference && differs && initialState.messageCount === 0) {
    try {
      await client.setModel(preference.provider, preference.modelId)
      return await client.getState()
    } catch (error) {
      // An unavailable provider must not make an otherwise readable session
      // fail to open. Keep the preference so it can be restored later.
      console.warn('[pion] unable to restore session model preference:', error)
      return initialState
    }
  }

  if (current && (!preference || differs)) {
    try {
      await preferences.setSessionModel(sessionPath, {
        provider: current.provider,
        modelId: current.id
      })
    } catch (error) {
      console.warn('[pion] unable to remember session model preference:', error)
    }
  }
  return initialState
}
