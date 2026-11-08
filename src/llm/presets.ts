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
  // The presets below are for services that publish an OpenAI-compatible Chat Completions endpoint. A service with separate
  // regional platforms has one preset per region: keys do not cross regions, and choosing the preset picks the address.
  // Request shaping follows the same rule as above: send a parameter only where the documentation says it is accepted, and where
  // it says a model rejects or fixes a value, send nothing. Input limits are the documented context window capped at 256,000
  // estimated tokens so that a long transcript is condensed rather than sent whole, or 128,000 where no window was found.
  {
    // https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions (base URLs: the legacy hosts "remain fully functional" and need no workspace id; Bearer; temperature [0, 2); thinking is `enable_thinking`, and `reasoning_effort` is documented for qwen3.8 only, so it is not sent)
    // https://www.alibabacloud.com/help/en/model-studio/json-mode (json_object needs "json" in the prompt; qwen-plus supports it in its default, non-thinking mode)
    // https://www.alibabacloud.com/help/en/model-studio/get-api-key (keys cannot be used across regions)
    id: "qwen",
    get name() {
      return t("preset.qwen")
    },
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    matches: (url) => url.hostname === "dashscope.aliyuncs.com" || url.hostname.endsWith(".cn-beijing.maas.aliyuncs.com"),
    temperature: true,
    effort: "none",
    json: "always",
    auth: "bearer",
    keyRequired: true,
    customHeaders: false,
    inputTokens: 256_000,
  },
  {
    // Same service and documents as above, for the international (Singapore) region.
    id: "qwen-intl",
    get name() {
      return t("preset.qwenIntl")
    },
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    matches: (url) => url.hostname === "dashscope-intl.aliyuncs.com" || url.hostname.endsWith(".ap-southeast-1.maas.aliyuncs.com"),
    temperature: true,
    effort: "none",
    json: "always",
    auth: "bearer",
    keyRequired: true,
    customHeaders: false,
    inputTokens: 256_000,
  },
  {
    // https://platform.kimi.com/docs/guide/start-using-kimi-api (https://api.moonshot.cn/v1, kimi-k3.1-pro; Bearer)
    // https://platform.kimi.ai/docs/api/chat (https://api.moonshot.ai/v1; K3 models fix temperature, so none is sent; K3 reasoning_effort takes low/high/max only, so none is sent; json_object is documented but K3 always thinks and the docs do not say they combine, so it is not requested)
    // Whether a .cn key works on the .ai host is not stated; they are treated as separate.
    id: "kimi",
    get name() {
      return t("preset.kimi")
    },
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k3.1-pro",
    matches: (url) => url.hostname === "api.moonshot.cn",
    temperature: false,
    effort: "none",
    json: "never",
    auth: "bearer",
    keyRequired: true,
    customHeaders: false,
    inputTokens: 256_000,
  },
  {
    // Same service and documents as above, for the international platform.
    id: "kimi-intl",
    get name() {
      return t("preset.kimiIntl")
    },
    baseUrl: "https://api.moonshot.ai/v1",
    model: "kimi-k3.1-pro",
    matches: (url) => url.hostname === "api.moonshot.ai",
    temperature: false,
    effort: "none",
    json: "never",
    auth: "bearer",
    keyRequired: true,
    customHeaders: false,
    inputTokens: 256_000,
  },
  {
    // https://docs.bigmodel.cn/cn/guide/develop/openai/introduction (https://open.bigmodel.cn/api/paas/v4, glm-5.3; Bearer; temperature in (0, 1))
    // https://docs.z.ai/api-reference/llm/chat-completion (glm-5.3 can only think, with reasoning_effort limited to low/high/max, so none is sent; json_object is for text models, but thinking is always on and the docs do not say they combine, so it is not requested)
    id: "glm",
    get name() {
      return t("preset.glm")
    },
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.3",
    matches: (url) => url.hostname === "open.bigmodel.cn",
    temperature: true,
    effort: "none",
    json: "never",
    auth: "bearer",
    keyRequired: true,
    customHeaders: false,
    inputTokens: 256_000,
  },
  {
    // Same models and parameters as above on Z.ai's international platform (https://api.z.ai/api/paas/v4, from the Z.ai reference above); temperature [0, 1].
    id: "glm-intl",
    get name() {
      return t("preset.glmIntl")
    },
    baseUrl: "https://api.z.ai/api/paas/v4",
    model: "glm-5.3",
    matches: (url) => url.hostname === "api.z.ai",
    temperature: true,
    effort: "none",
    json: "never",
    auth: "bearer",
    keyRequired: true,
    customHeaders: false,
    inputTokens: 256_000,
  },
  {
    // https://docs.volcengine.com/docs/82379/1298454 (POST https://ark.cn-beijing.volces.com/api/v3/chat/completions; API key auth; temperature [0, 2] but fixed at 1.0 on the doubao-seed-2-0 pro and lite models, so none is sent; reasoning_effort takes none to max on the models that support it; json_object is marked beta and depends on the model, so it is not requested)
    // The model id is the one the reference names (doubao-seed-2-0-lite-260428); the model list page did not render, so the window is unknown. Ark also accepts an endpoint id (ep-...) here.
    // BytePlus ModelArk (international) is not offered: its documentation could not be read.
    id: "ark",
    get name() {
      return t("preset.ark")
    },
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-2-0-lite-260428",
    matches: (url) => url.hostname.startsWith("ark.") && url.hostname.endsWith(".volces.com"),
    temperature: false,
    effort: "reasoning_effort",
    json: "never",
    auth: "bearer",
    keyRequired: true,
    customHeaders: false,
    inputTokens: 128_000,
  },
  {
    // https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions (https://api.siliconflow.cn/v1; Bearer; temperature 0 to 2; json_object works for language models if the prompt asks for JSON; reasoning_effort only for a few models, so none is sent)
    // The text example there is deepseek-ai/DeepSeek-V4-Flash; the documentation gives no context window per model.
    id: "siliconflow",
    get name() {
      return t("preset.siliconflow")
    },
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-V4-Flash",
    matches: (url) => url.hostname === "api.siliconflow.cn",
    temperature: true,
    effort: "none",
    json: "always",
    auth: "bearer",
    keyRequired: true,
    customHeaders: false,
    inputTokens: 128_000,
  },
  {
    // https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions (https://api.siliconflow.com/v1, Bearer; the same parameters as the China site; this page does not mention reasoning_effort)
    // Whether an account and key of one site work on the other is not stated; they are treated as separate.
    id: "siliconflow-intl",
    get name() {
      return t("preset.siliconflowIntl")
    },
    baseUrl: "https://api.siliconflow.com/v1",
    model: "deepseek-ai/DeepSeek-V4-Flash",
    matches: (url) => url.hostname === "api.siliconflow.com",
    temperature: true,
    effort: "none",
    json: "always",
    auth: "bearer",
    keyRequired: true,
    customHeaders: false,
    inputTokens: 128_000,
  },
  {
    // https://platform.minimax.cn/docs/api-reference/text-openai-api (OPENAI_BASE_URL https://api.minimax.cn/v1; temperature is not supported and any value passed has no effect; reasoning_effort is for MiniMax-M3.1-Flash and "none" is rejected, which "off" never sends; response_format is not covered, so JSON is not requested)
    // api.minimaxi.com, the host older material uses, is also recognized when settings are migrated.
    id: "minimax",
    get name() {
      return t("preset.minimax")
    },
    baseUrl: "https://api.minimax.cn/v1",
    model: "MiniMax-M3.1-Flash",
    matches: (url) => url.hostname === "api.minimax.cn" || url.hostname === "api.minimaxi.com",
    temperature: false,
    effort: "reasoning_effort",
    json: "never",
    auth: "bearer",
    keyRequired: true,
    customHeaders: false,
    inputTokens: 256_000,
  },
  {
    // https://platform.minimax.io/docs/api-reference/text-openai-api (OPENAI_BASE_URL https://api.minimax.io/v1, MiniMax-M3.1-Flash with a 1M context; the same parameters as above)
    id: "minimax-intl",
    get name() {
      return t("preset.minimaxIntl")
    },
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M3.1-Flash",
    matches: (url) => url.hostname === "api.minimax.io",
    temperature: false,
    effort: "reasoning_effort",
    json: "never",
    auth: "bearer",
    keyRequired: true,
    customHeaders: false,
    inputTokens: 256_000,
  },
  {
    // https://docs.x.ai/developers/rest-api-reference/inference/chat-completions (https://api.x.ai/v1, Bearer; temperature 0 to 2, values above 1 are sampled at 1; reasoning_effort values depend on the model; response_format is not described)
    // https://docs.x.ai/docs/models (grok-4.7, 500k context) and https://docs.x.ai/docs/guides/reasoning (grok-4.7 takes low/medium/high/xhigh and cannot turn reasoning off)
    // xAI calls Chat Completions a legacy endpoint and recommends the Responses API for new work; no shutdown date is announced.
    id: "grok",
    name: "xAI Grok",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-4.7",
    matches: (url) => url.hostname === "api.x.ai",
    temperature: true,
    effort: "reasoning_effort",
    json: "never",
    auth: "bearer",
    keyRequired: true,
    customHeaders: false,
    inputTokens: 256_000,
  },
  {
    // https://docs.mistral.ai/api/endpoint/chat (https://api.mistral.ai/v1, Bearer; temperature recommended 0.0 to 0.7; json_object works if the prompt asks for JSON; reasoning_effort takes different values per model, and Small 4 takes only high and none, so none is sent)
    // mistral-small-latest is the alias the reference's sample response shows; the window it points to was not found.
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    model: "mistral-small-latest",
    matches: (url) => url.hostname === "api.mistral.ai",
    temperature: true,
    effort: "none",
    json: "always",
    auth: "bearer",
    keyRequired: true,
    customHeaders: false,
    inputTokens: 128_000,
  },
  {
    // https://console.groq.com/docs/openai (https://api.groq.com/openai/v1, Bearer; "mostly compatible")
    // https://console.groq.com/docs/api-reference#chat-create (temperature 0 to 2; reasoning_effort takes different values per model and "unsupported values are rejected with a 400", so none is sent)
    // https://console.groq.com/docs/structured-outputs (json_object is listed for all models, and needs the prompt to ask for JSON)
    // https://console.groq.com/docs/models (openai/gpt-oss-120b is the featured production model, 131,072 tokens of context)
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    matches: (url) => url.hostname === "api.groq.com",
    temperature: true,
    effort: "none",
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
