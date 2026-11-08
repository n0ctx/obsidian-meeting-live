import type { CompatibleEffort, LlmConfig } from "./llm/client.ts"
import { DEFAULT_MINUTES_PROMPT } from "./llm/minutes.ts"
import { DEFAULT_SUMMARY_FOCUS } from "./llm/summary.ts"
import type { AudioFormat } from "./meeting/types.ts"
import { seedConsent } from "./consent.ts"
import { isAsrLanguage, type AsrLanguage } from "./asr/language.ts"
import { DEFAULT_VOLC, VOLC_FLAT_KEYS, readVolcSettings, type VolcSettings } from "./asr/providers/volc/settings.ts"
import { readSecret, type SecretReader } from "./secrets.ts"

export const SETTINGS_VERSION = 2

export interface MeetingLiveSettings {
  version: typeof SETTINGS_VERSION
  folder: string
  audioFormat: AudioFormat
  deviceId: string
  voiceProcessing: boolean
  /** Provider id used for live transcription while recording. */
  liveProvider: string
  /** Provider id used to transcribe recorded files. */
  fileProvider: string
  /** Configuration of each provider, kept apart so a provider can be added without touching the rest. */
  providers: { volc: VolcSettings }
  /** Recognition language for providers that take one. */
  asrLanguage: AsrLanguage
  hotwords: string
  llmBaseUrl: string
  llmModel: string
  llmTemperature: number
  llmEffort: CompatibleEffort
  /** SecretStorage id; the secret itself never touches data.json. */
  llmApiKeySecret: string
  autoSummary: boolean
  summaryIntervalMin: number
  summaryFocus: string
  minutesPrompt: string
  /** Destinations the user agreed to send data to, as "live:host", "file:host" or "llm:host". */
  consent: string[]
}

export const DEFAULT_SETTINGS: MeetingLiveSettings = {
  version: SETTINGS_VERSION,
  folder: "Meetings",
  audioFormat: "ogg",
  deviceId: "",
  voiceProcessing: false,
  liveProvider: "volc",
  fileProvider: "volc",
  providers: { volc: DEFAULT_VOLC },
  asrLanguage: "auto",
  hotwords: "",
  llmBaseUrl: "https://api.deepseek.com",
  llmModel: "deepseek-flash",
  llmTemperature: 0.2,
  llmEffort: "low",
  llmApiKeySecret: "",
  autoSummary: true,
  summaryIntervalMin: 5,
  summaryFocus: DEFAULT_SUMMARY_FOCUS,
  minutesPrompt: DEFAULT_MINUTES_PROMPT,
  consent: [],
}

/** Keys of the 1.0.x settings shape. They are written back untouched while 1.0.x remains a version to return to. */
const LEGACY_KEYS = [...VOLC_FLAT_KEYS, "consentAccepted"]

export interface LoadedSettings {
  settings: MeetingLiveSettings
  /** Keys of the previous settings shape that are written back unchanged, so the previous version can still run after a downgrade. */
  legacy: Record<string, unknown>
  /** The stored settings were of an older shape, so the migrated result is worth writing back. */
  migrated: boolean
}

/**
 * Reads data.json of any version into the current shape. Values of the wrong type fall back to their defaults.
 * Keys that nothing reads any more (llmProvider, chatgptModel, chatgptEffort, transcriptShare) are dropped.
 */
export function loadSettings(raw: unknown): LoadedSettings {
  const stored = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const settings = structuredClone(DEFAULT_SETTINGS)
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof MeetingLiveSettings)[]) {
    if (key === "providers" || key === "version" || key === "consent") continue
    const value = stored[key]
    if (typeof value === typeof DEFAULT_SETTINGS[key]) (settings[key] as string | number | boolean) = value as string | number | boolean
  }
  if (!isAsrLanguage(settings.asrLanguage)) settings.asrLanguage = DEFAULT_SETTINGS.asrLanguage
  const current = typeof stored.version === "number" && stored.version >= SETTINGS_VERSION
  settings.providers.volc = readVolcSettings(current ? (stored.providers as { volc?: unknown } | undefined)?.volc : stored, !current)
  if (Array.isArray(stored.consent)) settings.consent = stored.consent.filter((entry): entry is string => typeof entry === "string")
  // The single yes of 1.0.x covered the destinations configured at the time, which are the ones to be seeded.
  if (settings.consent.length === 0 && stored.consentAccepted === true) settings.consent = seedConsent(settings)
  const legacy: Record<string, unknown> = {}
  for (const key of LEGACY_KEYS) if (key in stored) legacy[key] = stored[key]
  return { settings, legacy, migrated: Object.keys(stored).length > 0 && !current }
}

/** What goes into data.json: the legacy keys exactly as they were found, and the current settings. */
export function storedSettings(settings: MeetingLiveSettings, legacy: Record<string, unknown>): Record<string, unknown> {
  return { ...legacy, ...settings }
}

export function llmConfig(secrets: SecretReader, s: MeetingLiveSettings): LlmConfig {
  return { baseUrl: s.llmBaseUrl, apiKey: readSecret(secrets, s.llmApiKeySecret), model: s.llmModel, temperature: s.llmTemperature, effort: s.llmEffort }
}
