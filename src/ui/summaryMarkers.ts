import { RangeSetBuilder } from "@codemirror/state"
import { Decoration, ViewPlugin, WidgetType, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view"
import { editorLivePreviewField } from "obsidian"
import { t } from "../i18n/index.ts"
import { SUMMARY_MARKER_LINE } from "../meeting/noteSummary.ts"

// Live Preview shows Obsidian comments as text; the markers fencing the summary region become a quiet hint instead,
// and the block ids that transcript times link back to are hidden. Reading view already hides both.
// Putting the cursor on a line reveals it as written.

const ANCHOR = / \^m-\d{8}-[a-z0-9]+-[st]\d+[ \t]*$/

class MarkerWidget extends WidgetType {
  readonly end: boolean
  constructor(end: boolean) {
    super()
    this.end = end
  }
  override eq(other: MarkerWidget): boolean {
    return other.end === this.end
  }
  toDOM(): HTMLElement {
    return createSpan({ cls: this.end ? ["ml-summary-marker", "is-end"] : "ml-summary-marker", text: this.end ? "" : t("summaryMarker.hint") })
  }
  override ignoreEvent(): boolean {
    return false
  }
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  if (!view.state.field(editorLivePreviewField, false)) return builder.finish()
  const selection = view.state.selection.ranges
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos)
      if (!selection.some((r) => r.from <= line.to && r.to >= line.from)) {
        const marker = SUMMARY_MARKER_LINE.exec(line.text)
        const anchor = marker ? null : ANCHOR.exec(line.text)
        if (marker) builder.add(line.from, line.to, Decoration.replace({ widget: new MarkerWidget(marker[1] === "/") }))
        else if (anchor) builder.add(line.from + anchor.index, line.to, Decoration.replace({}))
      }
      pos = line.to + 1
    }
  }
  return builder.finish()
}

export const summaryMarkers = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = build(view)
    }
    update(update: ViewUpdate): void {
      const modeChanged = update.startState.field(editorLivePreviewField, false) !== update.state.field(editorLivePreviewField, false)
      if (update.docChanged || update.viewportChanged || update.selectionSet || modeChanged) this.decorations = build(update.view)
    }
  },
  { decorations: (plugin) => plugin.decorations },
)
