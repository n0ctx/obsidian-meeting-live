export type CompatibleEffort = "off" | "low" | "medium" | "high"

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  effort: CompatibleEffort
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
  if (!config.apiKey) return "未配置 LLM API Key"
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

export function chatRequestBody(config: LlmConfig, messages: ChatMessage[]): Record<string, unknown> {
  const body: Record<string, unknown> = { model: config.model.trim(), messages, temperature: config.temperature, stream: false }
  if (config.effort !== "off") body.reasoning_effort = config.effort
  // DeepSeek switches thinking on and off with its own field; other providers would reject it.
  let host = ""
  try {
    host = new URL(chatCompletionsUrl(config.baseUrl)).hostname
  } catch {
    // Invalid URLs are reported when the request is sent.
  }
  if (host.endsWith("deepseek.com")) body.thinking = { type: config.effort === "off" ? "disabled" : "enabled" }
  return body
}

export async function chat(config: LlmConfig, messages: ChatMessage[], post: HttpPost): Promise<string> {
  const response = await post(
    chatCompletionsUrl(config.baseUrl),
    { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    JSON.stringify(chatRequestBody(config, messages)),
  )
  if (response.status >= 400) throw new Error(errorMessage(response.status, response.text))
  let data: unknown
  try {
    data = JSON.parse(response.text)
  } catch {
    throw new Error("LLM 返回的不是 JSON，请检查 API 地址")
  }
  const text = extractCompletionText(data)
  if (!text) {
    const finish = asRecord(asRecord(data)?.choices && (asRecord(data)!.choices as unknown[])[0])?.finish_reason
    throw new Error(finish === "length" ? "LLM 输出被截断（finish_reason=length）" : "LLM 返回内容为空或格式不受支持")
  }
  return text
}

/** What the summary and minutes pipelines need from a model provider. */
export interface LlmClient {
  /** Why the client cannot be used right now, if it cannot. */
  problem: string | undefined
  model: string
  /** Where meeting text is sent, shown in privacy notices. */
  target: string
  complete(messages: ChatMessage[]): Promise<string>
}

export function compatibleClient(config: LlmConfig, post: HttpPost): LlmClient {
  let target = config.baseUrl || "（尚未配置）"
  try {
    target = `${new URL(chatCompletionsUrl(config.baseUrl)).host} · ${config.model || "未填写模型"}`
  } catch {
    // Keep the raw value for display.
  }
  return { problem: llmConfigProblem(config), model: config.model, target, complete: (messages) => chat(config, messages, post) }
}
