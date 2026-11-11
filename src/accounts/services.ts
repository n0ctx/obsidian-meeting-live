// The services a user can add an account for. A service says which speech adapter and which language-model preset sit behind it,
// where its key comes from, and the defaults of its own settings. What a service can do (its roles) follows from those two.
import { t, uiLang } from "../i18n/index.ts"
import { presetById, type LlmPreset } from "../llm/presets.ts"
import { DEFAULT_ASSEMBLYAI } from "../asr/providers/assemblyai/settings.ts"
import { DEFAULT_DASHSCOPE } from "../asr/providers/dashscope/settings.ts"
import { DEFAULT_DEEPGRAM } from "../asr/providers/deepgram/settings.ts"
import { DEFAULT_SHERPA } from "../asr/providers/sherpa/settings.ts"
import { DEFAULT_VOLC } from "../asr/providers/volc/settings.ts"
import { DEFAULT_WHISPER_LOCAL } from "../asr/providers/whisperLocal/settings.ts"
import { DEFAULT_LOCAL_SPEECH } from "../asr/providers/localSpeech/settings.ts"

export interface ServiceRegion {
  id: string
  readonly label: string
}

export interface ServiceDef {
  readonly id: string
  /** Display name in the language of the interface. */
  readonly name: string
  /** Id of the speech adapter (src/asr/providers) that does this service's live and file roles; none for a language-model-only service. */
  readonly asr?: string
  /** Language-model preset by region id, or under "" when the service has no regions; none for a speech-only service. */
  readonly presets?: Readonly<Record<string, string>>
  /** Where the account was made. Keys do not cross regions, so this is asked when the account is added. */
  readonly regions?: readonly ServiceRegion[]
  /** Where to create a key, for the add dialog; empty when there is none to create. */
  keyUrl(region: string): string
  /** Needs no key: a program on this computer. */
  readonly keyless?: true
  /** The add dialog asks for an address: `required` when there is no sensible default, `prefilled` when there is one. */
  readonly address?: "required" | "prefilled"
  /** The option that holds the service's address, where the adapter calls it something other than `baseUrl`. */
  readonly addressKey?: string
  /** One sentence on the account row, instead of the role list, when the roles would not say what the service actually does. */
  readonly summary?: () => string
  /** The service's own settings with their defaults. Language-model services carry their address as `baseUrl`. */
  options(region: string): Record<string, unknown>
}

const REGIONS: readonly ServiceRegion[] = [
  { id: "cn", get label() { return t("region.cn") } },
  { id: "intl", get label() { return t("region.intl") } },
]

const withoutKey = <T extends { apiKeySecret: string }>(settings: T): Omit<T, "apiKeySecret"> => {
  const { apiKeySecret: _key, ...rest } = settings
  return rest
}

const baseOf = (presetId: string): string => presetById(presetId).baseUrl

/** A language-model-only service: one preset, or one per region. */
function llmService(id: string, name: () => string, presets: Record<string, string>, keyUrl: string | Record<string, string>, extra: Partial<ServiceDef> = {}): ServiceDef {
  return {
    id,
    get name() {
      return name()
    },
    presets,
    keyUrl: (region) => (typeof keyUrl === "string" ? keyUrl : (keyUrl[region] ?? "")),
    options: (region) => ({ baseUrl: baseOf(presets[region] ?? presets[""] ?? Object.values(presets)[0]), ...(extra.regions ? { region } : {}) }),
    ...extra,
  }
}

const presetName = (id: string) => () => presetById(id).name

export const SERVICES: readonly ServiceDef[] = [
  {
    id: "dashscope",
    get name() {
      return t("service.dashscope")
    },
    asr: "dashscope",
    presets: { cn: "qwen", intl: "qwen-intl" },
    regions: REGIONS,
    keyUrl: (region) => (region === "intl" ? "https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key" : "https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key"),
    options: (region) => ({ ...withoutKey(DEFAULT_DASHSCOPE), region, baseUrl: baseOf(region === "intl" ? "qwen-intl" : "qwen") }),
  },
  {
    id: "openai",
    get name() {
      return presetById("openai").name
    },
    asr: "openai-compat",
    presets: { "": "openai" },
    keyUrl: () => "https://platform.openai.com/settings/organization/api-keys",
    options: () => ({ baseUrl: baseOf("openai"), model: "whisper-1", fileSizeLimitMb: 0 }),
  },
  llmService("deepseek", presetName("deepseek"), { "": "deepseek" }, "https://platform.deepseek.com/api_keys"),
  llmService("anthropic", presetName("anthropic"), { "": "anthropic" }, "https://platform.claude.com/settings/keys"),
  llmService("gemini", presetName("gemini"), { "": "gemini" }, "https://aistudio.google.com/apikey"),
  {
    id: "groq",
    get name() {
      return presetById("groq").name
    },
    asr: "openai-compat",
    presets: { "": "groq" },
    keyUrl: () => "https://console.groq.com/keys",
    options: () => ({ baseUrl: baseOf("groq"), model: "whisper-large-v3", fileSizeLimitMb: 0 }),
  },
  {
    id: "volc",
    get name() {
      return t("service.volc")
    },
    asr: "volc",
    addressKey: "endpoint",
    keyUrl: () => "https://console.volcengine.com/speech/new/setting/apikeys?projectName=default",
    options: () => withoutKey(DEFAULT_VOLC),
  },
  {
    id: "deepgram",
    get name() {
      return t("provider.deepgram")
    },
    asr: "deepgram",
    addressKey: "endpoint",
    keyUrl: () => "https://console.deepgram.com",
    options: () => withoutKey(DEFAULT_DEEPGRAM),
  },
  {
    id: "assemblyai",
    get name() {
      return t("provider.assemblyai")
    },
    asr: "assemblyai",
    keyUrl: () => "https://www.assemblyai.com/dashboard/api-keys",
    options: () => withoutKey(DEFAULT_ASSEMBLYAI),
  },
  llmService("openrouter", presetName("openrouter"), { "": "openrouter" }, "https://openrouter.ai/keys"),
  llmService("kimi", () => t("service.kimi"), { cn: "kimi", intl: "kimi-intl" }, { cn: "https://platform.kimi.com/console/api-keys", intl: "https://platform.kimi.ai/console/api-keys" }, { regions: REGIONS }),
  llmService("glm", () => t("service.glm"), { cn: "glm", intl: "glm-intl" }, { cn: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys", intl: "https://z.ai/manage-apikey/apikey-list" }, { regions: REGIONS }),
  llmService("ark", presetName("ark"), { "": "ark" }, "https://ark.volcengine.com/region:cn-beijing/apiKey"),
  llmService("siliconflow", () => t("service.siliconflow"), { cn: "siliconflow", intl: "siliconflow-intl" }, { cn: "https://cloud.siliconflow.cn/account/ak", intl: "https://cloud.siliconflow.com/account/ak" }, { regions: REGIONS }),
  llmService("minimax", () => t("service.minimax"), { cn: "minimax", intl: "minimax-intl" }, { cn: "https://platform.minimax.cn/user-center/basic-information/interface-key", intl: "https://platform.minimax.io/user-center/basic-information/interface-key" }, { regions: REGIONS }),
  llmService("grok", presetName("grok"), { "": "grok" }, "https://console.x.ai/team/default/api-keys"),
  llmService("mistral", presetName("mistral"), { "": "mistral" }, "https://console.mistral.ai/api-keys"),
  llmService("azure", presetName("azure"), { "": "azure" }, "", { address: "required" }),
  llmService("ollama", presetName("ollama"), { "": "ollama" }, "", { keyless: true, address: "prefilled" }),
  llmService("lmstudio", presetName("lmstudio"), { "": "lmstudio" }, "", { keyless: true, address: "prefilled" }),
  {
    id: "sherpa",
    get name() {
      return t("provider.sherpa")
    },
    asr: "sherpa-onnx",
    keyless: true,
    address: "prefilled",
    addressKey: "endpoint",
    keyUrl: () => "",
    options: () => ({ ...DEFAULT_SHERPA }),
  },
  {
    id: "whisper-local",
    get name() {
      return t("provider.whisperLocal")
    },
    asr: "whisper-local",
    keyless: true,
    address: "prefilled",
    keyUrl: () => "",
    options: () => ({ ...DEFAULT_WHISPER_LOCAL }),
  },
  {
    id: "local-speech",
    get name() {
      return t("provider.localSpeech")
    },
    asr: "local-speech",
    address: "prefilled",
    summary: () => t("localSpeech.line"),
    keyUrl: () => "",
    options: () => {
      const { apiKeySecret: _key, ...rest } = DEFAULT_LOCAL_SPEECH
      return rest
    },
  },
  {
    id: "custom",
    get name() {
      return t("service.custom")
    },
    asr: "openai-compat",
    presets: { "": "custom" },
    address: "required",
    keyUrl: () => "",
    options: () => ({ baseUrl: "", model: "whisper-1", fileSizeLimitMb: 0 }),
  },
]

export const serviceDef = (id: string): ServiceDef | undefined => SERVICES.find((s) => s.id === id)

/** The region the add dialog starts on: the interface language is the best guess at where the user's account is. */
export const defaultRegion = (def: ServiceDef): string => (def.regions ? (uiLang() === "zh" ? "cn" : "intl") : "")

/** The region an account was made in, or "" for a service without regions. */
export const regionOf = (def: ServiceDef, options: Record<string, unknown>): string => {
  if (!def.regions) return ""
  return typeof options.region === "string" && def.regions.some((r) => r.id === options.region) ? options.region : def.regions[0].id
}

/** The language-model preset of an account's service and region; undefined for a service without a language model. */
export function presetOfService(def: ServiceDef, options: Record<string, unknown>): LlmPreset | undefined {
  const id = def.presets?.[regionOf(def, options)] ?? def.presets?.[""]
  return id ? presetById(id) : undefined
}

/** The service and region that offer a language-model preset, for placing a stored configuration. */
export function serviceForPreset(presetId: string): { def: ServiceDef; region: string } | undefined {
  for (const def of SERVICES) {
    for (const [region, id] of Object.entries(def.presets ?? {})) if (id === presetId) return { def, region }
  }
  return undefined
}

/** The option that holds an account's server address: `baseUrl` for services with a language model or a prefilled address, `endpoint` for the ones that call it that. */
export const addressKeyOf = (def: ServiceDef): string | undefined => def.addressKey ?? (def.presets || def.address ? "baseUrl" : undefined)
