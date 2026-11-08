// Deepgram recorded-file transcription: POST /v1/listen with the raw audio as the body, answered in one response.
//   https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded  (query parameters, utterances, speaker per utterance, metadata.duration)
//   https://developers.deepgram.com/docs/pre-recorded-audio  (raw body with a matching Content-Type, 2 GB maximum, 504 after 10 minutes of processing)
//   https://developers.deepgram.com/docs/diarization  (diarize=true; deprecated in favour of diarize_model but still accepted)
import type { PreparedAudio } from "../../../audio/transcode.ts"
import { t } from "../../../i18n/index.ts"
import { hostOf, isLocalHost } from "../../../url.ts"
import type { FileAsrCall, FileAsrProvider, FileAsrResponse, FileAsrResult, FileUtterance } from "../../fileAsr.ts"
import { DEEPGRAM_FILE_CAPABILITIES, DEEPGRAM_ID } from "./info.ts"

export interface DeepgramFileConfig {
  /** The `/v1/listen` address over HTTP(S). */
  url: string
  apiKey: string
  model: string
  /** ISO 639-1 code, or undefined to let Deepgram detect the dominant language. */
  language: string | undefined
}

/**
 * Formats taken as they are. Deepgram's supported-formats page was not read, so only common ones are named (not confirmed);
 * the recompressed upload is Ogg Opus.
 */
export const DEEPGRAM_DIRECT_FORMATS: Record<string, string> = { mp3: "mp3", m4a: "m4a", mp4: "mp4", wav: "wav", ogg: "ogg", opus: "ogg", flac: "flac", webm: "webm", aac: "aac" }

const MIME: Record<string, string> = { mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", webm: "audio/webm", aac: "audio/aac" }

/** Utterances give timed sentences, which is what the transcript is made of; `punctuate` and `smart_format` keep the text readable. */
export function deepgramFileUrl(config: DeepgramFileConfig, speakers: boolean): string {
  const url = new URL(config.url.trim())
  const params: Record<string, string> = { model: config.model.trim(), smart_format: "true", utterances: "true" }
  if (config.language) params.language = config.language
  else params.detect_language = "true"
  if (speakers) params.diarize = "true"
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

function detail(response: FileAsrResponse): string {
  try {
    const body = JSON.parse(response.text) as { err_msg?: unknown; message?: unknown }
    const message = body.err_msg ?? body.message
    if (typeof message === "string" && message) return message
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return response.text.trim().slice(0, 200)
}

/** Turns a failed response into a message that says what to fix. */
export function errorOf(response: FileAsrResponse): Error {
  const why = detail(response)
  switch (response.status) {
    case 401:
      return new Error(t("deepgram.auth", why))
    case 402:
      return new Error(t("deepgram.balance", why))
    case 403:
      return new Error(t("deepgram.forbidden", why))
    case 413:
      return new Error(t("deepgram.fileTooLarge"))
    case 429:
      return new Error(t("deepgram.fileRate", why))
    case 504:
      return new Error(t("deepgram.fileSlow"))
    default:
      return new Error(response.status >= 500 ? t("deepgram.fileServer", response.status, why) : t("deepgram.fileRejected", response.status, why))
  }
}

const ms = (seconds: unknown): number => {
  const n = Number(seconds)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : 0
}

/**
 * Reads the reply: timed utterances with their speaker (Deepgram numbers from 0; people read "speaker 1", as for live), or the
 * whole transcript as one untimed block when the model returned no utterances.
 */
export function parseDeepgramFile(raw: string, speakers: boolean): FileAsrResult {
  let body: { metadata?: { duration?: unknown }; results?: { utterances?: unknown; channels?: { alternatives?: { transcript?: unknown }[] }[] } }
  try {
    body = JSON.parse(raw) as typeof body
  } catch {
    throw new Error(t("deepgram.fileNotJson", raw.trim().slice(0, 160)))
  }
  const text = typeof body.results?.channels?.[0]?.alternatives?.[0]?.transcript === "string" ? body.results.channels[0].alternatives[0].transcript.trim() : ""
  const utterances: FileUtterance[] = (Array.isArray(body.results?.utterances) ? (body.results.utterances as { transcript?: unknown; start?: unknown; end?: unknown; speaker?: unknown }[]) : [])
    .map((u) => {
      const speaker = speakers && typeof u.speaker === "number" && Number.isFinite(u.speaker) ? String(u.speaker + 1) : undefined
      const startMs = ms(u.start)
      return { text: typeof u.transcript === "string" ? u.transcript.trim() : "", startMs, endMs: Math.max(startMs, ms(u.end)), speaker }
    })
    .filter((u) => u.text)
  if (utterances.length === 0 && text) utterances.push({ text, startMs: 0, endMs: 0 })
  return { durationMs: ms(body.metadata?.duration), utterances, text }
}

export async function deepgramTranscribeFile(config: DeepgramFileConfig, audio: PreparedAudio, call: FileAsrCall): Promise<FileAsrResult> {
  if (call.signal?.aborted) throw new Error(t("asr.cancelled"))
  const headers: Record<string, string> = { "Content-Type": MIME[audio.format] ?? "application/octet-stream" }
  if (config.apiKey) headers.Authorization = `Token ${config.apiKey}`
  // The view may cover only part of the buffer behind it, so send exactly its bytes.
  const { data } = audio
  const body = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? (data.buffer as ArrayBuffer) : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
  call.onStage?.({ stage: "uploading" })
  const pending = call.post(deepgramFileUrl(config, call.speakers), headers, body)
  call.onStage?.({ stage: "recognizing", waitedMs: 0 })
  const response = await pending
  if (response.status >= 400) throw errorOf(response)
  return parseDeepgramFile(response.text, call.speakers)
}

export function deepgramFileProvider(config: DeepgramFileConfig): FileAsrProvider {
  const host = hostOf(config.url)
  const problem = !config.url ? t("deepgram.noEndpoint") : !host ? t("deepgram.badEndpoint") : !config.model ? t("deepgram.noModel") : !config.apiKey && !isLocalHost(host) ? t("deepgram.noKey") : undefined
  return { id: DEEPGRAM_ID, name: t("provider.deepgram"), host, model: config.model, capabilities: DEEPGRAM_FILE_CAPABILITIES, directFormats: DEEPGRAM_DIRECT_FORMATS, problem, transcribe: (audio, call) => deepgramTranscribeFile(config, audio, call) }
}
