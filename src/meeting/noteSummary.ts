import { tr, uiLang, type Lang } from "../i18n/index.ts"

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

/** The wording after the id may be in any language: finding the region only looks at the id (see regionPattern). */
function startMarker(id: string, lang: Lang): string {
  return `%% ${START} ${id} · ${tr(lang, "note.regionMarker")} %%`
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

export function summaryRegion(id: string, body: string, lang: Lang = uiLang()): string {
  return `${startMarker(id, lang)}\n${body.trim()}\n\n${endMarker(id)}`
}

/**
 * A to-do compared across rewrites. The ==highlight== around an unverified figure is left out of the comparison: where it
 * falls depends on which figures the plugin recognizes, so a to-do ticked under an older wording must still match.
 */
const tickKey = (text: string) => text.replace(/==/g, "")

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
export function placeSummary(content: string, id: string, body: string, lang: Lang = uiLang()): TextEdit | undefined {
  const existing = regionPattern(id).exec(content)
  if (existing) {
    if (!body.trim()) return undefined
    const text = keepTicks(existing[0], summaryRegion(id, body, lang))
    return text === existing[0] ? undefined : { from: existing.index, to: existing.index + existing[0].length, text }
  }
  if (!body.trim()) return undefined
  const block = blockPattern(id).exec(content)
  if (!block) return undefined
  const at = block.index + block[0].length
  const rest = content.slice(at)
  const tail = rest === "" || /^\n[ \t]*(\n|$)/.test(rest) ? "" : "\n"
  return { from: at, to: at, text: `\n\n${summaryRegion(id, body, lang)}${tail}` }
}

export function applyEdit(content: string, edit: TextEdit): string {
  return content.slice(0, edit.from) + edit.text + content.slice(edit.to)
}
