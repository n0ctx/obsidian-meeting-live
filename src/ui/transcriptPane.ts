import { setIcon } from "obsidian"
import type { MeetingSession } from "../meeting/session.ts"
import { formatClock, type TranscriptGap, type Utterance } from "../meeting/types.ts"

const FOLLOW_THRESHOLD = 48

export class TranscriptPane {
  readonly el: HTMLElement
  private readonly session: MeetingSession
  private readonly scroller: HTMLElement
  private readonly list: HTMLElement
  private readonly interimEl: HTMLElement
  private readonly emptyEl: HTMLElement
  private readonly latestButton: HTMLButtonElement
  private readonly countEl: HTMLElement
  private readonly rows = new Map<number, HTMLElement>()
  private renderedGaps = 0
  private follow = true
  private playingRow: HTMLElement | undefined
  onSeek: ((ms: number) => void) | undefined

  constructor(parent: HTMLElement, session: MeetingSession, actions: HTMLElement) {
    this.session = session
    this.el = parent.createDiv({ cls: "ml-pane ml-pane-transcript" })
    const head = this.el.createDiv({ cls: "ml-pane-head" })
    const title = head.createDiv({ cls: "ml-pane-title" })
    title.createSpan({ text: "实时转写" })
    this.countEl = title.createSpan({ cls: "ml-count" })
    head.appendChild(actions)

    this.scroller = this.el.createDiv({ cls: "ml-scroll" })
    this.emptyEl = this.scroller.createDiv({ cls: "ml-empty" })
    this.list = this.scroller.createDiv({ cls: "ml-lines" })
    this.interimEl = this.scroller.createDiv({ cls: "ml-line is-interim" })
    this.latestButton = this.el.createEl("button", { cls: "ml-latest", text: "回到最新" })
    setIcon(this.latestButton.createSpan({ cls: "ml-latest-icon" }), "arrow-down")

    this.scroller.addEventListener("scroll", () => {
      const s = this.scroller
      this.follow = s.scrollHeight - s.scrollTop - s.clientHeight < FOLLOW_THRESHOLD
      this.latestButton.toggleClass("is-visible", !this.follow)
    })
    this.latestButton.addEventListener("click", () => this.scrollToEnd(true))
    this.list.addEventListener("click", (event) => {
      const ts = (event.target as HTMLElement).closest<HTMLElement>(".ml-ts")
      if (ts?.dataset.ms) this.onSeek?.(Number(ts.dataset.ms))
    })
    this.renderAll()
  }

  renderAll(): void {
    this.list.empty()
    this.rows.clear()
    this.renderedGaps = 0
    const gaps = [...this.session.meta.gaps]
    for (const u of this.session.utterances) {
      while (gaps.length && gaps[0].startMs <= u.startMs) this.renderGap(gaps.shift()!)
      this.list.appendChild(this.row(u))
    }
    for (const gap of gaps) this.renderGap(gap)
    this.renderedGaps = this.session.meta.gaps.length
    this.renderInterim()
    this.updateMeta()
    this.scrollToEnd(false)
  }

  private row(u: Utterance): HTMLElement {
    const row = createDiv({ cls: "ml-line" })
    const ts = row.createEl("button", { cls: "ml-ts", text: formatClock(u.startMs), attr: { "aria-label": `从 ${formatClock(u.startMs)} 播放` } })
    ts.dataset.ms = String(u.startMs)
    row.createDiv({ cls: "ml-text", text: u.text })
    row.dataset.ms = String(u.startMs)
    this.rows.set(Math.round(u.startMs), row)
    return row
  }

  private renderGap(gap: TranscriptGap): void {
    const el = this.list.createDiv({ cls: "ml-gap" })
    setIcon(el.createSpan({ cls: "ml-gap-icon" }), "wifi-off")
    el.createSpan({ cls: "ml-gap-range", text: `${formatClock(gap.startMs)} – ${formatClock(gap.endMs)}` })
    el.createSpan({ cls: "ml-gap-text", text: `${gap.reason} · 录音完整，可回放` })
    el.addEventListener("click", () => this.onSeek?.(gap.startMs))
  }

  append(u: Utterance): void {
    const stick = this.follow
    const row = this.row(u)
    row.addClass("is-new")
    const next = [...this.list.children].find((c) => Number((c as HTMLElement).dataset.ms) > u.startMs)
    if (next) this.list.insertBefore(row, next)
    else this.list.appendChild(row)
    this.updateMeta()
    if (stick) this.scrollToEnd(false)
  }

  gapsChanged(): void {
    if (this.session.meta.gaps.length !== this.renderedGaps) this.renderAll()
  }

  renderInterim(): void {
    const stick = this.follow
    const interims = this.session.interims
    this.interimEl.empty()
    this.interimEl.toggleClass("is-visible", interims.length > 0)
    if (interims.length) {
      this.interimEl.createSpan({ cls: "ml-ts is-live", text: formatClock(interims[0].startMs) })
      const text = this.interimEl.createDiv({ cls: "ml-text" })
      text.createSpan({ text: interims.map((u) => u.text).join("") })
      text.createSpan({ cls: "ml-caret" })
    }
    this.updateMeta()
    if (stick) this.scrollToEnd(false)
  }

  updateMeta(): void {
    const count = this.session.utterances.length
    const chars = this.session.utterances.reduce((n, u) => n + u.text.length, 0)
    this.countEl.setText(count ? `${count} 段 · ${chars.toLocaleString()} 字` : "")
    this.emptyEl.empty()
    const hasContent = count > 0 || this.session.interims.length > 0 || this.session.meta.gaps.length > 0
    this.emptyEl.toggleClass("is-visible", !hasContent)
    if (hasContent) return
    const status = this.session.status
    const asr = this.session.asrState
    setIcon(this.emptyEl.createDiv({ cls: "ml-empty-icon" }), status === "recording" ? "audio-lines" : "captions")
    const message =
      status === "recording"
        ? asr === "live"
          ? "正在聆听，开口后文字会实时出现在这里"
          : asr === "disabled"
            ? "仅录音中：未配置语音识别，录音仍完整保存"
            : "正在连接语音识别…录音已开始"
        : status === "paused"
          ? "已暂停"
          : "开始录音后，实时转写会按时间轴出现在这里"
    this.emptyEl.createDiv({ cls: "ml-empty-text", text: message })
  }

  scrollToEnd(smooth: boolean): void {
    this.scroller.scrollTo({ top: this.scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" })
    this.follow = true
    this.latestButton.removeClass("is-visible")
  }

  /** Scrolls to and flashes the line at a timeline position. */
  reveal(ms: number): void {
    const row = this.rows.get(Math.round(ms)) ?? [...this.rows.entries()].filter(([k]) => k <= ms).pop()?.[1]
    if (!row) return
    this.follow = false
    this.scroller.scrollTo({ top: row.offsetTop - this.scroller.clientHeight / 3, behavior: "smooth" })
    row.removeClass("is-flash")
    void row.offsetWidth
    row.addClass("is-flash")
  }

  /** Highlights the line under the playhead. */
  setPlaying(ms: number | undefined): void {
    let row: HTMLElement | undefined
    let best = -Infinity
    if (ms !== undefined) {
      for (const [start, el] of this.rows) {
        if (start <= ms + 200 && start > best) {
          best = start
          row = el
        }
      }
    }
    if (row === this.playingRow) return
    this.playingRow?.removeClass("is-playing")
    row?.addClass("is-playing")
    this.playingRow = row
  }

  plainText(): string {
    return this.session.utterances.map((u) => `[${formatClock(u.startMs, true)}] ${u.text}`).join("\n")
  }
}
