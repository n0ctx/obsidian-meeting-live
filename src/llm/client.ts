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
}

export interface CompleteOptions {
  /** The reply must be one JSON object. Asked of the service only where the preset supports it. */
  json?: boolean
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

export function llmConfigProblem(config: LlmConfig): string | undefined {
  if (!config.baseUrl.trim()) return "未填写 LLM API 地址"
  if (!config.model.trim()) return "未填写 LLM 模型名称"
  if (config.preset.baseUrl.includes("YOUR-") && config.baseUrl.includes("YOUR-")) return "请把 LLM API 地址改成你自己的资源地址"
  if (config.preset.keyRequired && !config.apiKey) return "未配置 LLM API Key"
  return undefined
}

export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "")
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`
}

type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown): JsonRecord | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined

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
    if (typeof message === "string" && message) return `LLM 请求失败（HTTP ${status}）：${message}`
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return `LLM 请求失败（HTTP ${status}）${text ? `：${text.slice(0, 200)}` : ""}`
}

/** Whether a JSON reply may be requested from this service under this configuration. */
function jsonRequested(config: LlmConfig, options: CompleteOptions): boolean {
  const { json } = config.preset
  return !!options.json && (json === "always" || (json === "effort-off" && config.effort === "off"))
}

export function chatRequestBody(config: LlmConfig, messages: ChatMessage[], options: CompleteOptions = {}): Record<string, unknown> {
  const { preset } = config
  const body: Record<string, unknown> = { model: config.model.trim(), messages }
  if (preset.temperature) body.temperature = config.temperature
  body.stream = false
  const thinking = config.effort !== "off"
  if (preset.effort !== "none" && thinking) body.reasoning_effort = config.effort
  // DeepSeek switches thinking on and off with its own field; other providers would reject it.
  if (preset.effort === "deepseek") body.thinking = { type: thinking ? "enabled" : "disabled" }
  if (jsonRequested(config, options)) body.response_format = { type: "json_object" }
  return body
}

function requestHeaders(config: LlmConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (config.apiKey || config.preset.keyRequired) {
    if (config.preset.auth === "api-key") headers["api-key"] = config.apiKey
    else headers.Authorization = `Bearer ${config.apiKey}`
  }
  return { ...headers, ...config.headers }
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
    throw new ChatError("LLM 返回的不是 JSON，请检查 API 地址")
  }
  const text = extractCompletionText(data)
  if (!text) {
    const finish = asRecord(asRecord(data)?.choices && (asRecord(data)!.choices as unknown[])[0])?.finish_reason
    if (finish === "length") throw new ChatError("LLM 输出被截断（finish_reason=length）")
    throw new ChatError("LLM 返回内容为空或格式不受支持", undefined, true)
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
    if (error instanceof ChatError && jsonRequested(config, options) && (error.status === 400 || error.empty)) return chatOnce(config, messages, post, {})
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
  let target = config.baseUrl || "（尚未配置）"
  try {
    target = `${new URL(chatCompletionsUrl(config.baseUrl)).host} · ${config.model || "未填写模型"}`
  } catch {
    // Keep the raw value for display.
  }
  return { problem: llmConfigProblem(config), model: config.model, target, inputLimit: config.inputLimit, complete: (messages, options) => chat(config, messages, post, options) }
}
