// Volcengine big-model recorded-file ASR (submit + query).
import { randomUUID } from "node:crypto"
import type { PreparedAudio } from "../../../audio/transcode.ts"
import type { FileAsrCall, FileAsrProvider, FileAsrResponse, FileAsrResult } from "../../fileAsr.ts"
import { VOLC_CAPABILITIES, VOLC_ID, VOLC_NAME } from "./info.ts"

export const FILE_ASR_BASE = "https://openspeech.bytedance.com"
export const FILE_ASR_HOST = new URL(FILE_ASR_BASE).host
const SUBMIT_PATH = "/api/v3/auc/bigmodel/submit"
const QUERY_PATH = "/api/v3/auc/bigmodel/query"
const STATUS_OK = "20000000"
const STATUS_PENDING = new Set(["20000001", "20000002"])
const POLL_START_MS = 2000
const POLL_MAX_MS = 30_000
const MAX_WAIT_MS = 30 * 60_000

/** Extension → audio.format accepted by the service. */
export const VOLC_DIRECT_FORMATS: Record<string, string> = { wav: "wav", mp3: "mp3", ogg: "ogg", opus: "ogg", m4a: "mp4", mp4: "mp4" }

export interface FileAsrAuth {
  /** New-console single key. When set, appId/accessToken are not used. */
  apiKey: string
  appId: string
  accessToken: string
  resourceId: string
}

function headers(auth: FileAsrAuth, requestId: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Resource-Id": auth.resourceId,
    "X-Api-Request-Id": requestId,
    "X-Api-Sequence": "-1",
  }
  if (auth.apiKey) h["X-Api-Key"] = auth.apiKey
  else {
    h["X-Api-App-Key"] = auth.appId
    h["X-Api-Access-Key"] = auth.accessToken
  }
  return h
}

/** Strings and numbers as text; anything else (missing, objects) as empty. */
function scalar(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : ""
}

function header(response: FileAsrResponse, name: string): string {
  const key = Object.keys(response.headers).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ? response.headers[key] : ""
}

/** The status code lives in X-Api-Status-Code, or in the body's header block when the request failed. */
export function statusOf(response: FileAsrResponse): { code: string; message: string; body: Record<string, unknown> } {
  const text = response.text.trim()
  if (response.status === 401 || response.status === 403) {
    throw new Error(`火山引擎鉴权失败（HTTP ${response.status}）：Key 无效，或没有开通录音文件识别资源。${text.slice(0, 160)}`)
  }
  if (response.status === 413) throw new Error("录音太大被接口拒收（HTTP 413）")
  let body: Record<string, unknown> = {}
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new Error(`火山引擎返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 160)}`)
    }
  }
  const inner = (body.header ?? {}) as { code?: unknown; message?: unknown }
  return {
    code: header(response, "X-Api-Status-Code") || scalar(inner.code),
    message: header(response, "X-Api-Message") || scalar(inner.message),
    body,
  }
}

function fail(code: string, message: string): never {
  const detail = [code || "无状态码", message].filter(Boolean).join(" ")
  throw new Error(code === "45000001" ? `识别参数无效（${detail}）` : `火山引擎录音文件识别失败（${detail}）`)
}

export function buildFileRequest(base64: string, format: string, speakers: boolean): Record<string, unknown> {
  return {
    user: { uid: "obsidian-meeting-live" },
    audio: { data: base64, format },
    request: {
      model_name: "bigmodel",
      enable_itn: true,
      enable_punc: true,
      enable_ddc: true,
      enable_speaker_info: speakers,
      show_utterances: true,
    },
  }
}

export function parseFileResult(body: Record<string, unknown>): FileAsrResult {
  const durationMs = Number((body.audio_info as { duration?: unknown } | undefined)?.duration) || 0
  const result = (body.result ?? {}) as { text?: unknown; utterances?: unknown }
  const utterances = (Array.isArray(result.utterances) ? result.utterances : [])
    .map((raw) => {
      const u = raw as { text?: unknown; start_time?: unknown; end_time?: unknown; speaker?: unknown; additions?: { speaker?: unknown } }
      const speaker = u.additions?.speaker ?? u.speaker
      return {
        text: typeof u.text === "string" ? u.text.trim() : "",
        startMs: Number(u.start_time) || 0,
        endMs: Number(u.end_time) || 0,
        speaker: scalar(speaker) || undefined,
      }
    })
    .filter((u) => u.text)
  return { durationMs, utterances, text: typeof result.text === "string" ? result.text.trim() : "" }
}

export async function volcTranscribeFile(auth: FileAsrAuth, audio: PreparedAudio, options: FileAsrCall): Promise<FileAsrResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => window.setTimeout(r, ms)))
  const requestId = randomUUID()
  options.onStage?.({ stage: "uploading" })
  const submitted = statusOf(await options.post(FILE_ASR_BASE + SUBMIT_PATH, headers(auth, requestId), JSON.stringify(buildFileRequest(Buffer.from(audio.data.buffer, audio.data.byteOffset, audio.data.byteLength).toString("base64"), audio.format, options.speakers))))
  if (submitted.code !== STATUS_OK) fail(submitted.code, submitted.message)

  let waited = 0
  let delay = POLL_START_MS
  for (;;) {
    if (options.signal?.aborted) throw new Error("已取消")
    options.onStage?.({ stage: "recognizing", waitedMs: waited })
    const polled = statusOf(await options.post(FILE_ASR_BASE + QUERY_PATH, headers(auth, requestId), "{}"))
    if (!STATUS_PENDING.has(polled.code)) {
      if (polled.code !== STATUS_OK) fail(polled.code, polled.message)
      return parseFileResult(polled.body)
    }
    if (waited >= MAX_WAIT_MS) throw new Error(`识别超时：已等待 ${Math.round(waited / 60000)} 分钟仍未完成`)
    await sleep(delay)
    waited += delay
    delay = Math.min(delay * 2, POLL_MAX_MS)
  }
}

export function volcFileProvider(auth: FileAsrAuth): FileAsrProvider {
  const missing = !auth.apiKey && !(auth.appId && auth.accessToken)
  return {
    id: VOLC_ID,
    name: VOLC_NAME,
    host: FILE_ASR_HOST,
    model: auth.resourceId,
    capabilities: VOLC_CAPABILITIES,
    directFormats: VOLC_DIRECT_FORMATS,
    problem: missing ? "未配置火山引擎凭证，请先在插件设置中填写" : undefined,
    transcribe: (audio, call) => volcTranscribeFile(auth, audio, call),
  }
}
