// Recorded-file ASR, independent of the provider: the provider interface, the checks and the rendering.
import type { PreparedAudio } from "../audio/transcode.ts"
import { t } from "../i18n/index.ts"
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

export type FileAsrStage = { stage: "uploading" } | { stage: "recognizing"; waitedMs: number }

export interface FileAsrCall {
  speakers: boolean
  post: FileAsrPost
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
  /** Display name of the provider that recognized the audio. */
  provider: string
  /** Model or resource that recognized it. */
  model: string
}

export function renderInterviewRecord(result: FileAsrResult, meta: RecordMeta, withHeading: boolean): string {
  const blocks = groupBySpeaker(result.utterances)
  const speakers = new Set(blocks.map((b) => b.speaker).filter(Boolean))
  const lines: string[] = []
  if (withHeading) lines.push(`# ${meta.title}`, "")
  lines.push(`## 访谈记录 · ${meta.source}`, "")
  if (meta.vaultPath) lines.push(`![[${meta.vaultPath}]]`, "")
  const facts = [result.durationMs ? `时长 ${formatClock(result.durationMs, true)}` : "", speakers.size ? `${speakers.size} 位说话人` : "", `${result.utterances.length} 句`, `转写于 ${meta.transcribedAt}`].filter(Boolean)
  lines.push(`> [!info] ${meta.provider}录音文件识别原始转写（${meta.model}）`, `> ${facts.join(" · ")}`)
  if (speakers.size) lines.push("> 说话人编号由声音自动区分，不代表身份，请按实际人物替换。")
  if (speakers.size && (result.chunks ?? 1) > 1) lines.push(`> 录音较长，分 ${result.chunks} 段分别识别，说话人编号在各段之间不一定对应同一个人。`)
  lines.push("")
  if (blocks.length === 0) lines.push(result.text, "")
  for (const block of blocks) {
    const who = speakers.size ? `**说话人 ${block.speaker ?? "?"}** ` : ""
    lines.push(`${who}\`${formatClock(block.startMs, true)}\``, block.text, "")
  }
  return lines.join("\n")
}
