import { formatClock, parseClock, type MeetingMeta, type SummaryContent, type SummaryParagraph, type SummaryPoint, type SummaryRecord, type Utterance } from "../meeting/types.ts"
import type { ChatMessage } from "./client.ts"

export const DEFAULT_SUMMARY_FOCUS = `Focus on the questions discussed, decisions and conclusions, action items, key numbers and dates, and disagreements or uncertainties.`

const SHAPE = `{"title":"","paragraphs":[{"topic":"","text":"","t":"00:00:00"}],"todos":[{"text":"","t":"00:00:00"}],"open":[{"text":"","t":"00:00:00"}]}`

const STAGE_CONTRACT = `You summarize one stage of a meeting from its raw speech-to-text transcript. Each line starts with a [timestamp].

Summarize only the "Current stage" transcript. The overview and previous stages are context: use them to see what this stage continues, but do not restate what they already cover.

Write one paragraph per topic, in the order discussed; usually one to three. A paragraph explains what was discussed and how it fits together: the situation and figures reported, the judgments, forecasts and reasons given, and any decision or conclusion reached. Write connected prose, not a string of fragments. Make clear by wording which parts were reported as fact and which are someone's judgment, forecast or decision. Keep each paragraph under about 150 Chinese characters or 100 words; if a topic needs more, split it into sub-topics.

Then list separately:
- todos: actions someone will take; include the owner and deadline only if stated
- open: disagreements, and questions raised and left unanswered

Rules:
- Use only what the transcript says. Do not invent names, numbers or conclusions, and do not add your own suggestions.
- Keep plans, forecasts and estimates marked as such.
- Keep numbers and units exactly as spoken.
- Skip small talk and filler.
- Do not point out likely speech-recognition errors.
- "t": copy the timestamp of the line where the paragraph's topic starts, or of the line supporting the to-do or question.
- "topic" names the paragraph's subject in a few words; "title" names what this stage is about.
- Leave a list empty when nothing applies.
- Write in the same language as the transcript.

Output one JSON object only, no code fences:
${SHAPE}`

const OVERVIEW_CONTRACT = `You keep a running overview of a meeting in progress. You get the current overview and the summaries of new stages; return the updated overview of the whole meeting so far.

- Organize by topic, not by time. Fold each new point into the topic it belongs to, or add a topic. Merge topics that turn out to be the same.
- Each paragraph covers one topic: what was discussed, the key figures, the judgments and who holds them, and where it stands now. When a later stage revises, decides or answers something, state the latest position.
- The overview is for seeing the whole meeting at a glance: keep each paragraph under about 150 Chinese characters or 100 words, and leave out details that do not matter for the whole picture.
- "todos": every action item so far, with duplicates merged.
- "open": disagreements and questions still unresolved; drop those settled later and put the answer in the topic's paragraph.
- Use only what the overview and summaries say. Do not invent names, numbers or conclusions.
- Keep plans, forecasts and estimates marked as such, and numbers and units exactly as given.
- "t": copy the [timestamp] where the topic first came up, or of the to-do or question.
- Leave "title" empty.
- Write in the same language as the summaries.

Output one JSON object only, no code fences:
${SHAPE}`

export function transcriptLines(utterances: Utterance[]): string {
  return utterances.map((u) => `[${formatClock(u.startMs, true)}] ${u.text}`).join("\n")
}

const stamp = (t: number | undefined) => (t === undefined ? "" : ` [${formatClock(t, true)}]`)

function contentLines(content: SummaryContent): string[] {
  return [
    ...content.paragraphs.map((p) => `${p.topic ? `${p.topic}: ` : ""}${p.text}${stamp(p.t)}`),
    ...content.todos.map((p) => `To-do: ${p.text}${stamp(p.t)}`),
    ...content.open.map((p) => `Open: ${p.text}${stamp(p.t)}`),
  ]
}

function stageDigest(s: SummaryRecord): string {
  const label = `Stage ${s.index} (${formatClock(s.startMs)}–${formatClock(s.endMs)})${s.content?.title ? ` ${s.content.title}` : ""}`
  if (!s.content) return `${label}:\n${(s.raw ?? "").slice(0, 400)}`
  return [`${label}:`, ...contentLines(s.content)].join("\n")
}

const withFocus = (contract: string, focus: string) => (focus.trim() ? `${contract}\n\nFocus:\n${focus.trim()}` : contract)

export function buildSummaryMessages(title: string, focus: string, window: { startMs: number; endMs: number }, utterances: Utterance[], previous: SummaryRecord[], overview: SummaryContent | undefined): ChatMessage[] {
  const done = previous.filter((s) => s.status === "done").slice(-2)
  const user = [
    `Meeting: ${title}`,
    "",
    "Meeting overview so far (context only):",
    overview ? contentLines(overview).join("\n") : "(none)",
    "",
    "Previous stages (context only):",
    done.length ? done.map(stageDigest).join("\n\n") : "(none)",
    "",
    `Current stage transcript (${formatClock(window.startMs, true)}–${formatClock(window.endMs, true)}):`,
    transcriptLines(utterances),
  ].join("\n")
  return [
    { role: "system", content: withFocus(STAGE_CONTRACT, focus) },
    { role: "user", content: user },
  ]
}

export function buildOverviewMessages(title: string, focus: string, overview: SummaryContent | undefined, stages: SummaryRecord[]): ChatMessage[] {
  const user = [
    `Meeting: ${title}`,
    "",
    "Current overview:",
    overview ? contentLines(overview).join("\n") : "(none)",
    "",
    "New stage summaries:",
    stages.map(stageDigest).join("\n\n"),
  ].join("\n")
  return [
    { role: "system", content: withFocus(OVERVIEW_CONTRACT, focus) },
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
export function splitFigures(item: SummaryPoint): TextPart[] {
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

const records = (v: unknown) => (Array.isArray(v) ? (v as unknown[]) : []).map((x) => (x && typeof x === "object" ? x : { text: x }) as Record<string, unknown>)

/** Parses a stage summary or overview; citations snap to the given utterances and numbers are checked against them. */
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
  const point = (record: Record<string, unknown>): SummaryPoint => {
    const body = str(record.text)
    return { text: body, t: snapTime(record.t, utterances), unverified: unverifiedNumbers(body, source) }
  }
  const points = (v: unknown) => records(v).map(point).filter((p) => p.text)
  const paragraphs = records(data.paragraphs)
    .map((r): SummaryParagraph => ({ topic: str(r.topic), ...point(r) }))
    .filter((p) => p.text)
  return { title: str(data.title), paragraphs, todos: points(data.todos), open: points(data.open) }
}

type LegacyKind = "fact" | "opinion" | "todo" | "open"
type LegacyItem = SummaryPoint & { kind: LegacyKind }

interface LegacySections {
  topics?: { text: string; t?: number }[]
  conclusions?: { text: string; t?: number }[]
  figures?: { value: string; context: string; t?: number; verified: boolean }[]
  conflicts?: { text: string; t?: number }[]
}

/** Orders items by cited time; an uncited item stays right after the item before it. */
function chronological(items: LegacyItem[]): LegacyItem[] {
  let last = -Infinity
  return items
    .map((item, i) => ({ item, i, key: (last = item.t ?? last) }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map((x) => x.item)
}

function sectionItems(old: LegacySections): LegacyItem[] {
  const items = (kind: LegacyKind, list: { text: string; t?: number }[] = []): LegacyItem[] => list.map((p) => ({ kind, text: p.text, t: p.t, unverified: [] }))
  const figures = (old.figures ?? []).map((f): LegacyItem => ({ kind: "fact", text: `${f.context} ${f.value}`.trim(), t: f.t, unverified: f.verified ? [] : numbersIn(f.value) }))
  return chronological([...items("fact", old.topics), ...figures, ...items("opinion", old.conclusions), ...items("open", old.conflicts)])
}

/**
 * Converts summaries saved as marked points or in the earlier sectioned layout: each fact or opinion
 * becomes its own paragraph so its citation survives. Follow-up suggestions of the sectioned layout are dropped.
 */
export function upgradeSummaries(meta: MeetingMeta): void {
  for (const record of meta.summaries) {
    const old = record.content as LegacySections | { title: string; items: LegacyItem[] } | SummaryContent | undefined
    if (!old || "paragraphs" in old) continue
    const items = "items" in old ? old.items : sectionItems(old)
    const pick = (...kinds: LegacyKind[]) => items.filter((i) => kinds.includes(i.kind)).map(({ text, t, unverified }) => ({ text, t, unverified }))
    record.content = {
      title: "title" in old ? old.title : "",
      paragraphs: pick("fact", "opinion").map((p) => ({ topic: "", ...p })),
      todos: pick("todo"),
      open: pick("open"),
    }
  }
}

export function isEmptySummary(content: SummaryContent): boolean {
  return content.paragraphs.length + content.todos.length + content.open.length === 0
}

export type TimeLink = (ms: number) => string

function cite(t: number | undefined, link: TimeLink): string {
  return t === undefined ? "" : ` ${link(t)}`
}

function pointMarkdown(point: SummaryPoint, link: TimeLink): string {
  const text = splitFigures(point).map((p) => (p.figure ? `**${p.text}**` : p.text)).join("")
  const warn = point.unverified.length ? `（⚠ 原文未找到 ${point.unverified.join("、")}，请核对）` : ""
  return `${text}${warn}${cite(point.t, link)}`
}

function contentMarkdown(content: SummaryContent, link: TimeLink): string[] {
  const lines: string[] = []
  for (const p of content.paragraphs) lines.push(`${p.topic ? `**${p.topic}**：` : ""}${pointMarkdown(p, link)}`, "")
  const lists = [...content.todos.map((p) => `- [ ] 【待办】${pointMarkdown(p, link)}`), ...content.open.map((p) => `- 【未决】${pointMarkdown(p, link)}`)]
  if (lists.length) lines.push(...lists, "")
  return lines
}

export function summaryMarkdown(record: SummaryRecord, link: TimeLink): string {
  const title = record.content?.title ? ` · ${record.content.title}` : ""
  const lines: string[] = [`## 阶段 ${record.index} · ${formatClock(record.startMs, true)} – ${formatClock(record.endMs, true)}${title}`, ""]
  if (record.content) lines.push(...(isEmptySummary(record.content) ? ["本阶段没有可提炼的实质内容。", ""] : contentMarkdown(record.content, link)))
  else if (record.raw) lines.push(record.raw, "")
  return lines.join("\n")
}

export function overviewMarkdown(content: SummaryContent, throughMs: number, link: TimeLink): string {
  return [`## 会议概览 · 截至 ${formatClock(throughMs, true)}`, "", ...contentMarkdown(content, link)].join("\n")
}
