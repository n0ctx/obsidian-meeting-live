import { formatClock, type TranscriptGap, type Utterance } from "./types.ts"

const UTTERANCE_LINE = /^\[(\d{2}:\d{2}:\d{2})\] (.*) \^t(\d+)-(\d+)\s*$/

export function blockId(u: Pick<Utterance, "startMs" | "endMs">): string {
  return `t${Math.round(u.startMs)}-${Math.round(u.endMs)}`
}

export function transcriptHeader(meetingId: string, title: string, notePath: string): string {
  const note = notePath.replace(/\.md$/, "")
  return [
    "---",
    `meeting: ${meetingId}`,
    "type: meeting-transcript",
    `note: "[[${note}]]"`,
    "---",
    "",
    `# 原始转写 · ${title}`,
    "",
    "> [!info] 由火山引擎实时语音识别生成的原始转写，按录音时间轴记录。AI 内容另存于摘要与纪要文件，不会改写本文件。",
    "",
    "",
  ].join("\n")
}

export function utteranceLine(u: Utterance): string {
  const text = u.text.replace(/\s*\n\s*/g, " ").trim()
  return `[${formatClock(u.startMs, true)}] ${text} ^${blockId(u)}\n\n`
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
    const startMs = Number(match[3])
    if (seen.has(startMs)) continue
    seen.add(startMs)
    result.push({ startMs, endMs: Number(match[4]), text: match[2] })
  }
  return result.sort((a, b) => a.startMs - b.startMs)
}
