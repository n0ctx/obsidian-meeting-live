import { tr, uiLang, type Lang } from "../i18n/index.ts"
import { hasSpeakers, labelledText } from "../meeting/speakers.ts"
import { formatClock, parseClock, type MeetingMeta, type SummaryContent, type SummaryParagraph, type SummaryPoint, type SummaryRecord, type Utterance } from "../meeting/types.ts"
import type { ChatMessage } from "./client.ts"

export const DEFAULT_SUMMARY_FOCUS = `Focus on the questions discussed, decisions and conclusions, action items, key numbers and dates, and disagreements or uncertainties.`

const SHAPE = `{"title":"","paragraphs":[{"topic":"","text":"","t":"00:00:00"}],"todos":[{"text":"","t":"00:00:00"}],"open":[{"text":"","t":"00:00:00"}]}`

const STAGE_CONTRACT = `You summarize one stage of a meeting from its raw speech-to-text transcript. Each line starts with a [timestamp].

Summarize only the "Current stage" transcript. The overview and previous stage are context: use them to see what this stage continues, but do not restate what they already cover.

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
- Each paragraph is a single sentence of at most 50 Chinese characters or 30 words: the gist of the topic and where it stands now, with at most one key figure. Do not enumerate features, examples or sub-points; the stage summaries keep those. When a later stage revises, decides or answers something, state the latest position.
- "todos": every action item so far, with duplicates merged.
- "open": disagreements and questions still unresolved; drop those settled later and put the answer in the topic's paragraph.
- Use only what the overview and summaries say. Do not invent names, numbers or conclusions.
- Keep plans, forecasts and estimates marked as such, and numbers and units exactly as given.
- "t": copy the [timestamp] where the topic first came up, or of the to-do or question.
- Leave "title" empty.
- Write in the same language as the summaries.

Output one JSON object only, no code fences:
${SHAPE}`

/** One transcript line as the model reads it; a speaker is named in `lang` in front of the text. */
export function transcriptLine(u: Utterance, lang: Lang = uiLang()): string {
  return `[${formatClock(u.startMs, true)}] ${labelledText(u, lang)}`
}

export function transcriptLines(utterances: Utterance[], lang: Lang = uiLang()): string {
  return utterances.map((u) => transcriptLine(u, lang)).join("\n")
}

/** Told to the model whenever lines carry speaker labels, so it neither takes them for names nor trusts them across a reconnect. */
const SPEAKER_CAUTION = "Note: some lines begin with a speaker label. Labels are told apart by voice and are not names; the same number may refer to a different person after a connection was lost and restored."

/** The caution about speaker labels, when any of these utterances has one. */
export const speakerCaution = (utterances: Utterance[]): string | undefined => (hasSpeakers(utterances) ? SPEAKER_CAUTION : undefined)

const stamp = (t: number | undefined) => (t === undefined ? "" : ` [${formatClock(t, true)}]`)

function contentLines(content: SummaryContent): string[] {
  return [
    ...content.paragraphs.map((p) => `${p.topic ? `${p.topic}: ` : ""}${p.text}${stamp(p.t)}`),
    ...content.todos.map((p) => `To-do: ${p.text}${stamp(p.t)}`),
    ...content.open.map((p) => `Open: ${p.text}${stamp(p.t)}`),
  ]
}

/** A summary as timestamped lines, each at the transcript line it cites, so it can stand in for that stretch of the transcript. */
export function summaryUtterances(content: SummaryContent, fallbackMs: number): Utterance[] {
  const at = (t: number | undefined) => t ?? fallbackMs
  return [
    ...content.paragraphs.map((p) => ({ startMs: at(p.t), endMs: at(p.t), text: `${p.topic ? `${p.topic}: ` : ""}${p.text}` })),
    ...content.todos.map((p) => ({ startMs: at(p.t), endMs: at(p.t), text: `To-do: ${p.text}` })),
    ...content.open.map((p) => ({ startMs: at(p.t), endMs: at(p.t), text: `Open: ${p.text}` })),
  ].sort((a, b) => a.startMs - b.startMs)
}

function stageDigest(s: SummaryRecord): string {
  const label = `Stage ${s.index} (${formatClock(s.startMs)}–${formatClock(s.endMs)})${s.content?.title ? ` ${s.content.title}` : ""}`
  if (!s.content) return `${label}:\n${(s.raw ?? "").slice(0, 400)}`
  return [`${label}:`, ...contentLines(s.content)].join("\n")
}

const withFocus = (contract: string, focus: string) => (focus.trim() ? `${contract}\n\nFocus:\n${focus.trim()}` : contract)

export function buildSummaryMessages(title: string, focus: string, window: { startMs: number; endMs: number }, utterances: Utterance[], previous: SummaryRecord[], overview: SummaryContent | undefined, lang: Lang = uiLang()): ChatMessage[] {
  const last = previous.filter((s) => s.status === "done").at(-1)
  const user = [
    `Meeting: ${title}`,
    "",
    "Meeting overview so far (context only):",
    overview ? contentLines(overview).join("\n") : "(none)",
    "",
    "Previous stage (context only):",
    last ? stageDigest(last) : "(none)",
    "",
    `Current stage transcript (${formatClock(window.startMs, true)}–${formatClock(window.endMs, true)}):`,
    ...(hasSpeakers(utterances) ? [SPEAKER_CAUTION] : []),
    transcriptLines(utterances, lang),
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
/**
 * A figure highlighted as one piece: a number with its separators, an optional currency symbol in front and a magnitude after it.
 * Chinese magnitudes (万, 亿, 元) may follow after a space; English ones are the words thousand, million, billion and trillion
 * (a space allowed) and the abbreviations k, K, M, B and bn, which must touch the number and end the word, so "5Mbps" and "3 Mb" are
 * not read as millions. A symbol only counts when it does not follow a digit or point, and the number never starts inside a word.
 */
const FIGURE = /(?:(?<![\d.])[$€£¥￥]\s?)?(?<![A-Za-z\d.])\d+(?:[.,:]\d+)*(?:\s?(?:%|[万亿]*元|[万亿]+|(?:[Tt]housand|[Mm]illion|[Bb]illion|[Tt]rillion)\b)|(?:bn|[kKMB])\b)?/g

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

/** Point text with unverified figures highlighted; every other figure stays plain so emphasis keeps its meaning. */
function pointText(point: SummaryPoint): string {
  return splitFigures(point).map((p) => (p.unverified ? `==${p.text}==` : p.text)).join("")
}

function pointMarkdown(point: SummaryPoint, link: TimeLink): string {
  return `${pointText(point)}${cite(point.t, link)}`
}

/** Whether any point of the content has a figure the transcript does not contain. */
export function hasUnverified(content: SummaryContent | undefined): boolean {
  return !!content && [...content.paragraphs, ...content.todos, ...content.open].some((p) => p.unverified.length > 0)
}

/** Block id to put on a summary line, if any; `first` marks the first line of a stage. */
export type LineAnchor = (point: SummaryPoint | undefined, first: boolean) => string | undefined

const anchored = (line: string, id: string | undefined) => (id ? `${line} ^${id}` : line)

/** To-dos and open questions, each under its own label. */
function listMarkdown(content: SummaryContent, link: TimeLink, mark: (line: string, point: SummaryPoint) => string, lang: Lang): string[] {
  const lines: string[] = []
  if (content.todos.length) lines.push(`**${tr(lang, "note.todo")}**`, ...content.todos.map((p) => mark(`- [ ] ${pointMarkdown(p, link)}`, p)), "")
  if (content.open.length) lines.push(`**${tr(lang, "note.open")}**`, ...content.open.map((p) => mark(`- ${pointMarkdown(p, link)}`, p)), "")
  return lines
}

/** Stage detail: each topic on its own line with its time, the paragraph below it. */
function contentMarkdown(content: SummaryContent, link: TimeLink, lang: Lang, anchor?: LineAnchor): string[] {
  const lines: string[] = []
  let first = true
  const mark = (line: string, point: SummaryPoint) => {
    const id = anchor?.(point, first)
    first = false
    return anchored(line, id)
  }
  for (const p of content.paragraphs) {
    const block = p.topic ? `**${p.topic}**${cite(p.t, link)}\n${pointText(p)}` : pointMarkdown(p, link)
    lines.push(mark(block, p), "")
  }
  lines.push(...listMarkdown(content, link, mark, lang))
  return lines
}

/** A stage as note text, with its fixed labels in `lang`; the model's own wording is kept as it came. */
export function summaryMarkdown(record: SummaryRecord, link: TimeLink, heading = "##", anchor?: LineAnchor, lang: Lang = uiLang()): string {
  const name = record.content?.title || tr(lang, "note.stage", record.index)
  const lines: string[] = [`${heading} ${name}`, ""]
  if (record.content) lines.push(...(isEmptySummary(record.content) ? [anchored(tr(lang, "note.emptyStage"), anchor?.(undefined, true)), ""] : contentMarkdown(record.content, link, lang, anchor)))
  else if (record.raw) lines.push(anchored(record.raw.trimEnd(), anchor?.(undefined, true)), "")
  return lines.join("\n")
}

/** The overview reads as one scannable list: a line per topic, then to-dos and open questions. */
export function overviewMarkdown(content: SummaryContent, throughMs: number, link: TimeLink, heading = "##", lang: Lang = uiLang()): string {
  const topics = content.paragraphs.map((p) => `- ${p.topic ? `**${p.topic}**${tr(lang, "note.topicSep")}` : ""}${pointMarkdown(p, link)}`)
  return [`${heading} ${tr(lang, "note.overview", formatClock(throughMs))}`, "", ...topics, ...(topics.length ? [""] : []), ...listMarkdown(content, link, (line) => line, lang)].join("\n")
}
