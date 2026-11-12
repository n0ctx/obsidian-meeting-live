import { t } from "../i18n/index.ts"
import type { LlmPreset } from "./presets.ts"

export type CompatibleEffort = "off" | "low" | "medium" | "high"

export interface LlmConfig {
  /** How this service wants its requests shaped. */
  preset: LlmPreset
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  effort: CompatibleEffort
  /** Headers added to every request; only presets that allow custom headers get any. */
  headers: Record<string, string>
  /** Most a request may carry, in estimated tokens. */
  inputLimit: number
  /** No account is chosen for the language model. */
  noAccount?: boolean
}

export interface CompleteOptions {
  /** The reply must be one JSON object. Asked of the service only where the preset supports it. */
  json?: boolean
  /** Overrides the configured effort for this request; "off" for a mechanical task, where reasoning tokens are billed for nothing. */
  effort?: CompatibleEffort
  /** Told what the request used, when the service reports it. */
  usage?: (usage: LlmUsage) => void
}

/** Tokens one request used, as the service reported them. */
export interface LlmUsage {
  input: number
  /** Input tokens served from the service's prompt cache, billed far lower. */
  cached: number
  /** Output tokens, reasoning included. */
  output: number
  /** Of the output, the tokens spent reasoning. */
  reasoning: number
}

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface HttpResponse {
  status: number
  text: string
}

export type HttpPost = (url: string, headers: Record<string, string>, body: string) => Promise<HttpResponse>
export type HttpGet = (url: string, headers: Record<string, string>) => Promise<HttpResponse>

export function llmConfigProblem(config: LlmConfig): string | undefined {
  if (config.noAccount) return t("llm.noAccount")
  if (!config.baseUrl.trim()) return t("llm.noBaseUrl")
  if (!config.model.trim()) return t("llm.noModel")
  if (config.preset.baseUrl.includes("YOUR-") && config.baseUrl.includes("YOUR-")) return t("llm.placeholderUrl")
  if (config.preset.keyRequired && !config.apiKey) return t("llm.noKey")
  return undefined
}

export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "")
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`
}

type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown): JsonRecord | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0)

/** The usage of an OpenAI-compatible reply: DeepSeek reports cache hits in its own field, OpenAI under prompt_tokens_details. */
export function usageOf(data: unknown): LlmUsage | undefined {
  const usage = asRecord(asRecord(data)?.usage)
  if (!usage) return undefined
  return {
    input: count(usage.prompt_tokens),
    cached: count(usage.prompt_cache_hit_tokens) || count(asRecord(usage.prompt_tokens_details)?.cached_tokens),
    output: count(usage.completion_tokens),
    reasoning: count(asRecord(usage.completion_tokens_details)?.reasoning_tokens),
  }
}

// Response text extraction follows obsidian-realtime-transcription (MIT), see THIRD_PARTY_NOTICES.md.
function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map(textOf).join("")
  const record = asRecord(content)
  if (!record) return ""
  if (typeof record.text === "string") return record.text
  return textOf(record.content)
}

export function extractCompletionText(data: unknown): string {
  const record = asRecord(data)
  if (!record) return ""
  if (typeof record.output_text === "string" && record.output_text.trim()) return record.output_text
  const choice = asRecord(Array.isArray(record.choices) ? record.choices[0] : undefined)
  const text = textOf(asRecord(choice?.message)?.content) || (typeof choice?.text === "string" ? choice.text : "")
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
}

function errorMessage(status: number, text: string): string {
  try {
    const data = JSON.parse(text) as JsonRecord
    const error = data.error
    const message = typeof error === "string" ? error : asRecord(error)?.message
    if (typeof message === "string" && message) return t("llm.failed", status, message)
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return t("llm.failed", status, text.slice(0, 200))
}

/** Whether a JSON reply may be requested from this service under this configuration. */
function jsonRequested(config: LlmConfig, options: CompleteOptions): boolean {
  const { json } = config.preset
  return !!options.json && (json === "always" || (json === "effort-off" && (options.effort ?? config.effort) === "off"))
}

export function chatRequestBody(config: LlmConfig, messages: ChatMessage[], options: CompleteOptions = {}): Record<string, unknown> {
  const { preset } = config
  const body: Record<string, unknown> = { model: config.model.trim(), messages }
  if (preset.temperature) body.temperature = config.temperature
  body.stream = false
  const effort = options.effort ?? config.effort
  const thinking = effort !== "off"
  if (preset.effort !== "none" && thinking) body.reasoning_effort = effort
  // DeepSeek switches thinking on and off with its own field; other providers would reject it.
  if (preset.effort === "deepseek") body.thinking = { type: thinking ? "enabled" : "disabled" }
  if (jsonRequested(config, options)) body.response_format = { type: "json_object" }
  return body
}

/** The credential header the preset wants and the headers the user added; every request to the service carries them. */
export function authHeaders(config: LlmConfig): Record<string, string> {
  const headers: Record<string, string> = {}
  if (config.apiKey || config.preset.keyRequired) {
    if (config.preset.auth === "api-key") headers["api-key"] = config.apiKey
    else headers.Authorization = `Bearer ${config.apiKey}`
  }
  return { ...headers, ...config.headers }
}

function requestHeaders(config: LlmConfig): Record<string, string> {
  return { "Content-Type": "application/json", ...authHeaders(config) }
}

/** A failed request, with what a caller needs to tell whether asking for JSON was the cause. */
class ChatError extends Error {
  readonly status: number | undefined
  readonly empty: boolean

  constructor(message: string, status?: number, empty = false) {
    super(message)
    this.status = status
    this.empty = empty
  }
}

async function chatOnce(config: LlmConfig, messages: ChatMessage[], post: HttpPost, options: CompleteOptions): Promise<string> {
  const response = await post(chatCompletionsUrl(config.baseUrl), requestHeaders(config), JSON.stringify(chatRequestBody(config, messages, options)))
  if (response.status >= 400) throw new ChatError(errorMessage(response.status, response.text), response.status)
  let data: unknown
  try {
    data = JSON.parse(response.text)
  } catch {
    throw new ChatError(t("llm.notJson"))
  }
  const usage = usageOf(data)
  if (usage) options.usage?.(usage)
  const text = extractCompletionText(data)
  if (!text) {
    const finish = asRecord(asRecord(data)?.choices && (asRecord(data)!.choices as unknown[])[0])?.finish_reason
    if (finish === "length") throw new ChatError(t("llm.truncated"))
    throw new ChatError(t("llm.empty"), undefined, true)
  }
  return text
}

/**
 * Asking for a JSON reply is an optimization, never a requirement: a service that rejects it (HTTP 400) or answers
 * with blank content (which DeepSeek documents for JSON output) is asked again without it.
 */
export async function chat(config: LlmConfig, messages: ChatMessage[], post: HttpPost, options: CompleteOptions = {}): Promise<string> {
  try {
    return await chatOnce(config, messages, post, options)
  } catch (error) {
    if (error instanceof ChatError && jsonRequested(config, options) && (error.status === 400 || error.empty)) return chatOnce(config, messages, post, { ...options, json: false })
    throw error
  }
}

/** What the summary and minutes pipelines need from a model provider. */
export interface LlmClient {
  /** Why the client cannot be used right now, if it cannot. */
  problem: string | undefined
  model: string
  /** Where meeting text is sent, shown in privacy notices. */
  target: string
  /** Most a request may carry, in estimated tokens. */
  inputLimit: number
  complete(messages: ChatMessage[], options?: CompleteOptions): Promise<string>
}

export function compatibleClient(config: LlmConfig, post: HttpPost): LlmClient {
  let target = config.baseUrl || t("llm.unconfigured")
  try {
    target = `${new URL(chatCompletionsUrl(config.baseUrl)).host} · ${config.model || t("llm.noModelShort")}`
  } catch {
    // Keep the raw value for display.
  }
  return { problem: llmConfigProblem(config), model: config.model, target, inputLimit: config.inputLimit, complete: (messages, options) => chat(config, messages, post, options) }
}

/** The same client, telling `record` what each request used, on top of whatever the caller asks to be told. */
export function metered(llm: LlmClient, record: (usage: LlmUsage) => void): LlmClient {
  return {
    ...llm,
    complete: (messages, options = {}) =>
      llm.complete(messages, {
        ...options,
        usage: (usage) => {
          record(usage)
          options.usage?.(usage)
        },
      }),
  }
}
