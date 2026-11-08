import { tr, uiLang, type Lang } from "../i18n/index.ts"
import { gapReason } from "./gap.ts"
import { speakerId } from "./speakers.ts"
import { formatClock, type MeetingMeta, type TranscriptGap, type Utterance } from "./types.ts"

// "[00:00:08] text ^t8792-24362", or with the time linking back to the note: "[[note#^anchor|00:00:08]] text ^t8792-24362".
const UTTERANCE = String.raw`^(?:\[(\d{2}:\d{2}:\d{2})\]|\[\[[^\]|\n]*\|(\d{2}:\d{2}:\d{2})\]\]) (.*) \^t(\d+)-(\d+)[ \t]*$`
const UTTERANCE_LINE = new RegExp(UTTERANCE)

// A speaker is written as a bold id at the start of the text, "[00:00:08] **S2** text ^t8792-24362". The id carries no language,
// and earlier versions, whose pattern takes any text, read the line as plain text with the label in front.
const SPEAKER_PREFIX = /^\*\*S([A-Za-z0-9]{1,8})\*\* (.+)$/

export function blockId(u: Pick<Utterance, "startMs" | "endMs">): string {
  return `t${Math.round(u.startMs)}-${Math.round(u.endMs)}`
}

/** The header of a meeting transcript; `provider` is the recognizer's name, already in `lang`. */
export function transcriptHeader(meta: Pick<MeetingMeta, "id" | "notePath" | "createdAt">, provider: string, lang: Lang = uiLang()): string {
  const note = meta.notePath.replace(/\.md$/, "")
  return [
    "---",
    `meeting: ${meta.id}`,
    "type: meeting-transcript",
    `note: "[[${note}]]"`,
    `date: ${meta.createdAt.slice(0, 10)}`,
    "---",
    "",
    tr(lang, "note.transcriptHeader", provider),
    "",
    "",
  ].join("\n")
}

/** One transcript line; with `note`, its time links back to that note (path without extension). */
export function utteranceLine(u: Utterance, note?: string): string {
  const text = u.text.replace(/\s*\n\s*/g, " ").trim()
  const speaker = speakerId(u.speaker)
  const clock = formatClock(u.startMs, true)
  return `${note ? `[[${note}|${clock}]]` : `[${clock}]`} ${speaker ? `**S${speaker}** ` : ""}${text} ^${blockId(u)}\n\n`
}

/** Points the time of every transcript line at `target(startMs)`, a link target such as "note#^anchor". */
export function linkTranscript(markdown: string, target: (startMs: number) => string): string {
  return markdown.replace(new RegExp(UTTERANCE, "gm"), (_line, plain: string | undefined, linked: string | undefined, text: string, start: string, end: string) => `[[${target(Number(start))}|${plain ?? linked}]] ${text} ^t${start}-${end}`)
}

/** Marks where an audio segment starts in the transcript, playable in place. */
export function audioLine(path: string): string {
  return `![[${path}]]\n\n`
}

export function gapLine(gap: TranscriptGap, lang: Lang = uiLang()): string {
  return `${tr(lang, "note.gapLine", formatClock(gap.startMs, true), formatClock(gap.endMs, true), gapReason(gap, lang))}\n\n`
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
    const labelled = SPEAKER_PREFIX.exec(match[3])
    result.push(labelled ? { startMs, endMs: Number(match[5]), text: labelled[2], speaker: labelled[1] } : { startMs, endMs: Number(match[5]), text: match[3] })
  }
  return result.sort((a, b) => a.startMs - b.startMs)
}
