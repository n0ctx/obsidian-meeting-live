// The models a service offers, for the model picker, and the free call that doubles as a check of the key.
// Each listing below is backed by the service's own documentation (URLs on the lines); where none is documented, nothing is called and a short
// curated list stands in. A service that lists models for a key lists them for nothing: no listing call is documented as billed, and none runs a model.
import { authHeaders, type HttpGet, type LlmConfig } from "./client.ts"

interface Listing {
  /** Where the list is: under the base URL, or at the host's root (DashScope's list is not on its compatible-mode path). */
  from: "base" | "origin"
  path: string
  /** `openai` is `{data: [{id}]}`; DashScope's own list is `{output: {models: [{model}]}}`. */
  shape: "openai" | "dashscope"
  /** Ids of models that do not chat (embeddings, speech, images) and so are not offered. */
  exclude?: RegExp
  /** Keeps an entry; for services whose list carries a flag instead of a recognizable name. */
  keep?: (entry: Record<string, unknown>) => boolean
  /** Ids come back with a prefix to remove (Gemini's `models/`). */
  strip?: RegExp
  /** The list tells nothing the picker can use, as Azure's names base models while requests name deployments; it only checks the key. */
  checkOnly?: true
  /** Only 401 means the key is bad; a 403 is a valid key without access to the list, which says nothing about the key (DashScope's error codes). */
  forbiddenIsNotRejection?: true
  /** The list does not need a valid key, so the key is checked at this path instead (OpenRouter's /models is not authenticated). */
  checkPath?: string
}

const LISTINGS: Record<string, Listing | undefined> = {
  // https://api-docs.deepseek.com/api/list-models
  deepseek: { from: "base", path: "/models", shape: "openai" },
  // https://developers.openai.com/api/reference/resources/models/methods/list (no type field, so the chat models are told apart by name)
  openai: { from: "base", path: "/models", shape: "openai", exclude: /embedding|whisper|tts|dall-e|image|moderation|realtime|transcribe|audio|sora|search-preview/i },
  // https://platform.claude.com/docs/en/api/models-list (Bearer is documented; the default page is 20 models, so ask for the most it allows)
  anthropic: { from: "base", path: "/models?limit=1000", shape: "openai" },
  // https://aistudio.google.com/docs/openai (`client.models.list()`; the page does not show the ids, the native list names them `models/...`)
  gemini: { from: "base", path: "/models", shape: "openai", strip: /^models\//, exclude: /embedding|imagen|veo|tts|image|live|aqa|robotics/i },
  // https://openrouter.ai/docs/api-reference/limits (GET /api/v1/key answers only for a valid key) and https://openrouter.ai/docs/api/api-reference/models/get-models
  openrouter: { from: "base", path: "/models", shape: "openai", checkPath: "/key" },
  // https://help.aliyun.com/en/model-studio/list-models (GET /api/v1/models, Bearer; the compatible-mode path documents no /models)
  qwen: { from: "origin", path: "/api/v1/models?page_size=100", shape: "dashscope", forbiddenIsNotRejection: true, exclude: /embedding|asr|tts|wan|image|video|rerank|paraformer|cosyvoice|sambert|vision-ocr/i },
  "qwen-intl": { from: "origin", path: "/api/v1/models?page_size=100", shape: "dashscope", forbiddenIsNotRejection: true, exclude: /embedding|asr|tts|wan|image|video|rerank|paraformer|cosyvoice|sambert|vision-ocr/i },
  // https://platform.kimi.ai/docs/api/list-models and https://platform.kimi.com/docs/api/list-models.md
  kimi: { from: "base", path: "/models", shape: "openai" },
  "kimi-intl": { from: "base", path: "/models", shape: "openai" },
  // https://docs.siliconflow.com/en/api-reference/models/get-model-list (the .cn documentation was not readable; it is the same service)
  siliconflow: { from: "base", path: "/models?sub_type=chat", shape: "openai" },
  "siliconflow-intl": { from: "base", path: "/models?sub_type=chat", shape: "openai" },
  // https://platform.minimax.io/docs/api-reference/models/openai/list-models.md (only the international host is documented)
  "minimax-intl": { from: "base", path: "/models", shape: "openai" },
  // https://docs.x.ai/openapi.json (GET /v1/models; it also lists image models)
  grok: { from: "base", path: "/models", shape: "openai", exclude: /image|imagine|video/i },
  // https://docs.mistral.ai/api/endpoint/models (each entry says whether it does chat completions)
  mistral: { from: "base", path: "/models", shape: "openai", keep: (entry) => (entry.capabilities as { completion_chat?: boolean } | undefined)?.completion_chat !== false },
  // https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/models (base models; requests name a deployment)
  azure: { from: "base", path: "/models", shape: "openai", checkOnly: true },
  // https://docs.ollama.com/api/openai-compatibility and https://lmstudio.ai/docs/developer/openai-compat/models (embedding models are listed too)
  ollama: { from: "base", path: "/models", shape: "openai", exclude: /embed/i },
  lmstudio: { from: "base", path: "/models", shape: "openai", exclude: /embed/i },
  // https://console.groq.com/docs/api-reference#models-list (whisper, guard and speech models are in it)
  groq: { from: "base", path: "/models", shape: "openai", exclude: /whisper|guard|tts|orpheus|playai/i, keep: (entry) => entry.active !== false },
  // Any OpenAI-compatible server; one that has no /models answers 404 and gets no check.
  custom: { from: "base", path: "/models", shape: "openai" },
}

/** Models to offer when the service's list cannot be fetched: the preset's suggestion first, then ones its documentation names. */
const CURATED: Record<string, string[]> = {
  // https://api-docs.deepseek.com/api/list-models
  deepseek: ["deepseek-flash", "deepseek-v4-pro"],
  // https://platform.claude.com/docs/en/api/models-list
  anthropic: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"],
  // https://aistudio.google.com/docs/models
  gemini: ["gemini-3.8-flash", "gemini-3.5-flash-lite"],
  // https://platform.kimi.com/docs/api/chat
  kimi: ["kimi-k3.1-pro", "kimi-k3"],
  "kimi-intl": ["kimi-k3.1-pro", "kimi-k3"],
  // https://console.groq.com/docs/models
  groq: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.3-70b-versatile"],
}

/** The short list for a preset: what its documentation names, else just the suggested model, else nothing. */
export function curatedModels(presetId: string, suggested: string): string[] {
  return [...new Set([suggested, ...(CURATED[presetId] ?? [])].filter(Boolean))]
}

const trimSlash = (url: string) => url.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "")

function urlOf(config: LlmConfig, listing: Listing, path: string): string | undefined {
  try {
    return listing.from === "origin" ? `${new URL(config.baseUrl.trim()).origin}${path}` : `${trimSlash(config.baseUrl)}${path}`
  } catch {
    return undefined
  }
}

/** Model ids from a listing's JSON, filtered and sorted; undefined when the reply is not the shape the service documents. */
export function parseModels(listing: Pick<Listing, "shape" | "exclude" | "keep" | "strip">, json: unknown): string[] | undefined {
  const root = json && typeof json === "object" ? (json as Record<string, unknown>) : undefined
  const entries = listing.shape === "dashscope" ? (root?.output as { models?: unknown } | undefined)?.models : root?.data
  if (!Array.isArray(entries)) return undefined
  const ids = entries
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .filter((entry) => !listing.keep || listing.keep(entry))
    .map((entry) => entry[listing.shape === "dashscope" ? "model" : "id"])
    .filter((id): id is string => typeof id === "string" && id !== "")
    .map((id) => (listing.strip ? id.replace(listing.strip, "") : id))
    .filter((id) => !listing.exclude?.test(id))
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}

export type ListOutcome =
  /** The service answered; `models` may be empty, and is for `checkOnly` services, whose list the picker cannot use. */
  | { state: "ok"; models: string[] }
  /** The service refused the key (HTTP 401 or 403). */
  | { state: "rejected"; status: number }
  /** The service has no list to call (nothing documented, or it answered 404/405). */
  | { state: "none" }
  /** The call failed: no connection, or a status that says nothing about the key. */
  | { state: "failed"; status?: number; message: string }

/** Whether this preset's service has a listing the plugin may call. */
export const hasListing = (presetId: string): boolean => !!LISTINGS[presetId]

/**
 * Asks the service for its models, which also shows whether the key works. Never throws: whatever goes wrong is an outcome.
 * A key is only ever sent to the address the account names.
 */
export async function listModels(presetId: string, config: LlmConfig, get: HttpGet): Promise<ListOutcome> {
  const listing = LISTINGS[presetId]
  if (!listing) return { state: "none" }
  const headers = authHeaders(config)
  const keyUrl = listing.checkPath ? urlOf(config, listing, listing.checkPath) : undefined
  const url = urlOf(config, listing, listing.path)
  if (!url) return { state: "failed", message: "address" }
  try {
    if (keyUrl) {
      const checked = await get(keyUrl, headers)
      if (checked.status === 401 || checked.status === 403) return { state: "rejected", status: checked.status }
      if (checked.status >= 400) return { state: "failed", status: checked.status, message: checked.text.slice(0, 120) }
    }
    const response = await get(url, headers)
    if (response.status === 401 || (response.status === 403 && !listing.forbiddenIsNotRejection)) return { state: "rejected", status: response.status }
    if (response.status === 404 || response.status === 405 || response.status === 403) return { state: "none" }
    if (response.status >= 400) return { state: "failed", status: response.status, message: response.text.slice(0, 120) }
    let json: unknown
    try {
      json = JSON.parse(response.text)
    } catch {
      return { state: "none" }
    }
    const models = parseModels(listing, json)
    // A reply that is not a list at all is a server that answers every path with something: it checks nothing.
    if (!models) return { state: "none" }
    return { state: "ok", models: listing.checkOnly ? [] : models }
  } catch (error) {
    return { state: "failed", message: (error as Error).message }
  }
}
