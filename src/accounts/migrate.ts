// Turns stored settings of an older shape into accounts and roles, without asking the user for anything again.
//   1.0.x: flat `volc*` keys for the one speech service, flat `llm*` keys for the one language model.
//   2 (development builds): a `providers` section per speech service, `liveProvider` / `fileProvider`, and the same flat `llm*` keys with a preset.
// Secrets are not touched: an account keeps the SecretStorage ids the old settings named.
import { DEFAULT_ASSEMBLYAI, readAssemblyAiSettings } from "../asr/providers/assemblyai/settings.ts"
import { DEFAULT_DASHSCOPE, readDashScopeSettings } from "../asr/providers/dashscope/settings.ts"
import { DEFAULT_DEEPGRAM, readDeepgramSettings } from "../asr/providers/deepgram/settings.ts"
import { DEFAULT_OPENAI_COMPAT, readOpenAiCompatSettings } from "../asr/providers/openaiCompat/settings.ts"
import { DEFAULT_SHERPA, readSherpaSettings } from "../asr/providers/sherpa/settings.ts"
import { DEFAULT_VOLC, readVolcSettings } from "../asr/providers/volc/settings.ts"
import { DEFAULT_WHISPER_LOCAL, readWhisperLocalSettings } from "../asr/providers/whisperLocal/settings.ts"
import { isPresetId, presetById, presetForUrl } from "../llm/presets.ts"
import { DEFAULT_LLM_OPTIONS, EMPTY_ROLES, type Account, type AccountSettings } from "./account.ts"
import { createAccount } from "./manage.ts"
import { readOptions, readRoles } from "./read.ts"
import { regionOf, serviceDef, serviceForPreset } from "./services.ts"

/** The defaults of 1.0.x, which a key missing from an old file stands for. */
const OLD_LLM = { baseUrl: "https://api.deepseek.com", model: "deepseek-flash", ...DEFAULT_LLM_OPTIONS }

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const text = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback)
const sameUrl = (a: string, b: string): boolean => a.trim().replace(/\/+$/, "").toLowerCase() === b.trim().replace(/\/+$/, "").toLowerCase()

interface Section {
  /** Id of the speech adapter, as `liveProvider` / `fileProvider` name it. */
  adapter: string
  /** The service it becomes, and the section as stored (with its key) in the shape the adapter reads. */
  service: string
  section: Record<string, unknown>
  /** What an untouched section looks like: one that matches is not an account. */
  defaults: Record<string, unknown>
  /** A program on this computer: choosing it is a decision even with every setting at its default. */
  keyless: boolean
}

/** The one place the address of an OpenAI-compatible transcription service tells OpenAI, Groq and anything else apart. */
const openAiService = (baseUrl: string): string => (presetForUrl(baseUrl).id === "openai" ? "openai" : presetForUrl(baseUrl).id === "groq" ? "groq" : "custom")

function sectionsOf(stored: Record<string, unknown>, nested: boolean): Section[] {
  const providers = record(stored.providers)
  const volc = readVolcSettings(nested ? providers.volc : stored, !nested)
  const sections: Section[] = [{ adapter: "volc", service: "volc", section: { ...volc }, defaults: { ...DEFAULT_VOLC }, keyless: false }]
  if (!nested) return sections
  const openai = readOpenAiCompatSettings(providers.openaiCompat)
  sections.push(
    { adapter: "dashscope", service: "dashscope", section: { ...readDashScopeSettings(providers.dashscope) }, defaults: { ...DEFAULT_DASHSCOPE }, keyless: false },
    { adapter: "assemblyai", service: "assemblyai", section: { ...readAssemblyAiSettings(providers.assemblyai) }, defaults: { ...DEFAULT_ASSEMBLYAI }, keyless: false },
    { adapter: "deepgram", service: "deepgram", section: { ...readDeepgramSettings(providers.deepgram) }, defaults: { ...DEFAULT_DEEPGRAM }, keyless: false },
    { adapter: "openai-compat", service: openAiService(openai.baseUrl), section: { ...openai }, defaults: { ...DEFAULT_OPENAI_COMPAT }, keyless: false },
    { adapter: "sherpa-onnx", service: "sherpa", section: { ...readSherpaSettings(providers.sherpa) }, defaults: { ...DEFAULT_SHERPA }, keyless: true },
    { adapter: "whisper-local", service: "whisper-local", section: { ...readWhisperLocalSettings(providers.whisperLocal) }, defaults: { ...DEFAULT_WHISPER_LOCAL }, keyless: true },
  )
  return sections
}

export function migrateAccounts(stored: Record<string, unknown>, nested: boolean): AccountSettings {
  const settings: AccountSettings = { accounts: [], roles: structuredClone(EMPTY_ROLES) }
  const chosen = nested ? { live: text(stored.liveProvider, "volc"), file: text(stored.fileProvider, "volc") } : { live: "volc", file: "volc" }
  const byAdapter = new Map<string, Account>()

  // Speech: a section that is not what a fresh install has, or a local program that was chosen, is an account.
  for (const { adapter, service, section, defaults, keyless } of sectionsOf(stored, nested)) {
    const picked = adapter === chosen.live || adapter === chosen.file
    if (JSON.stringify(section) === JSON.stringify(defaults) && !(picked && keyless)) continue
    const def = serviceDef(service)
    if (!def) continue
    const { apiKeySecret, ...rest } = section
    const account = createAccount(settings.accounts, def, regionOf(def, rest), { options: readOptions(def, rest) })
    account.apiKeySecret = typeof apiKeySecret === "string" ? apiKeySecret : ""
    settings.accounts.push(account)
    byAdapter.set(adapter, account)
  }
  const live = byAdapter.get(chosen.live)
  const file = byAdapter.get(chosen.file)
  if (live) settings.roles.live = live.id
  if (file) settings.roles.file = file.id

  // Language model: the flat llm* keys, placed on a preset the way requests have always been shaped.
  const baseUrl = text(stored.llmBaseUrl, OLD_LLM.baseUrl)
  const preset = nested && isPresetId(stored.llmPreset) ? presetById(stored.llmPreset) : presetForUrl(baseUrl)
  const key = text(stored.llmApiKeySecret, "")
  const placed = serviceForPreset(preset.id)
  if (placed && (key || !preset.keyRequired || !sameUrl(baseUrl, OLD_LLM.baseUrl))) {
    const llm = {
      temperature: typeof stored.llmTemperature === "number" ? stored.llmTemperature : OLD_LLM.temperature,
      effort: (["off", "low", "medium", "high"].includes(stored.llmEffort as string) ? stored.llmEffort : OLD_LLM.effort) as Account["llm"]["effort"],
      inputLimit: nested && typeof stored.llmInputLimit === "number" ? stored.llmInputLimit : 0,
      headers: nested ? text(stored.llmHeaders, "") : "",
    }
    // The same key at the same service and region is one account, so a key that serves both speech and the model is set up once.
    const same = key
      ? settings.accounts.find((a) => a.service === placed.def.id && a.apiKeySecret === key && regionOf(placed.def, a.options) === placed.region && (placed.def.asr !== "openai-compat" || sameUrl(String(a.options.baseUrl), baseUrl)))
      : undefined
    const account = same ?? createAccount(settings.accounts, placed.def, placed.region, { options: { baseUrl } })
    account.options.baseUrl = baseUrl
    account.llm = llm
    if (!same) {
      account.apiKeySecret = key
      settings.accounts.push(account)
    }
    settings.roles.llm = { account: account.id, model: text(stored.llmModel, OLD_LLM.model) }
  }
  // A speech service chosen for a job it cannot do (an OpenAI-compatible one for live) is not a role.
  settings.roles = readRoles(settings.roles, settings.accounts)
  return settings
}
