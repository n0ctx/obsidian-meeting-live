// Recorded-file transcription over the OpenAI audio API: POST <base>/audio/transcriptions with a multipart form.
// One adapter for OpenAI, Groq and local Whisper servers, which all speak this shape.
//   https://developers.openai.com/api/docs/guides/speech-to-text
//   https://console.groq.com/docs/speech-to-text
import type { PreparedAudio } from "../../../audio/transcode.ts"
import { t } from "../../../i18n/index.ts"
import { hostOf, isLocalHost } from "../../../url.ts"
import type { FileAsrCall, FileAsrProvider, FileAsrResponse, FileAsrResult, FileUtterance } from "../../fileAsr.ts"
import { buildMultipart } from "../../multipart.ts"
import { OPENAI_COMPAT_ID } from "./info.ts"

export { buildMultipart, type MultipartForm } from "../../multipart.ts"

export interface OpenAiFileConfig {
  baseUrl: string
  model: string
  apiKey: string
  /** ISO 639-1 code, or undefined to let the service detect it. */
  language: string | undefined
  fileSizeLimit: number
  /** Text that steers the first window of recognition (the API's `prompt`); only local Whisper servers set it. */
  prompt?: string
}

/**
 * Formats taken as they are. OpenAI's current guide lists mp3, mp4, mpeg, mpga, m4a, wav and webm; Groq also lists ogg and flac.
 * The recompressed upload is Ogg Opus, so ogg matters most here, and OpenAI's current list does not name it (not confirmed).
 */
export const OPENAI_DIRECT_FORMATS: Record<string, string> = { mp3: "mp3", mpeg: "mp3", mpga: "mp3", m4a: "m4a", mp4: "mp4", wav: "wav", webm: "webm", ogg: "ogg", opus: "ogg" }

const MIME: Record<string, string> = { mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", wav: "audio/wav", webm: "audio/webm", ogg: "audio/ogg" }

export function transcriptionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "")
  return /\/audio\/transcriptions$/.test(trimmed) ? trimmed : `${trimmed}/audio/transcriptions`
}

/** The diarizing model answers with speaker-labelled segments (response_format diarized_json, per the speech-to-text guide). */
export const isDiarizeModel = (model: string): boolean => /diarize/i.test(model)

/** Models of the gpt-*-transcribe family return text only: the guide says timestamp_granularities is whisper-1 only. */
const isTextOnlyModel = (model: string): boolean => /^gpt-.*transcribe/i.test(model.trim())

export type ResponseFormat = "verbose_json" | "json" | "diarized_json"

/** The richest format the model is known to give: timed segments by default, speaker segments for the diarizing model, plain text for gpt-*-transcribe. */
export function responseFormatFor(model: string): ResponseFormat {
  if (isDiarizeModel(model)) return "diarized_json"
  return isTextOnlyModel(model) ? "json" : "verbose_json"
}

function detail(response: FileAsrResponse): string {
  try {
    const error = (JSON.parse(response.text) as { error?: unknown }).error
    const message = typeof error === "string" ? error : (error as { message?: unknown } | undefined)?.message
    if (typeof message === "string" && message) return message
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return response.text.trim().slice(0, 200)
}

/** Turns a failed response into a message that says what to fix. */
export function errorOf(response: FileAsrResponse): Error {
  const status = response.status
  const why = detail(response)
  if (status === 401 || status === 403) return new Error(t("openai.auth", status, why))
  if (status === 404) return new Error(t("openai.notFound", why))
  if (status === 413) return new Error(t("openai.tooLarge"))
  if (status === 429) return new Error(t("openai.rate", why))
  if (status >= 500) return new Error(t("openai.server", status, why))
  return new Error(t("openai.rejected", status, why))
}

const seconds = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : 0
}

/**
 * Reads a transcription reply of any of the formats: timed segments (verbose_json), speaker segments (diarized_json) or
 * text only (json, or a bare body). Text without timing becomes one block at the start with no duration, so the coverage
 * check has nothing to compare and only the emptiness check applies.
 */
export function parseTranscription(raw: string, speakers: boolean): FileAsrResult {
  let body: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw) as unknown
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { text: String(parsed) }
  } catch {
    body = { text: raw }
  }
  const text = typeof body.text === "string" ? body.text.trim() : ""
  const utterances: FileUtterance[] = (Array.isArray(body.segments) ? body.segments : [])
    .map((segment) => {
      const s = (segment ?? {}) as { text?: unknown; start?: unknown; end?: unknown; speaker?: unknown }
      const speaker = speakers && (typeof s.speaker === "string" || typeof s.speaker === "number") ? String(s.speaker) : undefined
      return { text: typeof s.text === "string" ? s.text.trim() : "", startMs: seconds(s.start), endMs: seconds(s.end), speaker }
    })
    .filter((u) => u.text)
  if (utterances.length === 0 && text) utterances.push({ text, startMs: 0, endMs: 0 })
  return { durationMs: seconds(body.duration), utterances, text }
}

/** Speakers, timestamps and chunking are asked of the service only for the formats that give them. */
function fields(config: OpenAiFileConfig, format: ResponseFormat): [string, string][] {
  const list: [string, string][] = [["model", config.model], ["response_format", format]]
  if (config.prompt) list.push(["prompt", config.prompt])
  if (format === "verbose_json") list.push(["timestamp_granularities[]", "segment"])
  if (format === "diarized_json") list.push(["chunking_strategy", "auto"])
  // The diarizing model takes no language hint in the guide's description, and gpt-transcribe takes a `languages` array instead of
  // `language` (never both); how that array is encoded in a form is not documented, so those two get no hint. Others take an ISO 639-1 code.
  if (config.language && format !== "diarized_json" && !/^gpt-transcribe/i.test(config.model.trim())) list.push(["language", config.language])
  return list
}

export async function openAiTranscribeFile(config: OpenAiFileConfig, audio: PreparedAudio, call: FileAsrCall): Promise<FileAsrResult> {
  const send = (format: ResponseFormat) => {
    if (call.signal?.aborted) throw new Error(t("asr.cancelled"))
    const form = buildMultipart(fields(config, format), { name: `audio.${audio.format}`, mime: MIME[audio.format] ?? "application/octet-stream", data: audio.data })
    const headers: Record<string, string> = { "Content-Type": form.contentType }
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
    return call.post(transcriptionsUrl(config.baseUrl), headers, form.body)
  }
  let format = responseFormatFor(config.model)
  call.onStage?.({ stage: "uploading" })
  let pending = send(format)
  call.onStage?.({ stage: "recognizing", waitedMs: 0 })
  let response = await pending
  // A server that does not know verbose_json for this model (local servers, newer models) is asked for plain JSON instead.
  if (response.status === 400 && format === "verbose_json") {
    format = "json"
    pending = send(format)
    response = await pending
  }
  if (response.status >= 400) throw errorOf(response)
  return parseTranscription(response.text, call.speakers && format === "diarized_json")
}

export function openAiFileProvider(config: OpenAiFileConfig): FileAsrProvider {
  const host = hostOf(config.baseUrl)
  const problem = !config.baseUrl ? t("openai.noBaseUrl") : !host ? t("openai.badBaseUrl") : !config.model ? t("openai.noModel") : !config.apiKey && !isLocalHost(host) ? t("openai.noKey") : undefined
  return {
    id: OPENAI_COMPAT_ID,
    name: t("provider.openaiCompat"),
    host,
    model: config.model,
    capabilities: { language: true, diarization: isDiarizeModel(config.model), fileSizeLimit: config.fileSizeLimit },
    directFormats: OPENAI_DIRECT_FORMATS,
    problem,
    transcribe: (audio, call) => openAiTranscribeFile(config, audio, call),
  }
}
