import { readSection } from "../readSection.ts"
import { SHERPA_DEFAULT_ENDPOINT } from "./info.ts"
import type { SherpaConfig } from "./live.ts"

export interface SherpaSettings {
  /** WebSocket address of the recognizer running on this machine (or another one the user trusts). */
  endpoint: string
}

export const DEFAULT_SHERPA: SherpaSettings = { endpoint: SHERPA_DEFAULT_ENDPOINT }

export const readSherpaSettings = (source: unknown): SherpaSettings => readSection(DEFAULT_SHERPA, source)

export const sherpaConfig = (settings: SherpaSettings): SherpaConfig => ({ endpoint: settings.endpoint.trim() })
