import { Notice, setIcon } from "obsidian"
import { isEmptySummary, splitFigures, summaryMarkdown } from "../llm/summary.ts"
import type { MeetingSession } from "../meeting/session.ts"
import { formatClock, type SummaryKind, type SummaryRecord } from "../meeting/types.ts"

const TRIGGER_LABEL: Record<SummaryRecord["trigger"], string> = { auto: "", manual: "手动", final: "收尾" }
const KIND_LABEL: Record<SummaryKind, string> = { fact: "事实", opinion: "观点", todo: "待办", open: "未决" }
const KIND_ICON: Record<SummaryKind, string> = { fact: "file-text", opinion: "message-circle", todo: "square-check", open: "circle-help" }

export class SummaryPane {
  readonly el: HTMLElement
  private readonly session: MeetingSession
  private readonly scroller: HTMLElement
  private readonly list: HTMLElement
  private readonly next: HTMLElement
  private readonly countEl: HTMLElement
  private readonly collapsed = new Set<number>()
  private signature = ""
  onLocate: ((ms: number) => void) | undefined

  constructor(parent: HTMLElement, session: MeetingSession, actions: HTMLElement) {
    this.session = session
    this.el = parent.createDiv({ cls: "ml-pane ml-pane-summary" })
    const head = this.el.createDiv({ cls: "ml-pane-head" })
    const title = head.createDiv({ cls: "ml-pane-title" })
    setIcon(title.createSpan({ cls: "ml-pane-icon is-ai" }), "sparkles")
    title.createSpan({ text: "AI 阶段摘要" })
    this.countEl = title.createSpan({ cls: "ml-count" })
    head.appendChild(actions)
    this.scroller = this.el.createDiv({ cls: "ml-scroll" })
    this.list = this.scroller.createDiv({ cls: "ml-stages" })
    this.next = this.scroller.createDiv({ cls: "ml-next" })
    this.render()
  }

  /** Re-renders stage cards only when their data changed; the countdown updates separately. */
  render(): void {
    const summaries = this.session.meta.summaries
    const signature = JSON.stringify(summaries.map((s) => [s.index, s.status, s.attempts, s.error, s.createdAt, this.collapsed.has(s.index)]))
    if (signature !== this.signature) {
      const atEnd = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 48
      const added = summaries.length > (this.signature ? (JSON.parse(this.signature) as unknown[]).length : summaries.length)
      this.signature = signature
      this.list.empty()
      for (const record of summaries) this.renderStage(record)
      const done = summaries.filter((s) => s.status === "done").length
      this.countEl.setText(summaries.length ? `${done} / ${summaries.length} 段` : "")
      if (added && atEnd) this.scroller.scrollTo({ top: this.scroller.scrollHeight, behavior: "smooth" })
    }
    this.renderNext()
  }

  renderNext(): void {
    const s = this.session
    const interval = s.isLive || s.status === "idle" ? s.nextSummaryInMs : NaN
    this.next.empty()
    const problem = s.llmProblem
    const body = this.next.createDiv({ cls: "ml-next-body" })
    const icon = body.createSpan({ cls: "ml-next-icon" })
    const text = body.createDiv({ cls: "ml-next-text" })
    if (problem) {
      setIcon(icon, "sparkles")
      text.createDiv({ cls: "ml-next-title", text: "AI 摘要未启用" })
      text.createDiv({ cls: "ml-next-sub", text: `${problem}。录音与转写不受影响。` })
      this.next.dataset.state = "off"
      return
    }
    if (s.status === "ended" || s.status === "interrupted" || Number.isNaN(interval)) {
      this.next.dataset.state = "done"
      if (s.meta.summaries.length === 0) {
        setIcon(icon, "sparkles")
        text.createDiv({ cls: "ml-next-title", text: s.status === "ended" ? "没有生成阶段摘要" : "暂无阶段摘要" })
        text.createDiv({ cls: "ml-next-sub", text: s.utterances.length ? "可点击「立即总结」生成" : "会议没有转写内容" })
      } else this.next.empty()
      return
    }
    const intervalMs = s.summaryIntervalMs
    const remaining = Math.max(0, interval)
    const progress = 1 - remaining / intervalMs
    this.next.dataset.state = s.status === "recording" ? "collecting" : "waiting"
    setIcon(icon, "clock")
    const stage = s.meta.summaries.length + 1
    text.createDiv({ cls: "ml-next-title", text: `阶段 ${stage} · 正在汇集 ${formatClock(s.meta.lastCutoffMs)} 起的内容` })
    text.createDiv({
      cls: "ml-next-sub",
      text: s.status === "recording" ? (remaining > 0 ? `${formatClock(remaining)} 后自动生成` : "等待最后几句识别确认…") : s.status === "idle" ? `开始后每 ${Math.round(intervalMs / 60000)} 分钟自动生成` : "已暂停，计时同步暂停",
    })
    const bar = this.next.createDiv({ cls: "ml-next-bar" })
    bar.createDiv({ cls: "ml-next-fill" }).style.width = `${Math.max(0, Math.min(100, progress * 100))}%`
  }

  private renderStage(record: SummaryRecord): void {
    const card = this.list.createEl("article", { cls: "ml-stage" })
    card.dataset.status = record.status
    const collapsed = this.collapsed.has(record.index)
    card.toggleClass("is-collapsed", collapsed)
    const head = card.createDiv({ cls: "ml-stage-head" })
    const toggle = head.createEl("button", { cls: "ml-stage-toggle", attr: { "aria-expanded": String(!collapsed), "aria-label": collapsed ? "展开" : "折叠" } })
    setIcon(toggle, "chevron-down")
    toggle.addEventListener("click", () => {
      if (collapsed) this.collapsed.delete(record.index)
      else this.collapsed.add(record.index)
      this.render()
    })
    const name = record.content?.title || `阶段 ${record.index}`
    head.createSpan({ cls: "ml-stage-index", text: name, attr: { title: name } })
    const range = head.createEl("button", { cls: "ml-stage-range", text: `${formatClock(record.startMs)} – ${formatClock(record.endMs)}`, attr: { "aria-label": "定位到该时段" } })
    range.addEventListener("click", () => this.onLocate?.(record.startMs))
    const tag = TRIGGER_LABEL[record.trigger]
    if (tag) head.createSpan({ cls: "ml-tag", text: tag })
    const tools = head.createDiv({ cls: "ml-stage-tools" })
    if (record.status === "done") {
      const copy = tools.createEl("button", { cls: "ml-icon-btn", attr: { "aria-label": "复制本段摘要" } })
      setIcon(copy, "copy")
      copy.addEventListener("click", () => {
        void navigator.clipboard.writeText(summaryMarkdown(record, (ms) => formatClock(ms)))
        new Notice("已复制阶段摘要")
      })
    }

    const body = card.createDiv({ cls: "ml-stage-body" })
    if (record.status === "pending" || record.status === "running") {
      const waiting = record.status === "pending" && record.attempts > 0
      const sk = body.createDiv({ cls: "ml-skeleton" })
      sk.createDiv({ cls: "ml-skeleton-label", text: waiting ? `第 ${record.attempts} 次请求失败，稍后自动重试` : record.status === "running" ? `正在提炼 ${record.utterances.length} 段发言…` : "排队中…" })
      for (const w of [92, 76, 84]) sk.createDiv({ cls: "ml-skeleton-line" }).style.width = `${w}%`
      if (waiting && record.error) sk.createDiv({ cls: "ml-stage-error-text", text: record.error })
      return
    }
    if (record.status === "failed") {
      const fail = body.createDiv({ cls: "ml-stage-error" })
      setIcon(fail.createSpan({ cls: "ml-stage-error-icon" }), "triangle-alert")
      fail.createDiv({ cls: "ml-stage-error-text", text: record.error ?? "生成失败" })
      const retry = fail.createEl("button", { cls: "ml-btn is-small", text: "重试" })
      retry.addEventListener("click", () => this.session.retrySummary(record.index))
      return
    }
    if (!record.content) {
      body.createDiv({ cls: "ml-raw", text: record.raw ?? "" })
      return
    }
    if (isEmptySummary(record.content)) {
      body.createDiv({ cls: "ml-raw is-muted", text: "本阶段没有可提炼的实质内容" })
      return
    }
    const ul = body.createEl("ul", { cls: "ml-points" })
    for (const item of record.content.items) {
      const li = ul.createEl("li", { cls: `ml-point is-${item.kind}` })
      const mark = li.createSpan({ cls: "ml-point-mark", attr: { "aria-label": KIND_LABEL[item.kind] } })
      setIcon(mark, KIND_ICON[item.kind])
      const text = li.createDiv({ cls: "ml-point-text" })
      for (const part of splitFigures(item)) {
        if (part.figure) text.createEl("strong", { cls: part.unverified ? "is-unverified" : "", text: part.text })
        else text.appendText(part.text)
      }
      if (item.unverified.length) {
        const warn = text.createSpan({ cls: "ml-point-warn", attr: { "aria-label": `原文中没有找到 ${item.unverified.join("、")}，请对照转写核实` } })
        setIcon(warn, "circle-alert")
      }
      this.cite(text, item.t)
    }
  }

  private cite(parent: HTMLElement, t: number | undefined): void {
    if (t === undefined) return
    const chip = parent.createEl("button", { cls: "ml-cite", text: formatClock(t), attr: { "aria-label": "定位到原文" } })
    chip.addEventListener("click", () => this.onLocate?.(t))
  }
}
