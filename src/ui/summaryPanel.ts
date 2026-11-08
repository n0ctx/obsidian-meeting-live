import type { MarkdownPostProcessorContext } from "obsidian"
import { summaryRegions, type RegionSpan } from "../meeting/noteSummary.ts"

// The AI summary in a note is plain Markdown between two comment markers. Both views dress it as a panel in the card's own
// look with classes only (the "Summary panel" section of styles.css): a section or line inside a region gets `ml-sum`,
// plus a word for where it sits. Nothing is wrapped around the Markdown, so block ids keep resolving to their own line.

/** Classes of the line `n` (0-based) of a region: the markers fold away, the first and last text line close the panel's top and bottom. */
export function panelClasses(span: RegionSpan, n: number, blank: boolean): string[] {
  if (n === span.start || n === span.end) return ["ml-sum-marker"]
  const classes = ["ml-sum"]
  if (n === span.first) classes.push("ml-sum-first")
  if (n === span.last) classes.push("ml-sum-last")
  if (blank) classes.push("ml-sum-gap")
  return classes
}

let cached: { text: string; spans: RegionSpan[] } | undefined

/** The regions of a note's text; reading view asks once per rendered section, so the last answer is kept. */
function regionsIn(text: string): RegionSpan[] {
  if (cached?.text !== text) cached = { text, spans: text.includes("meeting-live-summary") ? summaryRegions(text.split("\n")) : [] }
  return cached.spans
}

/** Reading view: marks the section `el` when it lies inside a summary region. Embeds and previews give no section info and stay as they are. */
export function markSummarySection(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
  const info = ctx.getSectionInfo(el)
  if (!info) return
  const span = regionsIn(info.text).find((s) => info.lineStart >= s.start && info.lineEnd <= s.end)
  if (!span) return
  if (info.lineEnd <= span.start || info.lineStart >= span.end) {
    el.addClass("ml-sum-marker")
    return
  }
  el.addClass("ml-sum")
  if (info.lineStart <= span.first && info.lineEnd >= span.first) el.addClass("ml-sum-first")
  if (info.lineStart <= span.last && info.lineEnd >= span.last) el.addClass("ml-sum-last")
}
