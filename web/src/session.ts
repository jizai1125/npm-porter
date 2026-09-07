import { api } from './api'
import type { AuthSessionState } from './types'

let sessionState: AuthSessionState | null = null
let sessionPromise: Promise<AuthSessionState> | null = null

export async function loadSession(force = false): Promise<AuthSessionState> {
  if (!force && sessionState) return sessionState
  if (!force && sessionPromise) return sessionPromise
  sessionPromise = api.session()
  try {
    sessionState = await sessionPromise
    return sessionState
  } finally {
    sessionPromise = null
  }
}

export function resetSessionCache(): void {
  sessionState = null
  sessionPromise = null
}
