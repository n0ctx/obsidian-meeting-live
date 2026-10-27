import { formatClock, type SummaryRecord, type Utterance } from "../meeting/types.ts"
import type { ChatMessage } from "./client.ts"
import { summaryMarkdown, transcriptLines } from "./summary.ts"

export const DEFAULT_MINUTES_PROMPT = `You write meeting notes from a raw speech-to-text transcript. Produce clear, accurate notes in Markdown.

- The transcript is the only source of facts. Manual notes and stage summaries are for cross-checking only.
- Do not invent or infer. Keep numbers, units and dates as stated, and keep plans and forecasts marked as such.
- Speech recognition makes mistakes: fix obvious ones from context and list anything uncertain under "Open questions" with its timestamp.
- Organize by topic, not by time. Suggested sections: Summary, Discussion by topic, Key figures, Action items, Open questions. Skip empty sections.
- Write in the same language as the transcript.`

export interface MinutesInput {
  title: string
  date: string
  utterances: Utterance[]
  summaries: SummaryRecord[]
  notes: { path: string; content: string }[]
}

export function buildMinutesMessages(prompt: string, input: MinutesInput): ChatMessage[] {
  const parts = [`Meeting: ${input.title}`, `Date: ${input.date}`, ""]
  for (const note of input.notes) {
    parts.push(`## Manual notes: ${note.path}`, note.content.trim() || "(empty)", "")
  }
  const done = input.summaries.filter((s) => s.status === "done")
  if (done.length) {
    parts.push("## Stage summaries (for cross-checking only)", ...done.map((s) => summaryMarkdown(s, (ms) => formatClock(ms, true))), "")
  }
  parts.push("## Transcript", transcriptLines(input.utterances))
  return [
    { role: "system", content: prompt.trim() || DEFAULT_MINUTES_PROMPT },
    { role: "user", content: parts.join("\n") },
  ]
}

/** Removes the plugin's own code block from a note so it is not fed back as manual notes. */
export function stripMeetingBlocks(markdown: string): string {
  return markdown.replace(/^(`{3,}|~{3,})meeting-live(?:-job)?[^\n]*\n[\s\S]*?^\1\s*$/gm, "").replace(/\n{3,}/g, "\n\n").trim()
}
