import { RangeSetBuilder } from "@codemirror/state"
import { Decoration, ViewPlugin, WidgetType, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view"
import { editorLivePreviewField } from "obsidian"

// Live Preview shows Obsidian comments as text; the markers fencing the summary region become a quiet hint instead.
// Reading view already hides them. Putting the cursor on a marker line reveals it as written.

const MARKER = /^%% (\/?)meeting-live-summary m-[\w-]+\b.*%%[ \t]*$/

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
    const el = document.createElement("span")
    el.className = `ml-summary-marker${this.end ? " is-end" : ""}`
    el.textContent = this.end ? "" : "AI 阶段摘要由 Meeting Live 自动更新，此区域内的修改会被覆盖"
    return el
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
      const match = MARKER.exec(line.text)
      if (match && !selection.some((r) => r.from <= line.to && r.to >= line.from)) {
        builder.add(line.from, line.to, Decoration.replace({ widget: new MarkerWidget(match[1] === "/") }))
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
