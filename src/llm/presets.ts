// Model service presets: how each OpenAI-compatible endpoint wants its requests shaped. Each flag below is backed by the
// provider's own documentation (URLs on the lines); where the documentation says nothing, the safe choice is made: omit the
// parameter (temperature), skip the feature (JSON response format) or leave the field to the user.

import { t } from "../i18n/index.ts"

/** How reasoning effort is expressed in the request. */
export type EffortStyle =
  /** Not sent: the service ignores it or does not document it. */
  | "none"
  /** `reasoning_effort`, left out when the effort is off. */
  | "reasoning_effort"
  /** DeepSeek: `reasoning_effort` plus its own `thinking` switch, which is also sent to turn thinking off. */
  | "deepseek"

/** When `response_format: {type: "json_object"}` may be requested. */
export type JsonMode = "always" | "effort-off" | "never"

export interface LlmPreset {
  id: string
  /** Display name in the language of the interface; a getter on the presets whose name is worded in words. */
  readonly name: string
  baseUrl: string
  /** Suggested model; empty where the choice is the user's own (local models, deployment names). */
  model: string
  /** Recognizes an existing base URL when settings are migrated. */
  matches(url: URL): boolean
  /** Whether `temperature` is sent. */
  temperature: boolean
  effort: EffortStyle
  json: JsonMode
  /** Header that carries the API key: `Authorization: Bearer <key>` or Azure's `api-key: <key>`. */
  auth: "bearer" | "api-key"
  /** False for local servers: with no key set, no credential header is sent. */
  keyRequired: boolean
  /** The user may add headers of their own. */
  customHeaders: boolean
  /** Default limit on what one request may carry, in estimated tokens. Deliberately conservative; the user can override it. */
  inputTokens: number
}

const local = (url: URL, port: string) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.port === port

export const LLM_PRESETS: readonly LlmPreset[] = [
  {
    // https://api-docs.deepseek.com/api/create-chat-completion (temperature, thinking, reasoning_effort, response_format)
    // https://api-docs.deepseek.com/quick_start/pricing (deepseek-flash, 1M context, JSON output)
    // The docs do not say whether JSON output combines with thinking, so it is requested only when thinking is off.
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    matches: (url) => url.hostname.endsWith("deepseek.com"),
    temperature: true,
    effort: "deepseek",
    json: "effort-off",
    auth: "bearer",
    keyRequired: true,
    customHeaders: false,
    inputTokens: 1_000_000,
  },
  {
    // https://developers.openai.com/api/docs/guides/structured-outputs (JSON mode on Chat Completions)
    // https://developers.openai.com/api/docs/guides/reasoning (reasoning_effort; some models reject some values, so "off" sends nothing)
    // Temperature is left out: the docs do not say whether reasoning models accept it.
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.5",
    matches: (url) => url.hostname === "api.openai.com",
    temperature: false,
    effort: "reasoning_effort",
    json: "always",
    auth: "bearer",
    keyRequired: true,
    customHeaders: false,
    inputTokens: 128_000,
  },
  {
    // https://platform.claude.com/docs/en/api/openai-sdk
    // temperature below 1 is a 400 on current models, reasoning_effort is ignored, and response_format accepts only
    // json_schema (json_object returns 400), so none of the three is sent.
    id: "anthropic",
    get name() {
      return t("preset.anthropic")
    },
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-5-5",
    matches: (url) => url.hostname === "api.anthropic.com",
    temperature: false,
    effort: "none",
    json: "never",
    auth: "bearer",
    keyRequired: true,
    customHeaders: false,
    inputTokens: 200_000,
  },
  {
    // https://aistudio.google.com/docs/openai (base URL, Bearer key, reasoning_effort)
    // The page does not mention temperature or json_object, so neither is sent.
    id: "gemini",
    get name() {
      return t("preset.gemini")
    },
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.8-flash",
    matches: (url) => url.hostname === "generativelanguage.googleapis.com",
    temperature: false,
    effort: "reasoning_effort",
    json: "never",
    auth: "bearer",
    keyRequired: true,
    customHeaders: false,
    inputTokens: 200_000,
  },
  {
    // https://openrouter.ai/docs/quickstart (base URL https://openrouter.ai/api/v1 for the OpenAI SDK; `Authorization: Bearer <key>`)
    // https://openrouter.ai/docs/api-reference/overview (chat completions at https://openrouter.ai/api/v1/chat/completions)
    // https://openrouter.ai/docs/api-reference/parameters (temperature, reasoning_effort, response_format; support depends on the model)
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "",
    matches: (url) => url.hostname === "openrouter.ai",
    temperature: true,
    effort: "reasoning_effort",
    json: "always",
    auth: "bearer",
    keyRequired: true,
    customHeaders: false,
    inputTokens: 128_000,
  },
  {
    // https://docs.ollama.com/api/openai-compatibility (base URL, key ignored locally, temperature, JSON mode, reasoning_effort)
    // The OpenAI endpoint cannot set the context size, and the docs give no default, hence the small limit.
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    model: "",
    matches: (url) => local(url, "11434"),
    temperature: true,
    effort: "reasoning_effort",
    json: "always",
    auth: "bearer",
    keyRequired: false,
    customHeaders: false,
    inputTokens: 4096,
  },
  {
    // https://lmstudio.ai/docs/developer/openai-compat (base URL on port 1234 in the examples, temperature accepted)
    // https://lmstudio.ai/docs/developer/core/authentication ("By default, LM Studio does not require authentication for API requests";
    // once the server setting is on, requests carry `Authorization: Bearer <token>`), so no key is required, and one that is set is sent as Bearer.
    // Structured output and reasoning_effort are not covered there, so neither is sent.
    id: "lmstudio",
    name: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    model: "",
    matches: (url) => local(url, "1234"),
    temperature: true,
    effort: "none",
    json: "never",
    auth: "bearer",
    keyRequired: false,
    customHeaders: false,
    inputTokens: 4096,
  },
  {
    // https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle (v1 base URL `https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1/`,
    // `api-key: <key>` in the REST example, model = deployment name)
    // https://learn.microsoft.com/en-us/azure/ai-foundry/openai/reference#authentication ("all API requests must include the API Key in the `api-key`
    // HTTP header"; a Microsoft Entra token goes in `Authorization: Bearer`, which this preset does not do: add it as an extra header instead)
    // reasoning_effort is documented for reasoning models; temperature and JSON mode are not covered, so they are not sent.
    id: "azure",
    name: "Azure OpenAI",
    baseUrl: "https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1",
    model: "",
    matches: (url) => url.hostname.endsWith(".openai.azure.com") || url.hostname.endsWith(".services.ai.azure.com"),
    temperature: false,
    effort: "reasoning_effort",
    json: "never",
    auth: "api-key",
    keyRequired: true,
    customHeaders: true,
    inputTokens: 128_000,
  },
  {
    // Any other OpenAI-compatible endpoint, treated as the plugin always has: temperature and reasoning_effort are sent.
    id: "custom",
    get name() {
      return t("preset.custom")
    },
    baseUrl: "",
    model: "",
    matches: () => true,
    temperature: true,
    effort: "reasoning_effort",
    json: "never",
    auth: "bearer",
    keyRequired: true,
    customHeaders: true,
    inputTokens: 128_000,
  },
]

export const DEFAULT_PRESET_ID = "deepseek"

export function presetById(id: string): LlmPreset {
  return LLM_PRESETS.find((p) => p.id === id) ?? LLM_PRESETS[LLM_PRESETS.length - 1]
}

export const isPresetId = (id: unknown): id is string => LLM_PRESETS.some((p) => p.id === id)

/** The preset an existing base URL belongs to; Custom when none does. */
export function presetForUrl(baseUrl: string): LlmPreset {
  try {
    const url = new URL(baseUrl.trim())
    return LLM_PRESETS.find((p) => p.matches(url)) ?? presetById("custom")
  } catch {
    return presetById("custom")
  }
}

/** Parses "Name: value" lines into headers. Blank lines, comments and malformed names are skipped. */
export function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(":")
    if (at <= 0 || line.trim().startsWith("#")) continue
    const name = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    if (/^[A-Za-z0-9-]+$/.test(name) && value) headers[name] = value
  }
  return headers
}
