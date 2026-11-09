import type { LlmConfig } from "./llm/client.ts"
import { presetById } from "./llm/presets.ts"
import { DEFAULT_MINUTES_PROMPT } from "./llm/minutes.ts"
import { DEFAULT_SUMMARY_FOCUS } from "./llm/summary.ts"
import type { AudioFormat } from "./meeting/types.ts"
import { seedConsent } from "./consent.ts"
import { isAsrLanguage, type AsrLanguage } from "./asr/language.ts"
import { isNoteLanguage, type NoteLanguage } from "./i18n/index.ts"
import { VOLC_FLAT_KEYS } from "./asr/providers/volc/settings.ts"
import { EMPTY_ROLES, type AccountSettings } from "./accounts/account.ts"
import { migrateAccounts } from "./accounts/migrate.ts"
import { readAccounts, readRoles } from "./accounts/read.ts"
import { roleAccount } from "./accounts/roles.ts"
import { accountLlmConfig } from "./accounts/llm.ts"
import { readSecret, type SecretReader } from "./secrets.ts"

export const SETTINGS_VERSION = 3

export interface MeetingLiveSettings extends AccountSettings {
  version: typeof SETTINGS_VERSION
  folder: string
  audioFormat: AudioFormat
  deviceId: string
  voiceProcessing: boolean
  /** Recognition language for providers that take one. */
  asrLanguage: AsrLanguage
  /** Language of what the plugin writes into notes; auto follows the interface language. */
  noteLanguage: NoteLanguage
  hotwords: string
  autoSummary: boolean
  summaryIntervalMin: number
  summaryFocus: string
  minutesPrompt: string
  /** Destinations the user agreed to send data to, as "live:host", "file:host" or "llm:host". */
  consent: string[]
  /** Meeting notes from before blocks carried a heading have been given one (see addCardHeadings in main.ts). */
  cardHeadingsAdded: boolean
}

export const DEFAULT_SETTINGS: MeetingLiveSettings = {
  version: SETTINGS_VERSION,
  folder: "Meetings",
  audioFormat: "ogg",
  deviceId: "",
  voiceProcessing: false,
  accounts: [],
  roles: EMPTY_ROLES,
  asrLanguage: "auto",
  noteLanguage: "auto",
  hotwords: "",
  autoSummary: true,
  summaryIntervalMin: 5,
  summaryFocus: DEFAULT_SUMMARY_FOCUS,
  minutesPrompt: DEFAULT_MINUTES_PROMPT,
  consent: [],
  cardHeadingsAdded: false,
}

/**
 * Keys of the 1.0.x settings shape that no longer live at the top level: the service settings now sit in accounts.
 * They are written back untouched while 1.0.x remains a version to return to, so it still finds its keys and model after a downgrade.
 */
const LEGACY_KEYS = [...VOLC_FLAT_KEYS, "consentAccepted", "llmBaseUrl", "llmModel", "llmEffort", "llmTemperature", "llmApiKeySecret"]

export interface LoadedSettings {
  settings: MeetingLiveSettings
  /** Keys of the previous settings shape that are written back unchanged, so the previous version can still run after a downgrade. */
  legacy: Record<string, unknown>
  /** The stored settings were of an older shape, so the migrated result is worth writing back. */
  migrated: boolean
}

/**
 * Reads data.json of any version into the current shape. Values of the wrong type fall back to their defaults.
 * Settings of 1.0.x and of the development builds that stored a `providers` section become accounts (src/accounts/migrate.ts).
 * Keys that nothing reads any more (llmProvider, chatgptModel, chatgptEffort, transcriptShare) are dropped.
 */
export function loadSettings(raw: unknown): LoadedSettings {
  const stored = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const settings = structuredClone(DEFAULT_SETTINGS)
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof MeetingLiveSettings)[]) {
    if (key === "accounts" || key === "roles" || key === "version" || key === "consent") continue
    const value = stored[key]
    if (typeof value === typeof DEFAULT_SETTINGS[key]) (settings as unknown as Record<string, unknown>)[key] = value
  }
  if (!isAsrLanguage(settings.asrLanguage)) settings.asrLanguage = DEFAULT_SETTINGS.asrLanguage
  // Notes written by 1.0.x are in Chinese whatever the interface language, so settings from before the choice existed keep writing
  // Chinese; otherwise opening an old note would rewrite its summary region in another language. A fresh install follows the interface.
  const hadNoteLanguage = "noteLanguage" in stored
  if (!isNoteLanguage(settings.noteLanguage)) settings.noteLanguage = DEFAULT_SETTINGS.noteLanguage
  if (!hadNoteLanguage && Object.keys(stored).length > 0) settings.noteLanguage = "zh"
  const version = typeof stored.version === "number" ? stored.version : 0
  const current = version >= SETTINGS_VERSION
  if (current) {
    settings.accounts = readAccounts(stored.accounts)
    settings.roles = readRoles(stored.roles, settings.accounts)
  } else if (Object.keys(stored).length > 0) {
    // Version 2 never shipped; development builds wrote it, and 1.0.x wrote none.
    Object.assign(settings, migrateAccounts(stored, version >= 2))
  }
  if (Array.isArray(stored.consent)) settings.consent = stored.consent.filter((entry): entry is string => typeof entry === "string")
  // The single yes of 1.0.x covered the destinations configured at the time, which are the ones to be seeded. Only while migrating: the
  // legacy key stays in the file, and seeding on every load would agree for the user to whatever account they add later.
  if (!current && settings.consent.length === 0 && stored.consentAccepted === true) settings.consent = seedConsent(settings)
  const legacy: Record<string, unknown> = {}
  for (const key of LEGACY_KEYS) if (key in stored) legacy[key] = stored[key]
  return { settings, legacy, migrated: Object.keys(stored).length > 0 && (!current || !hadNoteLanguage) }
}

/** What goes into data.json: the legacy keys exactly as they were found, and the current settings. */
export function storedSettings(settings: MeetingLiveSettings, legacy: Record<string, unknown>): Record<string, unknown> {
  return { ...legacy, ...settings }
}

/** The language model the settings name: the account in the model role, its preset's way of shaping requests, and the chosen model. */
export function llmConfig(secrets: SecretReader, s: MeetingLiveSettings): LlmConfig {
  const account = roleAccount(s, "llm")
  const config = account && accountLlmConfig(account, readSecret(secrets, account.apiKeySecret), s.roles.llm.model)
  if (config) return config
  return { preset: presetById("custom"), baseUrl: "", apiKey: "", model: "", temperature: 0, effort: "off", headers: {}, inputLimit: 0, noAccount: true }
}
