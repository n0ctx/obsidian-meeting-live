import type { CompatibleEffort, LlmConfig } from "./llm/client.ts"
import { DEFAULT_PRESET_ID, isPresetId, parseHeaders, presetById, presetForUrl } from "./llm/presets.ts"
import { DEFAULT_MINUTES_PROMPT } from "./llm/minutes.ts"
import { DEFAULT_SUMMARY_FOCUS } from "./llm/summary.ts"
import type { AudioFormat } from "./meeting/types.ts"
import { seedConsent } from "./consent.ts"
import { isAsrLanguage, type AsrLanguage } from "./asr/language.ts"
import { isNoteLanguage, type NoteLanguage } from "./i18n/index.ts"
import { DEFAULT_ASSEMBLYAI, readAssemblyAiSettings, type AssemblyAiSettings } from "./asr/providers/assemblyai/settings.ts"
import { DEFAULT_DASHSCOPE, readDashScopeSettings, type DashScopeSettings } from "./asr/providers/dashscope/settings.ts"
import { DEFAULT_DEEPGRAM, readDeepgramSettings, type DeepgramSettings } from "./asr/providers/deepgram/settings.ts"
import { DEFAULT_OPENAI_COMPAT, readOpenAiCompatSettings, type OpenAiCompatSettings } from "./asr/providers/openaiCompat/settings.ts"
import { DEFAULT_SHERPA, readSherpaSettings, type SherpaSettings } from "./asr/providers/sherpa/settings.ts"
import { DEFAULT_WHISPER_LOCAL, readWhisperLocalSettings, type WhisperLocalSettings } from "./asr/providers/whisperLocal/settings.ts"
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
  providers: { volc: VolcSettings; deepgram: DeepgramSettings; openaiCompat: OpenAiCompatSettings; dashscope: DashScopeSettings; assemblyai: AssemblyAiSettings; sherpa: SherpaSettings; whisperLocal: WhisperLocalSettings }
  /** Recognition language for providers that take one. */
  asrLanguage: AsrLanguage
  /** Language of what the plugin writes into notes; auto follows the interface language. */
  noteLanguage: NoteLanguage
  hotwords: string
  /** Id of the model service preset, which decides how requests are shaped. */
  llmPreset: string
  llmBaseUrl: string
  llmModel: string
  llmTemperature: number
  llmEffort: CompatibleEffort
  /** SecretStorage id; the secret itself never touches data.json. */
  llmApiKeySecret: string
  /** Extra request headers as "Name: value" lines, for presets that allow them. Not for secrets: this file is not secret storage. */
  llmHeaders: string
  /** Most a request may carry, in estimated tokens; 0 uses the preset's default. */
  llmInputLimit: number
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
  providers: { volc: DEFAULT_VOLC, deepgram: DEFAULT_DEEPGRAM, openaiCompat: DEFAULT_OPENAI_COMPAT, dashscope: DEFAULT_DASHSCOPE, assemblyai: DEFAULT_ASSEMBLYAI, sherpa: DEFAULT_SHERPA, whisperLocal: DEFAULT_WHISPER_LOCAL },
  asrLanguage: "auto",
  noteLanguage: "auto",
  hotwords: "",
  llmPreset: DEFAULT_PRESET_ID,
  llmBaseUrl: "https://api.deepseek.com",
  llmModel: "deepseek-flash",
  llmTemperature: 0.2,
  llmEffort: "low",
  llmApiKeySecret: "",
  llmHeaders: "",
  llmInputLimit: 0,
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
    if (typeof value === typeof DEFAULT_SETTINGS[key]) (settings as unknown as Record<string, unknown>)[key] = value
  }
  if (!isAsrLanguage(settings.asrLanguage)) settings.asrLanguage = DEFAULT_SETTINGS.asrLanguage
  // Notes written by 1.0.x are in Chinese whatever the interface language, so settings from before the choice existed keep writing
  // Chinese; otherwise opening an old note would rewrite its summary region in another language. A fresh install follows the interface.
  const hadNoteLanguage = "noteLanguage" in stored
  if (!isNoteLanguage(settings.noteLanguage)) settings.noteLanguage = DEFAULT_SETTINGS.noteLanguage
  if (!hadNoteLanguage && Object.keys(stored).length > 0) settings.noteLanguage = "zh"
  // Settings from before presets existed are placed by their base URL, which is how requests were shaped then.
  const hadPreset = isPresetId(stored.llmPreset)
  if (!hadPreset) settings.llmPreset = presetForUrl(settings.llmBaseUrl).id
  const current = typeof stored.version === "number" && stored.version >= SETTINGS_VERSION
  const storedProviders = (current ? stored.providers : undefined) as Record<string, unknown> | undefined
  settings.providers.volc = readVolcSettings(current ? storedProviders?.volc : stored, !current)
  settings.providers.deepgram = readDeepgramSettings(storedProviders?.deepgram)
  settings.providers.openaiCompat = readOpenAiCompatSettings(storedProviders?.openaiCompat)
  settings.providers.dashscope = readDashScopeSettings(storedProviders?.dashscope)
  settings.providers.assemblyai = readAssemblyAiSettings(storedProviders?.assemblyai)
  settings.providers.sherpa = readSherpaSettings(storedProviders?.sherpa)
  settings.providers.whisperLocal = readWhisperLocalSettings(storedProviders?.whisperLocal)
  if (Array.isArray(stored.consent)) settings.consent = stored.consent.filter((entry): entry is string => typeof entry === "string")
  // The single yes of 1.0.x covered the destinations configured at the time, which are the ones to be seeded.
  if (settings.consent.length === 0 && stored.consentAccepted === true) settings.consent = seedConsent(settings)
  const legacy: Record<string, unknown> = {}
  for (const key of LEGACY_KEYS) if (key in stored) legacy[key] = stored[key]
  return { settings, legacy, migrated: Object.keys(stored).length > 0 && (!current || !hadPreset || !hadNoteLanguage) }
}

/** What goes into data.json: the legacy keys exactly as they were found, and the current settings. */
export function storedSettings(settings: MeetingLiveSettings, legacy: Record<string, unknown>): Record<string, unknown> {
  return { ...legacy, ...settings }
}

export function llmConfig(secrets: SecretReader, s: MeetingLiveSettings): LlmConfig {
  const preset = presetById(s.llmPreset)
  return {
    preset,
    baseUrl: s.llmBaseUrl,
    apiKey: readSecret(secrets, s.llmApiKeySecret),
    model: s.llmModel,
    temperature: s.llmTemperature,
    effort: s.llmEffort,
    headers: preset.customHeaders ? parseHeaders(s.llmHeaders) : {},
    inputLimit: s.llmInputLimit > 0 ? s.llmInputLimit : preset.inputTokens,
  }
}
