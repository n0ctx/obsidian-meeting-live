import { formatClock, parseClock, type MeetingMeta, type SummaryContent, type SummaryItem, type SummaryKind, type SummaryRecord, type Utterance } from "../meeting/types.ts"
import type { ChatMessage } from "./client.ts"

export const DEFAULT_SUMMARY_FOCUS = `Focus on the questions discussed, decisions and conclusions, action items, key numbers and dates, and disagreements or uncertainties.`

const CONTRACT = `You summarize one stage of a meeting from its raw speech-to-text transcript. Each line starts with a [timestamp].

Summarize only the "Current stage" transcript. "Previous summaries" are context; do not repeat them.

List the key points in the order they were said. Each point is one short sentence that reads on its own: keep the subject it refers to and its numbers, units, dates and names.

Kinds:
- fact: a fact, figure, event, status or plan that someone reported
- opinion: a judgment, assessment, forecast or conclusion that someone expressed, including decisions reached
- todo: an action someone will take; include the owner and deadline only if stated
- open: a disagreement, or a question that was raised and left unanswered

Rules:
- Use only what the transcript says. Do not invent names, numbers or conclusions, and do not add your own suggestions.
- Keep plans, forecasts and estimates marked as such.
- Keep numbers and units exactly as spoken.
- Merge lines about the same thing into one point. Skip small talk and filler.
- Do not point out likely speech-recognition errors.
- Cite the supporting line for each point in "t", copying its timestamp.
- "title" names what this stage is about in a few words.
- Write in the same language as the transcript.

Output one JSON object only, no code fences:
{"title":"","items":[{"kind":"fact","text":"","t":"00:00:00"}]}`

export function transcriptLines(utterances: Utterance[]): string {
  return utterances.map((u) => `[${formatClock(u.startMs, true)}] ${u.text}`).join("\n")
}

function previousDigest(previous: SummaryRecord[]): string {
  const done = previous.filter((s) => s.status === "done").slice(-3)
  if (done.length === 0) return "(none)"
  return done
    .map((s) => {
      const label = `Stage ${s.index} (${formatClock(s.startMs)}–${formatClock(s.endMs)})`
      if (!s.content) return `${label}: ${(s.raw ?? "").slice(0, 400)}`
      return `${label}${s.content.title ? ` ${s.content.title}` : ""}: ${s.content.items.map((i) => i.text).join("; ")}`
    })
    .join("\n")
}

export function buildSummaryMessages(title: string, focus: string, window: { startMs: number; endMs: number }, utterances: Utterance[], previous: SummaryRecord[]): ChatMessage[] {
  const system = focus.trim() ? `${CONTRACT}\n\nFocus:\n${focus.trim()}` : CONTRACT
  const user = [
    `Meeting: ${title}`,
    "",
    "Previous summaries (context only):",
    previousDigest(previous),
    "",
    `Current stage transcript (${formatClock(window.startMs, true)}–${formatClock(window.endMs, true)}):`,
    transcriptLines(utterances),
  ].join("\n")
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ]
}

const NUMBER = /\d+(?:[.,]\d+)*/g
/** A number with its separators and magnitude, highlighted as one figure. */
const FIGURE = /(?<![A-Za-z\d.])\d+(?:[.,:]\d+)*(?:\s?(?:%|[万亿]*元|[万亿]+))?/g

const numbersIn = (text: string) => (text.match(NUMBER) ?? []).map((n) => n.replace(/,/g, ""))

/** Numbers in the text that do not appear as whole numbers in the source, ignoring spaces and thousands separators. */
export function unverifiedNumbers(text: string, source: string): string[] {
  const haystack = source.replace(/[\s,，]/g, "")
  const missing = numbersIn(text).filter((n) => !new RegExp(`(?<![\\d.])${n.replace(/\./g, "\\.")}(?!\\.?\\d)`).test(haystack))
  return [...new Set(missing)]
}

export interface TextPart {
  text: string
  figure: boolean
  unverified: boolean
}

/** Splits text so figures can be emphasized, flagging those containing an unverified number. */
export function splitFigures(item: SummaryItem): TextPart[] {
  const parts: TextPart[] = []
  let last = 0
  for (const match of item.text.matchAll(FIGURE)) {
    if (match.index > last) parts.push({ text: item.text.slice(last, match.index), figure: false, unverified: false })
    parts.push({ text: match[0], figure: true, unverified: numbersIn(match[0]).some((n) => item.unverified.includes(n)) })
    last = match.index + match[0].length
  }
  if (last < item.text.length) parts.push({ text: item.text.slice(last), figure: false, unverified: false })
  return parts
}

/** Maps a cited time to the closest utterance start in the window, so links land on real lines. */
function snapTime(raw: unknown, utterances: Utterance[]): number | undefined {
  if (typeof raw !== "string" || utterances.length === 0) return undefined
  const t = parseClock(raw)
  if (t === undefined) return undefined
  let best: Utterance | undefined
  for (const u of utterances) {
    if (u.startMs <= t + 999 && (!best || u.startMs > best.startMs)) best = u
  }
  return (best ?? utterances[0]).startMs
}

function extractJson(text: string): unknown {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")
  const start = stripped.indexOf("{")
  const end = stripped.lastIndexOf("}")
  if (start < 0 || end <= start) throw new Error("no JSON object")
  return JSON.parse(stripped.slice(start, end + 1))
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "")

const KINDS: SummaryKind[] = ["fact", "opinion", "todo", "open"]

/** Orders items by cited time; an uncited item stays right after the item before it. */
function chronological(items: SummaryItem[]): SummaryItem[] {
  let last = -Infinity
  return items
    .map((item, i) => ({ item, i, key: (last = item.t ?? last) }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map((x) => x.item)
}

export function parseSummary(text: string, utterances: Utterance[]): SummaryContent | undefined {
  let data: Record<string, unknown>
  try {
    const parsed = extractJson(text)
    if (!parsed || typeof parsed !== "object") return undefined
    data = parsed as Record<string, unknown>
  } catch {
    return undefined
  }
  const source = utterances.map((u) => u.text).join("\n")
  const items: SummaryItem[] = (Array.isArray(data.items) ? (data.items as unknown[]) : [])
    .map((item) => {
      const record = (item && typeof item === "object" ? item : { text: item }) as Record<string, unknown>
      const kind = KINDS.find((k) => k === record.kind) ?? "fact"
      const body = str(record.text)
      return { kind, text: body, t: snapTime(record.t, utterances), unverified: unverifiedNumbers(body, source) }
    })
    .filter((i) => i.text)
  return { title: str(data.title), items: chronological(items) }
}

interface LegacyContent {
  topics?: { text: string; t?: number }[]
  conclusions?: { text: string; t?: number }[]
  figures?: { value: string; context: string; t?: number; verified: boolean }[]
  conflicts?: { text: string; t?: number }[]
}

/** Converts summaries saved in the earlier sectioned layout; its follow-up suggestions are dropped. */
export function upgradeSummaries(meta: MeetingMeta): void {
  for (const record of meta.summaries) {
    const old = record.content as LegacyContent | SummaryContent | undefined
    if (!old || "items" in old) continue
    const items = (kind: SummaryKind, list: { text: string; t?: number }[] = []): SummaryItem[] => list.map((p) => ({ kind, text: p.text, t: p.t, unverified: [] }))
    const figures = (old.figures ?? []).map((f): SummaryItem => ({ kind: "fact", text: `${f.context} ${f.value}`.trim(), t: f.t, unverified: f.verified ? [] : numbersIn(f.value) }))
    record.content = { title: "", items: chronological([...items("fact", old.topics), ...figures, ...items("opinion", old.conclusions), ...items("open", old.conflicts)]) }
  }
}

export function isEmptySummary(content: SummaryContent): boolean {
  return content.items.length === 0
}

export type TimeLink = (ms: number) => string

function cite(t: number | undefined, link: TimeLink): string {
  return t === undefined ? "" : ` ${link(t)}`
}

const MARKDOWN_MARK: Record<SummaryKind, string> = { fact: "- 【事实】", opinion: "- 【观点】", todo: "- [ ] 【待办】", open: "- 【未决】" }

export function summaryMarkdown(record: SummaryRecord, link: TimeLink): string {
  const title = record.content?.title ? ` · ${record.content.title}` : ""
  const lines: string[] = [`## 阶段 ${record.index} · ${formatClock(record.startMs, true)} – ${formatClock(record.endMs, true)}${title}`, ""]
  if (record.content) {
    for (const item of record.content.items) {
      const text = splitFigures(item).map((p) => (p.figure ? `**${p.text}**` : p.text)).join("")
      const warn = item.unverified.length ? `（⚠ 原文未找到 ${item.unverified.join("、")}，请核对）` : ""
      lines.push(`${MARKDOWN_MARK[item.kind]}${text}${warn}${cite(item.t, link)}`)
    }
    lines.push(isEmptySummary(record.content) ? "本阶段没有可提炼的实质内容。" : "", "")
  } else if (record.raw) {
    lines.push(record.raw, "")
  }
  return lines.join("\n")
}
