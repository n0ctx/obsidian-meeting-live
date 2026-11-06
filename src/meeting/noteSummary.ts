// Stage summaries live in the meeting's own note, in a region right below its `meeting-live` block.
// The region is fenced by Obsidian comments so it can be found and rewritten as stages come in.

export interface TextEdit {
  from: number
  to: number
  text: string
}

const START = "meeting-live-summary"

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function startMarker(id: string): string {
  return `%% ${START} ${id} · 由 Meeting Live 自动更新，此区域内的修改会被覆盖 %%`
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

export function summaryRegion(id: string, body: string): string {
  return `${startMarker(id)}\n${body.trim()}\n\n${endMarker(id)}`
}

/** To-dos ticked in the note stay ticked when the region is rewritten. */
function keepTicks(previous: string, next: string): string {
  const ticked = new Set<string>()
  for (const m of previous.matchAll(/^- \[[xX]\] (.*)$/gm)) ticked.add(m[1])
  if (ticked.size === 0) return next
  return next.replace(/^- \[ \] (.*)$/gm, (line, text: string) => (ticked.has(text) ? `- [x] ${text}` : line))
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
