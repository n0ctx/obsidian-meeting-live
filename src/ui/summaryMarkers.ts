import type { Extension, Text } from "@codemirror/state"
import { RangeSetBuilder } from "@codemirror/state"
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view"
import { editorLivePreviewField } from "obsidian"
import { isCardHeading, summaryRegions, type RegionSpan } from "../meeting/noteSummary.ts"
import { panelClasses } from "./summaryPanel.ts"

// Live Preview shows the summary region as the panel it is (a sibling of the meeting card, see the "Summary panel" section of
// styles.css): every line of the region gets classes saying where it sits, the marker lines fold away, and the block ids that
// transcript times link back to are hidden. The heading the plugin wrote above a meeting block folds away too: it is there for
// heading navigation, the card shows the title. Reading view does the same per section (summaryPanel.ts).
// Putting the cursor on a line reveals it as written.

const ANCHOR = / \^m-\d{8}-[a-z0-9]+-[st]\d+[ \t]*$/

/** The regions of a document, found again only when the document itself changed. */
function regionsOf(doc: Text, cache: { doc?: Text; spans: RegionSpan[] }): RegionSpan[] {
  if (cache.doc !== doc) {
    cache.doc = doc
    cache.spans = doc.length > 0 ? summaryRegions(doc.iterLines()) : []
  }
  return cache.spans
}

function build(view: EditorView, cache: { doc?: Text; spans: RegionSpan[] }): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  if (!view.state.field(editorLivePreviewField, false)) return builder.finish()
  const doc = view.state.doc
  const spans = regionsOf(doc, cache)
  const selection = view.state.selection.ranges
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos)
      pos = line.to + 1
      if (line.number < doc.lines && line.text.startsWith("### ") && isCardHeading(line.text, doc.line(line.number + 1).text)) {
        builder.add(line.from, line.from, Decoration.line({ class: "ml-card-heading" }))
        continue
      }
      const n = line.number - 1
      const span = spans.find((s) => n >= s.start && n <= s.end)
      if (!span) continue
      const classes = panelClasses(span, n, line.text.trim() === "")
      builder.add(line.from, line.from, Decoration.line({ class: classes.join(" ") }))
      const revealed = selection.some((r) => r.from <= line.to && r.to >= line.from)
      const anchor = revealed || n === span.start || n === span.end ? null : ANCHOR.exec(line.text)
      if (anchor) builder.add(line.from + anchor.index, line.to, Decoration.replace({}))
    }
  }
  return builder.finish()
}

export const summaryMarkers: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    private cache: { doc?: Text; spans: RegionSpan[] } = { spans: [] }
    constructor(view: EditorView) {
      this.decorations = build(view, this.cache)
    }
    update(update: ViewUpdate): void {
      const modeChanged = update.startState.field(editorLivePreviewField, false) !== update.state.field(editorLivePreviewField, false)
      if (update.docChanged || update.viewportChanged || update.selectionSet || modeChanged) this.decorations = build(update.view, this.cache)
    }
  },
  { decorations: (plugin) => plugin.decorations },
)
