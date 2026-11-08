// Recorded-file transcription with Fun-ASR on DashScope. The service reads a file from a URL, so the recording is first put in
// DashScope's temporary storage (an oss:// address valid for 48 hours), then a task is submitted and polled, and the finished
// transcript is downloaded from the signed address the task returns.
//   https://www.alibabacloud.com/help/en/model-studio/get-temporary-file-url  (GET /api/v1/uploads?action=getPolicy, the multipart POST to OSS with the file as the last field, oss://<key>, X-DashScope-OssResourceResolve, 48 h, 1 GB)
//   https://www.alibabacloud.com/help/en/model-studio/fun-asr-recorded-speech-recognition-http-api  (submit with X-DashScope-Async, `parameters` required, GET /api/v1/tasks/{id}, transcription_url valid 24 h, result JSON)
//   https://www.alibabacloud.com/help/en/model-studio/fun-asr-recorded-speech-recognition-python-sdk  (diarization_enabled for mono audio, speaker_id counted from 0, language_hints)
// The documentation calls the temporary storage fit for development and testing, and marks the resolve header "not recommended" on the
// Fun-ASR page while requiring it on the storage page. This path has not been run against the service.
import type { PreparedAudio } from "../../../audio/transcode.ts"
import { t } from "../../../i18n/index.ts"
import { hostOf } from "../../../url.ts"
import type { FileAsrCall, FileAsrProvider, FileAsrResponse, FileAsrResult, FileUtterance } from "../../fileAsr.ts"
import { buildMultipart } from "../../multipart.ts"
import { DASHSCOPE_FILE_CAPABILITIES, DASHSCOPE_FILE_MODEL, DASHSCOPE_ID } from "./info.ts"

export interface DashScopeFileConfig {
  /** `https://dashscope.aliyuncs.com` or the international host. */
  baseUrl: string
  apiKey: string
  model: string
  /** ISO 639-1 code, or undefined to let the service detect it. */
  language: string | undefined
}

/** Extension → format name; the service takes mainstream formats, and none of this list was read from its audio specification (not confirmed). */
export const DASHSCOPE_DIRECT_FORMATS: Record<string, string> = { mp3: "mp3", m4a: "m4a", mp4: "mp4", wav: "wav", ogg: "ogg", opus: "ogg", flac: "flac", aac: "aac", webm: "webm" }

const MIME: Record<string, string> = { mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", aac: "audio/aac", webm: "audio/webm" }

const POLL_START_MS = 3000
const POLL_MAX_MS = 15_000
const MAX_WAIT_MS = 30 * 60_000

type Json = Record<string, unknown>
const asRecord = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {})
const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "")
const ms = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0
}

function detail(response: FileAsrResponse): string {
  try {
    const body = JSON.parse(response.text) as { message?: unknown }
    if (typeof body.message === "string" && body.message) return body.message
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
      return new Error(t("dashscope.auth", why))
    case 403:
      return new Error(t("dashscope.forbidden", why))
    case 429:
      return new Error(t("dashscope.fileRate", why))
    default:
      return new Error(response.status >= 500 ? t("dashscope.fileServer", response.status, why) : t("dashscope.fileRejected", response.status, why))
  }
}

function json(response: FileAsrResponse): Json {
  if (response.status >= 400) throw errorOf(response)
  try {
    return asRecord(JSON.parse(response.text))
  } catch {
    throw new Error(t("dashscope.fileNotJson", response.status, response.text.trim().slice(0, 160)))
  }
}

const bearer = (config: DashScopeFileConfig): Record<string, string> => ({ Authorization: `Bearer ${config.apiKey}` })

/** Puts the recording in temporary storage and returns its oss:// address. */
async function upload(config: DashScopeFileConfig, audio: PreparedAudio, call: FileAsrCall & { get: NonNullable<FileAsrCall["get"]> }): Promise<string> {
  const policyUrl = `${config.baseUrl}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(config.model)}`
  const policy = asRecord(json(await call.get(policyUrl, { ...bearer(config), "Content-Type": "application/json" })).data)
  const host = str(policy.upload_host)
  const dir = str(policy.upload_dir)
  if (!host || !dir) throw new Error(t("dashscope.noPolicy"))
  const key = `${dir}/audio.${audio.format}`
  // The file must be the last field, and the form carries the credential the policy call returned.
  const fields: [string, string][] = [
    ["OSSAccessKeyId", str(policy.oss_access_key_id)],
    ["Signature", str(policy.signature)],
    ["policy", str(policy.policy)],
    ["x-oss-object-acl", str(policy.x_oss_object_acl)],
    ["x-oss-forbid-overwrite", str(policy.x_oss_forbid_overwrite)],
    ["key", key],
    ["success_action_status", "200"],
  ]
  const form = buildMultipart(fields, { name: `audio.${audio.format}`, mime: MIME[audio.format] ?? "application/octet-stream", data: audio.data })
  const stored = await call.post(host, { "Content-Type": form.contentType }, form.body)
  if (stored.status >= 400) throw new Error(t("dashscope.uploadFailed", stored.status, stored.text.trim().slice(0, 200)))
  return `oss://${key}`
}

/** What the transcript's sentences say, with speakers numbered from 1 where the job separated them. */
export function parseTranscript(body: Json, speakers: boolean): FileAsrResult {
  const transcript = asRecord((Array.isArray(body.transcripts) ? body.transcripts : [])[0])
  const utterances: FileUtterance[] = (Array.isArray(transcript.sentences) ? transcript.sentences : [])
    .map((raw) => {
      const s = asRecord(raw)
      const speaker = speakers && typeof s.speaker_id === "number" && Number.isFinite(s.speaker_id) ? String(s.speaker_id + 1) : undefined
      const startMs = ms(s.begin_time)
      return { text: str(s.text), startMs, endMs: Math.max(startMs, ms(s.end_time)), speaker }
    })
    .filter((u) => u.text)
  const text = str(transcript.text)
  if (utterances.length === 0 && text) utterances.push({ text, startMs: 0, endMs: 0 })
  return { durationMs: ms(asRecord(body.properties).original_duration_in_milliseconds), utterances, text }
}

export function submitBody(url: string, config: DashScopeFileConfig, speakers: boolean): Json {
  // `parameters` must be present even when empty: without it the task is accepted and then fails.
  const parameters: Json = {}
  if (config.language) parameters.language_hints = [config.language]
  if (speakers) parameters.diarization_enabled = true
  return { model: config.model, input: { file_urls: [url] }, parameters }
}

export async function dashScopeTranscribeFile(config: DashScopeFileConfig, audio: PreparedAudio, call: FileAsrCall): Promise<FileAsrResult> {
  const { get } = call
  if (!get) throw new Error(t("dashscope.noGet"))
  const sleep = call.sleep ?? ((delay: number) => new Promise<void>((r) => window.setTimeout(r, delay)))
  const base = { ...config, baseUrl: config.baseUrl.replace(/\/+$/, "") }

  call.onStage?.({ stage: "uploading" })
  const url = await upload(base, audio, { ...call, get })
  const submitted = asRecord(
    json(await call.post(`${base.baseUrl}/api/v1/services/audio/asr/transcription`, { ...bearer(base), "Content-Type": "application/json", "X-DashScope-Async": "enable", "X-DashScope-OssResourceResolve": "enable" }, JSON.stringify(submitBody(url, base, call.speakers)))).output,
  )
  const taskId = str(submitted.task_id)
  if (!taskId) throw new Error(t("dashscope.noTaskId"))

  let waited = 0
  let delay = POLL_START_MS
  for (;;) {
    if (call.signal?.aborted) throw new Error(t("asr.cancelled"))
    call.onStage?.({ stage: "recognizing", waitedMs: waited })
    const output = asRecord(json(await get(`${base.baseUrl}/api/v1/tasks/${taskId}`, bearer(base))).output)
    const status = str(output.task_status)
    if (status === "SUCCEEDED" || status === "FAILED") {
      const first = asRecord((Array.isArray(output.results) ? output.results : [])[0])
      if (status === "FAILED" || str(first.subtask_status) !== "SUCCEEDED") throw new Error(t("dashscope.jobFailed", [str(first.code) || str(output.code), str(first.message) || str(output.message)].filter(Boolean).join(" ")))
      const link = str(first.transcription_url)
      if (!link) throw new Error(t("dashscope.noTranscriptUrl"))
      // The signed address is on Alibaba Cloud storage and takes no credentials.
      return parseTranscript(json(await get(link, {})), call.speakers)
    }
    if (waited >= MAX_WAIT_MS) throw new Error(t("dashscope.fileTimeout", Math.round(waited / 60000)))
    await sleep(delay)
    waited += delay
    delay = Math.min(delay * 2, POLL_MAX_MS)
  }
}

export function dashScopeFileProvider(config: DashScopeFileConfig): FileAsrProvider {
  return {
    id: DASHSCOPE_ID,
    name: t("provider.dashscope"),
    host: hostOf(config.baseUrl),
    model: config.model || DASHSCOPE_FILE_MODEL,
    capabilities: DASHSCOPE_FILE_CAPABILITIES,
    directFormats: DASHSCOPE_DIRECT_FORMATS,
    problem: config.apiKey ? undefined : t("dashscope.noKey"),
    transcribe: (audio, call) => dashScopeTranscribeFile(config, audio, call),
  }
}
