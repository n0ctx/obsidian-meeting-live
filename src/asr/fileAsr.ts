// Volcengine big-model recorded-file ASR (submit + query), with a coverage check against silent truncation.
import { randomUUID } from "node:crypto"
import { formatClock, type Utterance } from "../meeting/types.ts"

export const FILE_ASR_BASE = "https://openspeech.bytedance.com"
const SUBMIT_PATH = "/api/v3/auc/bigmodel/submit"
const QUERY_PATH = "/api/v3/auc/bigmodel/query"
const STATUS_OK = "20000000"
const STATUS_PENDING = new Set(["20000001", "20000002"])
const POLL_START_MS = 2000
const POLL_MAX_MS = 30_000
const MAX_WAIT_MS = 30 * 60_000
/** Transcripts must reach this share of the audio; the service can truncate silently. */
export const MIN_COVERAGE = 0.8

/** Extension → audio.format accepted by the service. */
export const DIRECT_FORMATS: Record<string, string> = { wav: "wav", mp3: "mp3", ogg: "ogg", opus: "ogg", m4a: "mp4", mp4: "mp4" }
/** Other formats Chromium can decode, transcoded locally before upload. */
export const DECODABLE_EXTENSIONS = ["aac", "flac", "webm", "mov", "3gp"]

export interface FileAsrAuth {
  apiKey: string
  appId: string
  accessToken: string
  resourceId: string
}

export interface FileAsrResponse {
  status: number
  headers: Record<string, string>
  text: string
}

export type FileAsrPost = (url: string, headers: Record<string, string>, body: string) => Promise<FileAsrResponse>

export interface FileUtterance {
  text: string
  startMs: number
  endMs: number
  speaker?: string
}

export interface FileAsrResult {
  durationMs: number
  utterances: FileUtterance[]
  text: string
}

export type FileAsrStage = { stage: "uploading" } | { stage: "recognizing"; waitedMs: number }

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

/** Rejects empty or silently truncated results instead of passing them on as complete. */
export function assertCoverage(result: FileAsrResult): void {
  if (!result.text && result.utterances.length === 0) throw new Error("识别结果为空：接口报告成功，但没有返回任何文字")
  if (!result.durationMs || result.utterances.length === 0) return
  const covered = Math.max(...result.utterances.map((u) => u.endMs))
  const ratio = covered / result.durationMs
  if (ratio < MIN_COVERAGE) {
    throw new Error(`识别结果不完整：录音 ${formatClock(result.durationMs)}，结果只到 ${formatClock(covered)}（${Math.round(ratio * 100)}%）。接口未报错，属于静默截断，已中止`)
  }
}

export async function transcribeFile(
  auth: FileAsrAuth,
  audio: { base64: string; format: string },
  options: { speakers: boolean; post: FileAsrPost; onStage?: (stage: FileAsrStage) => void; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal },
): Promise<FileAsrResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => window.setTimeout(r, ms)))
  const requestId = randomUUID()
  options.onStage?.({ stage: "uploading" })
  const submitted = statusOf(await options.post(FILE_ASR_BASE + SUBMIT_PATH, headers(auth, requestId), JSON.stringify(buildFileRequest(audio.base64, audio.format, options.speakers))))
  if (submitted.code !== STATUS_OK) fail(submitted.code, submitted.message)

  let waited = 0
  let delay = POLL_START_MS
  for (;;) {
    if (options.signal?.aborted) throw new Error("已取消")
    options.onStage?.({ stage: "recognizing", waitedMs: waited })
    const polled = statusOf(await options.post(FILE_ASR_BASE + QUERY_PATH, headers(auth, requestId), "{}"))
    if (!STATUS_PENDING.has(polled.code)) {
      if (polled.code !== STATUS_OK) fail(polled.code, polled.message)
      const result = parseFileResult(polled.body)
      assertCoverage(result)
      return result
    }
    if (waited >= MAX_WAIT_MS) throw new Error(`识别超时：已等待 ${Math.round(waited / 60000)} 分钟仍未完成`)
    await sleep(delay)
    waited += delay
    delay = Math.min(delay * 2, POLL_MAX_MS)
  }
}

const MAX_BLOCK_CHARS = 500
const MAX_GAP_MS = 8000

export interface TranscriptBlock {
  speaker?: string
  startMs: number
  text: string
}

/** Merges consecutive sentences of one speaker into paragraphs, splitting long runs and long pauses. */
export function groupBySpeaker(utterances: FileUtterance[]): TranscriptBlock[] {
  const blocks: (TranscriptBlock & { endMs: number })[] = []
  for (const u of utterances) {
    const last = blocks[blocks.length - 1]
    if (last && last.speaker === u.speaker && last.text.length < MAX_BLOCK_CHARS && u.startMs - last.endMs <= MAX_GAP_MS) {
      last.text += u.text
      last.endMs = u.endMs
    } else blocks.push({ speaker: u.speaker, startMs: u.startMs, text: u.text, endMs: u.endMs })
  }
  return blocks.map(({ speaker, startMs, text }) => ({ speaker, startMs, text }))
}

/** Speaker-labelled paragraphs, so the model can tell interviewer and interviewee apart. */
export function speakerUtterances(result: FileAsrResult): Utterance[] {
  const blocks = groupBySpeaker(result.utterances)
  const labelled = blocks.some((b) => b.speaker)
  return blocks.map((b) => ({ startMs: b.startMs, endMs: b.startMs, text: labelled ? `说话人${b.speaker ?? "?"}：${b.text}` : b.text }))
}

export interface RecordMeta {
  title: string
  source: string
  /** Vault path, embedded as a player when present. */
  vaultPath?: string
  transcribedAt: string
  resourceId: string
}

export function renderInterviewRecord(result: FileAsrResult, meta: RecordMeta, withHeading: boolean): string {
  const blocks = groupBySpeaker(result.utterances)
  const speakers = new Set(blocks.map((b) => b.speaker).filter(Boolean))
  const lines: string[] = []
  if (withHeading) lines.push(`# ${meta.title}`, "")
  lines.push(`## 访谈记录 · ${meta.source}`, "")
  if (meta.vaultPath) lines.push(`![[${meta.vaultPath}]]`, "")
  const facts = [`时长 ${formatClock(result.durationMs, true)}`, speakers.size ? `${speakers.size} 位说话人` : "", `${result.utterances.length} 句`, `转写于 ${meta.transcribedAt}`].filter(Boolean)
  lines.push(`> [!info] 火山引擎录音文件识别原始转写（${meta.resourceId}）`, `> ${facts.join(" · ")}`)
  if (speakers.size) lines.push("> 说话人编号由声音自动区分，不代表身份，请按实际人物替换。")
  lines.push("")
  if (blocks.length === 0) lines.push(result.text, "")
  for (const block of blocks) {
    const who = speakers.size ? `**说话人 ${block.speaker ?? "?"}** ` : ""
    lines.push(`${who}\`${formatClock(block.startMs, true)}\``, block.text, "")
  }
  return lines.join("\n")
}
