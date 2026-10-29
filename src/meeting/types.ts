export type MeetingStatus = "idle" | "recording" | "paused" | "stopping" | "ended" | "interrupted"

export type AudioFormat = "ogg" | "wav"

export interface AudioSegment {
  /** Vault path of the audio file. */
  file: string
  format: AudioFormat
  /** Position of the segment on the meeting timeline. */
  startMs: number
  durationMs: number
  startedAt: string
  sampleRate: number
  channels: number
}

export interface TranscriptGap {
  startMs: number
  endMs: number
  reason: string
}

export interface Utterance {
  startMs: number
  endMs: number
  text: string
}

export type SummaryKind = "fact" | "opinion" | "todo" | "open"

export interface SummaryItem {
  kind: SummaryKind
  text: string
  /** Timeline position of the supporting transcript line. */
  t?: number
  /** Numbers in the text that do not appear in the source transcript window. */
  unverified: string[]
}

export interface SummaryContent {
  title: string
  /** Key points in the order they were said. */
  items: SummaryItem[]
}

export type SummaryStatus = "pending" | "running" | "done" | "failed"

export interface SummaryRecord {
  index: number
  startMs: number
  endMs: number
  trigger: "auto" | "manual" | "final"
  status: SummaryStatus
  attempts: number
  /** Start times of the utterances this summary covers. */
  utterances: number[]
  error?: string
  createdAt?: string
  model?: string
  content?: SummaryContent
  /** Model output kept verbatim when it could not be parsed as structured JSON. */
  raw?: string
}

export interface MeetingMeta {
  version: 1
  id: string
  title: string
  notePath: string
  createdAt: string
  updatedAt: string
  status: MeetingStatus
  segments: AudioSegment[]
  gaps: TranscriptGap[]
  summaries: SummaryRecord[]
  /** Timeline position up to which automatic summary windows have been cut. */
  lastCutoffMs: number
  asrLogIds: string[]
  minutes: string[]
}

export function totalDuration(meta: MeetingMeta): number {
  return meta.segments.reduce((sum, s) => sum + s.durationMs, 0)
}

export function formatClock(ms: number, forceHours = false): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, "0")
  const ss = String(s).padStart(2, "0")
  return h > 0 || forceHours ? `${String(h).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`
}

const pad = (n: number) => String(n).padStart(2, "0")

/** Local ISO-8601 timestamp with offset, e.g. 2026-10-27T14:30:00+08:00. */
export function localTimestamp(date = new Date()): string {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? "+" : "-"
  const abs = Math.abs(offset)
  return `${formatDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function formatDateTime(date: Date): string {
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatShortDateTime(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function parseClock(text: string): number | undefined {
  const parts = text.trim().split(":").map((p) => Number(p))
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !Number.isFinite(p) || p < 0)) return undefined
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]]
  return ((h * 60 + m) * 60 + s) * 1000
}
