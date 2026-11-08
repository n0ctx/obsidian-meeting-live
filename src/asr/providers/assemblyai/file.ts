// Recorded-file transcription with AssemblyAI: upload the bytes, submit a transcript job, poll until it is done.
//   https://www.assemblyai.com/docs/getting-started/transcribe-an-audio-file  (POST /v2/upload with the raw bytes, POST /v2/transcript, GET /v2/transcript/{id}; `authorization` without Bearer; utterances in ms)
//   https://www.assemblyai.com/docs/api-reference/transcripts/submit  (audio_url; language_code or automatic detection; speaker_labels; speech_models is optional)
// Without speaker labels the reply has words but no sentences, so the words are grouped into sentences here.
import type { PreparedAudio } from "../../../audio/transcode.ts"
import { t } from "../../../i18n/index.ts"
import { hostOf } from "../../../url.ts"
import type { FileAsrCall, FileAsrProvider, FileAsrResponse, FileAsrResult, FileUtterance } from "../../fileAsr.ts"
import { joinWords } from "../words.ts"
import { ASSEMBLYAI_DIRECT_FORMATS, ASSEMBLYAI_FILE_CAPABILITIES, ASSEMBLYAI_ID } from "./info.ts"

export interface AssemblyAiFileConfig {
  /** `https://api.assemblyai.com` or the EU host. */
  baseUrl: string
  apiKey: string
  /** ISO 639-1 code, or undefined to let the service detect it. */
  language: string | undefined
}

const POLL_START_MS = 3000
const POLL_MAX_MS = 10_000
const MAX_WAIT_MS = 30 * 60_000
/** A sentence ends at terminal punctuation; a run without any is cut here so a block stays readable. */
const SENTENCE_END = /[.!?。！？]$/
const MAX_WORDS_PER_SENTENCE = 40

function detail(response: FileAsrResponse): string {
  try {
    const error = (JSON.parse(response.text) as { error?: unknown }).error
    if (typeof error === "string" && error) return error
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return response.text.trim().slice(0, 200)
}

/** Turns a failed response into a message that says what to fix. */
export function errorOf(response: FileAsrResponse): Error {
  const why = detail(response)
  const status = response.status
  if (status === 401 || status === 403) return new Error(t("assemblyai.auth", why))
  if (status === 402) return new Error(t("assemblyai.balance", why))
  if (status === 429) return new Error(t("assemblyai.rate", why))
  if (status >= 500) return new Error(t("assemblyai.server", status, why))
  return new Error(t("assemblyai.fileRejected", status, why))
}

const json = (response: FileAsrResponse): Record<string, unknown> => {
  if (response.status >= 400) throw errorOf(response)
  try {
    const parsed = JSON.parse(response.text) as unknown
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
  } catch {
    // Reported below.
  }
  throw new Error(t("assemblyai.notJson", response.status, response.text.trim().slice(0, 160)))
}

const ms = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0)
const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

interface RawWord {
  text?: unknown
  start?: unknown
  end?: unknown
}

/** Groups timed words into sentences: at terminal punctuation, and at a length limit for runs without any. */
export function sentencesFromWords(words: RawWord[]): FileUtterance[] {
  const out: FileUtterance[] = []
  let run: string[] = []
  let start = 0
  let end = 0
  const flush = () => {
    if (run.length) out.push({ text: joinWords(run), startMs: start, endMs: Math.max(start, end) })
    run = []
  }
  for (const w of words) {
    const text = str(w.text)
    if (!text) continue
    if (run.length === 0) start = ms(w.start)
    run.push(text)
    end = ms(w.end)
    if (SENTENCE_END.test(text) || run.length >= MAX_WORDS_PER_SENTENCE) flush()
  }
  flush()
  return out
}

/** Reads a finished transcript: speaker utterances when the job asked for labels, sentences grouped from words otherwise. */
export function parseTranscript(body: Record<string, unknown>, speakers: boolean): FileAsrResult {
  const text = str(body.text)
  const labelled = Array.isArray(body.utterances) ? (body.utterances as { text?: unknown; start?: unknown; end?: unknown; speaker?: unknown }[]) : []
  const utterances: FileUtterance[] =
    speakers && labelled.length
      ? labelled.map((u) => ({ text: str(u.text), startMs: ms(u.start), endMs: ms(u.end), speaker: typeof u.speaker === "string" || typeof u.speaker === "number" ? String(u.speaker) : undefined })).filter((u) => u.text)
      : sentencesFromWords(Array.isArray(body.words) ? (body.words as RawWord[]) : [])
  if (utterances.length === 0 && text) utterances.push({ text, startMs: 0, endMs: 0 })
  return { durationMs: ms(Number(body.audio_duration) * 1000), utterances, text }
}

/** The bytes of the upload as a buffer of exactly their own length. */
const bytesOf = (data: Uint8Array): ArrayBuffer => (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? (data.buffer as ArrayBuffer) : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer))

export function submitBody(uploadUrl: string, config: AssemblyAiFileConfig, speakers: boolean): Record<string, unknown> {
  // Detection is automatic when no language code is given (and may only be switched off together with one).
  const body: Record<string, unknown> = { audio_url: uploadUrl }
  if (config.language) body.language_code = config.language
  if (speakers) body.speaker_labels = true
  return body
}

export async function assemblyAiTranscribeFile(config: AssemblyAiFileConfig, audio: PreparedAudio, call: FileAsrCall): Promise<FileAsrResult> {
  const { get } = call
  if (!get) throw new Error(t("assemblyai.noGet"))
  const sleep = call.sleep ?? ((delay: number) => new Promise<void>((r) => window.setTimeout(r, delay)))
  const base = config.baseUrl.replace(/\/+$/, "")
  const auth = { authorization: config.apiKey }

  call.onStage?.({ stage: "uploading" })
  const uploaded = json(await call.post(`${base}/v2/upload`, { ...auth, "Content-Type": "application/octet-stream" }, bytesOf(audio.data)))
  const uploadUrl = str(uploaded.upload_url)
  if (!uploadUrl) throw new Error(t("assemblyai.noUploadUrl"))
  const submitted = json(await call.post(`${base}/v2/transcript`, { ...auth, "Content-Type": "application/json" }, JSON.stringify(submitBody(uploadUrl, config, call.speakers))))
  const id = str(submitted.id)
  if (!id) throw new Error(t("assemblyai.noTranscriptId"))

  let waited = 0
  let delay = POLL_START_MS
  for (;;) {
    if (call.signal?.aborted) throw new Error(t("asr.cancelled"))
    call.onStage?.({ stage: "recognizing", waitedMs: waited })
    const polled = json(await get(`${base}/v2/transcript/${id}`, auth))
    if (polled.status === "completed") return parseTranscript(polled, call.speakers)
    if (polled.status === "error") throw new Error(t("assemblyai.jobFailed", str(polled.error)))
    if (waited >= MAX_WAIT_MS) throw new Error(t("assemblyai.timeoutWait", Math.round(waited / 60000)))
    await sleep(delay)
    waited += delay
    delay = Math.min(delay * 2, POLL_MAX_MS)
  }
}

export function assemblyAiFileProvider(config: AssemblyAiFileConfig): FileAsrProvider {
  return {
    id: ASSEMBLYAI_ID,
    name: t("provider.assemblyai"),
    host: hostOf(config.baseUrl),
    // The documented default priority list; the model that actually ran is not read back.
    model: "universal-3-5-pro, universal-2",
    capabilities: ASSEMBLYAI_FILE_CAPABILITIES,
    directFormats: ASSEMBLYAI_DIRECT_FORMATS,
    problem: config.apiKey ? undefined : t("assemblyai.noKey"),
    transcribe: (audio, call) => assemblyAiTranscribeFile(config, audio, call),
  }
}
