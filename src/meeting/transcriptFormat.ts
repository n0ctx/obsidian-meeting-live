import { formatClock, type MeetingMeta, type TranscriptGap, type Utterance } from "./types.ts"

// "[00:00:08] text ^t8792-24362", or with the time linking back to the note: "[[note#^anchor|00:00:08]] text ^t8792-24362".
const UTTERANCE = String.raw`^(?:\[(\d{2}:\d{2}:\d{2})\]|\[\[[^\]|\n]*\|(\d{2}:\d{2}:\d{2})\]\]) (.*) \^t(\d+)-(\d+)[ \t]*$`
const UTTERANCE_LINE = new RegExp(UTTERANCE)

export function blockId(u: Pick<Utterance, "startMs" | "endMs">): string {
  return `t${Math.round(u.startMs)}-${Math.round(u.endMs)}`
}

export function transcriptHeader(meta: Pick<MeetingMeta, "id" | "notePath" | "createdAt">): string {
  const note = meta.notePath.replace(/\.md$/, "")
  return [
    "---",
    `meeting: ${meta.id}`,
    "type: meeting-transcript",
    `note: "[[${note}]]"`,
    `date: ${meta.createdAt.slice(0, 10)}`,
    "---",
    "",
    "> [!info] 由火山引擎实时语音识别生成的原始转写，按录音时间轴记录。时间点链接回会议笔记中对应的 AI 摘要；转写文字不会被改写。",
    "",
    "",
  ].join("\n")
}

/** One transcript line; with `note`, its time links back to that note (path without extension). */
export function utteranceLine(u: Utterance, note?: string): string {
  const text = u.text.replace(/\s*\n\s*/g, " ").trim()
  const clock = formatClock(u.startMs, true)
  return `${note ? `[[${note}|${clock}]]` : `[${clock}]`} ${text} ^${blockId(u)}\n\n`
}

/** Points the time of every transcript line at `target(startMs)`, a link target such as "note#^anchor". */
export function linkTranscript(markdown: string, target: (startMs: number) => string): string {
  return markdown.replace(new RegExp(UTTERANCE, "gm"), (_line, plain: string | undefined, linked: string | undefined, text: string, start: string, end: string) => `[[${target(Number(start))}|${plain ?? linked}]] ${text} ^t${start}-${end}`)
}

/** Marks where an audio segment starts in the transcript, playable in place. */
export function audioLine(path: string): string {
  return `![[${path}]]\n\n`
}

export function gapLine(gap: TranscriptGap): string {
  return `> [!warning] 转写缺口 ${formatClock(gap.startMs, true)} – ${formatClock(gap.endMs, true)}：${gap.reason}。录音已保存，可回放该时段。\n\n`
}

export function parseTranscript(markdown: string): Utterance[] {
  const seen = new Set<number>()
  const result: Utterance[] = []
  for (const line of markdown.split("\n")) {
    const match = UTTERANCE_LINE.exec(line)
    if (!match) continue
    const startMs = Number(match[4])
    if (seen.has(startMs)) continue
    seen.add(startMs)
    result.push({ startMs, endMs: Number(match[5]), text: match[3] })
  }
  return result.sort((a, b) => a.startMs - b.startMs)
}
