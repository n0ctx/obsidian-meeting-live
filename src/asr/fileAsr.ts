// Recorded-file ASR, independent of the provider: the provider interface, the checks and the rendering.
import type { PreparedAudio } from "../audio/transcode.ts"
import { t, tr, uiLang, type Lang } from "../i18n/index.ts"
import { formatClock, type Utterance } from "../meeting/types.ts"
import type { FileCapabilities } from "./providers/types.ts"

/** Transcripts must reach this share of the audio; the service can truncate silently. */
export const MIN_COVERAGE = 0.8

export interface FileAsrResponse {
  status: number
  headers: Record<string, string>
  text: string
}

/** Obsidian's requestUrl takes a string or an ArrayBuffer body; the latter carries multipart uploads. */
export type FileAsrPost = (url: string, headers: Record<string, string>, body: string | ArrayBuffer) => Promise<FileAsrResponse>

export interface FileUtterance {
  text: string
  startMs: number
  endMs: number
  speaker?: string
}

export interface FileAsrResult {
  /** Length of the recording; 0 when the service did not say, which turns the truncation check off. */
  durationMs: number
  utterances: FileUtterance[]
  text: string
  /** How many pieces the recording was cut into and recognized separately; absent for a recording recognized whole. */
  chunks?: number
}

/** A GET, for services that are asked for a transcript once it is ready; absent where the caller has not provided one. */
export type FileAsrGet = (url: string, headers: Record<string, string>) => Promise<FileAsrResponse>

export type FileAsrStage = { stage: "uploading" } | { stage: "recognizing"; waitedMs: number }

export interface FileAsrCall {
  speakers: boolean
  post: FileAsrPost
  get?: FileAsrGet
  onStage?: (stage: FileAsrStage) => void
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

/** A recorded-file recognizer bound to the user's configuration. */
export interface FileAsrProvider {
  readonly id: string
  /** Display name for notices and notes. */
  readonly name: string
  /** Host the audio is uploaded to, for privacy text and consent. */
  readonly host: string
  /** Model or resource that recognizes the audio, recorded in notes. */
  readonly model: string
  readonly capabilities: FileCapabilities
  /** Formats the service takes as they are: lower-case file extension → the service's format name. */
  readonly directFormats: Record<string, string>
  /** Why it cannot be used right now, such as missing credentials. */
  readonly problem?: string
  /** Recognizes the audio. The result is not yet checked for truncation; see `transcribeFile`. */
  transcribe(audio: PreparedAudio, call: FileAsrCall): Promise<FileAsrResult>
}

/** Rejects empty or silently truncated results instead of passing them on as complete. */
export function assertCoverage(result: FileAsrResult): void {
  if (!result.text && result.utterances.length === 0) throw new Error(t("asr.empty"))
  if (!result.durationMs || result.utterances.length === 0) return
  const covered = Math.max(...result.utterances.map((u) => u.endMs))
  const ratio = covered / result.durationMs
  if (ratio < MIN_COVERAGE) {
    throw new Error(t("asr.truncated", formatClock(result.durationMs), formatClock(covered), Math.round(ratio * 100)))
  }
}

/** Recognizes a recording and rejects empty or silently truncated results instead of passing them on as complete. */
export async function transcribeFile(provider: FileAsrProvider, audio: PreparedAudio, call: FileAsrCall): Promise<FileAsrResult> {
  const result = await provider.transcribe(audio, call)
  assertCoverage(result)
  return result
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
export function speakerUtterances(result: FileAsrResult, lang: Lang = uiLang()): Utterance[] {
  const blocks = groupBySpeaker(result.utterances)
  const labelled = blocks.some((b) => b.speaker)
  return blocks.map((b) => ({ startMs: b.startMs, endMs: b.startMs, text: labelled ? tr(lang, "note.speakerLine", b.speaker ?? "?", b.text) : b.text }))
}

export interface RecordMeta {
  title: string
  source: string
  /** Vault path, embedded as a player when present. */
  vaultPath?: string
  transcribedAt: string
  /** Language the record is written in; the interface language when absent. */
  lang?: Lang
  /** Display name of the provider that recognized the audio, in that language. */
  provider: string
  /** Model or resource that recognized it. */
  model: string
}

export function renderInterviewRecord(result: FileAsrResult, meta: RecordMeta, withHeading: boolean): string {
  const lang = meta.lang ?? uiLang()
  const blocks = groupBySpeaker(result.utterances)
  const speakers = new Set(blocks.map((b) => b.speaker).filter(Boolean))
  const lines: string[] = []
  if (withHeading) lines.push(`# ${meta.title}`, "")
  lines.push(`## ${tr(lang, "note.interview", meta.source)}`, "")
  if (meta.vaultPath) lines.push(`![[${meta.vaultPath}]]`, "")
  const facts = [result.durationMs ? tr(lang, "note.duration", formatClock(result.durationMs, true)) : "", speakers.size ? tr(lang, "note.speakerCount", speakers.size) : "", tr(lang, "note.sentenceCount", result.utterances.length), tr(lang, "note.transcribedAt", meta.transcribedAt)].filter(Boolean)
  lines.push(tr(lang, "note.recordInfo", meta.provider, meta.model), `> ${facts.join(" · ")}`)
  if (speakers.size) lines.push(tr(lang, "note.speakerNote"))
  if (speakers.size && (result.chunks ?? 1) > 1) lines.push(tr(lang, "note.chunkNote", result.chunks!))
  lines.push("")
  if (blocks.length === 0) lines.push(result.text, "")
  for (const block of blocks) {
    const who = speakers.size ? tr(lang, "note.speakerHead", block.speaker ?? "?") : ""
    lines.push(`${who}\`${formatClock(block.startMs, true)}\``, block.text, "")
  }
  return lines.join("\n")
}
