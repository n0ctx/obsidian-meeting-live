import { formatClock, parseClock, type SummaryContent, type SummaryFigure, type SummaryPoint, type SummaryRecord, type Utterance } from "../meeting/types.ts"
import type { ChatMessage } from "./client.ts"

export const DEFAULT_SUMMARY_FOCUS = `Focus on the questions discussed, decisions and conclusions, key numbers and dates, disagreements or uncertainties, and useful follow-up questions.`

const CONTRACT = `You summarize one stage of a meeting from its raw speech-to-text transcript. Each line starts with a [timestamp].

Summarize only the "Current stage" transcript. "Previous summaries" are context; do not repeat them.

Rules:
- Use only what the transcript says. Do not invent names, numbers or conclusions.
- Keep plans, forecasts and estimates marked as such.
- Keep numbers and units exactly as spoken.
- Cite the supporting line for each item in "t", copying its timestamp.
- Leave a field as an empty array when nothing fits. One short sentence per item.
- Write in the same language as the transcript.

Fields: topics (questions discussed), conclusions (decisions and stated views), figures (value + what it refers to), conflicts (disagreements, contradictions, uncertain or possibly misrecognized items), followups (questions worth asking next).

Output one JSON object only, no code fences:
{"topics":[{"text":"","t":"00:00:00"}],"conclusions":[{"text":"","t":""}],"figures":[{"value":"","context":"","t":""}],"conflicts":[{"text":"","t":""}],"followups":[{"text":"","t":""}]}`

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
      const join = (items: SummaryPoint[]) => items.map((i) => i.text).join("; ")
      return `${label}: topics: ${join(s.content.topics)}; conclusions: ${join(s.content.conclusions)}`
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

function normalizeForMatch(text: string): string {
  return text.replace(/[\s,，、]/g, "").toLowerCase()
}

/** A figure counts as verified when its value, or every number in it, appears in the source text. */
export function verifyFigure(value: string, source: string): boolean {
  const haystack = normalizeForMatch(source)
  const needle = normalizeForMatch(value)
  if (!needle) return false
  if (haystack.includes(needle)) return true
  const numbers = needle.match(/\d+(?:\.\d+)?/g)
  return !!numbers && numbers.every((n) => haystack.includes(n))
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
  const points = (key: string): SummaryPoint[] =>
    (Array.isArray(data[key]) ? (data[key] as unknown[]) : [])
      .map((item) => {
        const record = (item && typeof item === "object" ? item : { text: item }) as Record<string, unknown>
        return { text: str(record.text), t: snapTime(record.t, utterances) }
      })
      .filter((p) => p.text)
  const figures: SummaryFigure[] = (Array.isArray(data.figures) ? (data.figures as unknown[]) : [])
    .map((item) => {
      const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>
      const value = str(record.value)
      return { value, context: str(record.context), t: snapTime(record.t, utterances), verified: verifyFigure(value, source) }
    })
    .filter((f) => f.value)
  const content: SummaryContent = {
    topics: points("topics"),
    conclusions: points("conclusions"),
    figures,
    conflicts: points("conflicts"),
    followups: points("followups"),
  }
  return content
}

export function isEmptySummary(content: SummaryContent): boolean {
  return Object.values(content).every((list: unknown[]) => list.length === 0)
}

export type TimeLink = (ms: number) => string

function cite(t: number | undefined, link: TimeLink): string {
  return t === undefined ? "" : ` ${link(t)}`
}

export function summaryMarkdown(record: SummaryRecord, link: TimeLink): string {
  const lines: string[] = [`## 阶段 ${record.index} · ${formatClock(record.startMs, true)} – ${formatClock(record.endMs, true)}`, ""]
  if (record.content) {
    const section = (title: string, items: SummaryPoint[]) => {
      if (items.length === 0) return
      lines.push(`**${title}**`, ...items.map((i) => `- ${i.text}${cite(i.t, link)}`), "")
    }
    section("主要议题", record.content.topics)
    section("核心观点与结论", record.content.conclusions)
    if (record.content.figures.length) {
      lines.push(
        "**关键数据**",
        ...record.content.figures.map((f) => `- **${f.value}** ${f.context}${f.verified ? "" : "（⚠ 原文未找到该数值，请核对）"}${cite(f.t, link)}`),
        "",
      )
    }
    section("分歧与待核实", record.content.conflicts)
    section("待追问", record.content.followups)
    if (isEmptySummary(record.content)) lines.push("本阶段没有可提炼的实质内容。", "")
  } else if (record.raw) {
    lines.push(record.raw, "")
  }
  return lines.join("\n")
}
