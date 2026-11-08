// Stage summaries live in the meeting's own note, in a region right below its `meeting-live` block.
// The region is fenced by Obsidian comments so it can be found and rewritten as stages come in.

export interface TextEdit {
  from: number
  to: number
  text: string
}

const START = "meeting-live-summary"

/**
 * A line holding either marker of a summary region, whatever the text after the id says (notes written before 1.1 carry a hint
 * there, newer ones none); group 1 is "/" for the end marker, group 2 the meeting id.
 * Live Preview and reading view use it to find the region (see summaryRegions) and set it apart from the note.
 */
export const SUMMARY_MARKER_LINE = /^%% (\/?)meeting-live-summary (m-[\w-]+)\b.*%%[ \t]*$/

/**
 * Where a summary region sits in a note, as 0-based line numbers: its start and end markers, and the first and last line
 * with text between them (equal to the markers when the region is empty).
 */
export interface RegionSpan {
  start: number
  end: number
  first: number
  last: number
}

/** The summary regions among a note's lines: each start marker paired with the end marker of the same meeting that follows it. */
export function summaryRegions(lines: Iterable<string>): RegionSpan[] {
  const open = new Map<string, RegionSpan>()
  const spans: RegionSpan[] = []
  let lastText = -1
  let n = 0
  for (const line of lines) {
    const m = line.startsWith("%%") ? SUMMARY_MARKER_LINE.exec(line) : null
    if (m && m[1] === "") open.set(m[2], { start: n, end: n, first: n, last: n })
    else if (m && open.has(m[2])) {
      const span = open.get(m[2])!
      span.end = n
      span.last = Math.max(span.first, lastText)
      spans.push(span)
      open.delete(m[2])
    } else if (line.trim()) {
      for (const span of open.values()) if (span.first === span.start) span.first = n
      lastText = n
    }
    n++
  }
  return spans.sort((a, b) => a.start - b.start)
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Finding the region only looks at the id (see regionPattern): 1.0 wrote a hint after it, in the language of the note. */
function startMarker(id: string): string {
  return `%% ${START} ${id} %%`
}

function endMarker(id: string): string {
  return `%% /${START} ${id} %%`
}

function regionPattern(id: string): RegExp {
  return new RegExp(`^%% ${START} ${escape(id)}\\b[^\\n]*%%[ \\t]*$[\\s\\S]*?^%% /${START} ${escape(id)} %%[ \\t]*$`, "m")
}

function blockPattern(id: string): RegExp {
  return new RegExp(`^(\`{3,}|~{3,})meeting-live[^\\n]*\\n(?:(?!\\1)[^\\n]*\\n)*?\\s*id\\s*:\\s*${escape(id)}\\s*\\n[\\s\\S]*?^\\1[ \\t]*$`, "m")
}

/** The region as written into the note; a blank line after the start marker keeps the comment out of the first paragraph. */
export function summaryRegion(id: string, body: string): string {
  return `${startMarker(id)}\n\n${body.trim()}\n\n${endMarker(id)}`
}

/**
 * A to-do compared across rewrites: its text alone. Left out of the comparison are the ==highlight== around an unverified figure
 * (where it falls depends on which figures the plugin recognizes), the block id and the time link after the text (the id and the
 * line a time lands on depend on where the to-do sits), and what the earliest layout added: bold figures and a leading 【待办】.
 * So a to-do ticked under a stage in an older layout is still ticked where the overview now lists it.
 */
const tickKey = (text: string) =>
  text
    .replace(/\s*\^[\w-]+\s*$/, "")
    .replace(/\s*(?:\[\[[^\]]*\]\]|\d{1,2}:\d{2}(?::\d{2})?)\s*$/, "")
    .replace(/^【[^】]*】\s*/, "")
    .replace(/==|\*\*/g, "")
    .trim()

/** To-dos ticked in the note stay ticked when the region is rewritten, in whatever language either version was written. */
function keepTicks(previous: string, next: string): string {
  const ticked = new Set<string>()
  for (const m of previous.matchAll(/^- \[[xX]\] (.*)$/gm)) ticked.add(tickKey(m[1]))
  if (ticked.size === 0) return next
  return next.replace(/^- \[ \] (.*)$/gm, (line, text: string) => (ticked.has(tickKey(text)) ? `- [x] ${text}` : line))
}

/**
 * The edit that brings the note's summary region up to date: rewritten in place when present,
 * otherwise inserted right after the meeting's block. Undefined when nothing needs to change,
 * when there is nothing to write yet, or when the block is no longer in the note.
 */
export function placeSummary(content: string, id: string, body: string): TextEdit | undefined {
  const existing = regionPattern(id).exec(content)
  if (existing) {
    if (!body.trim()) return undefined
    const text = keepTicks(existing[0], summaryRegion(id, body))
    return text === existing[0] ? undefined : { from: existing.index, to: existing.index + existing[0].length, text }
  }
  if (!body.trim()) return undefined
  const block = blockPattern(id).exec(content)
  if (!block) return undefined
  const at = block.index + block[0].length
  const rest = content.slice(at)
  const tail = rest === "" || /^\n[ \t]*(\n|$)/.test(rest) ? "" : "\n"
  return { from: at, to: at, text: `\n\n${summaryRegion(id, body)}${tail}` }
}

export function applyEdit(content: string, edit: TextEdit): string {
  return content.slice(0, edit.from) + edit.text + content.slice(edit.to)
}
