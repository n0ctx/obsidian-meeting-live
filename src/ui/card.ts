import { MarkdownRenderChild, Menu, Notice, TFile, setIcon, type App, type EventRef, type Events, type MarkdownPostProcessorContext } from "obsidian"
import { t, type Key } from "../i18n/index.ts"
import type { LlmClient } from "../llm/client.ts"
import type { MeetingManager } from "../meeting/manager.ts"
import type { MeetingSession } from "../meeting/session.ts"
import { formatClock, formatShortDateTime, type MeetingStatus, type Utterance } from "../meeting/types.ts"
import { platformText } from "../platform.ts"
import type { MeetingLiveSettings } from "../settings.ts"
import { TimelinePlayer } from "./player.ts"
import { TranscriptPane } from "./transcriptPane.ts"
import { Waveform } from "./waveform.ts"

export interface CardHost {
  app: App
  manager: MeetingManager
  settings: MeetingLiveSettings
  /** The live recognizer under the current settings: its display name and why it cannot be used, if it cannot. */
  asr(): { name: string; problem?: string }
  llm(): LlmClient
  ensureConsent(): Promise<boolean>
  openMinutes(session: MeetingSession): void
  openSettings(): void
  openPath(path: string): void
  revealFolder(session: MeetingSession): void
  saveSettings(): Promise<void>
}

const STATUS_LABEL = {
  idle: "card.status.idle",
  recording: "card.status.recording",
  paused: "card.status.paused",
  stopping: "card.status.stopping",
  ended: "card.status.ended",
  interrupted: "card.status.interrupted",
} as const satisfies Record<MeetingStatus, Key>

const ASR_LABEL: Record<string, [Key, string]> = {
  live: ["card.asr.live", "ok"],
  connecting: ["card.asr.connecting", "busy"],
  reconnecting: ["card.asr.reconnecting", "warn"],
  failed: ["card.asr.failed", "error"],
  disabled: ["card.asr.disabled", "off"],
  idle: ["card.asr.idle", "idle"],
}

/** Events that must not reach the editor, so interacting with the card never moves the cursor into the block. */
const ISOLATED_EVENTS = ["mousedown", "pointerdown", "keydown", "keyup", "keypress", "beforeinput", "input", "paste", "cut", "dragstart", "drop"]

export function parseBlockId(source: string): string | undefined {
  return /^\s*id\s*:\s*(m-[\w-]+)\s*$/m.exec(source)?.[1]
}

export class MeetingCard extends MarkdownRenderChild {
  private readonly host: CardHost
  private readonly id: string | undefined
  private readonly ctx: MarkdownPostProcessorContext
  private session: MeetingSession | undefined
  private refs: [Events, EventRef][] = []
  private root!: HTMLElement
  private statusEl!: HTMLElement
  private statusText!: HTMLElement
  private metaText!: HTMLElement
  private metaEl!: HTMLElement
  private statusLine!: HTMLElement
  private statusItems!: HTMLElement
  private titleInput!: HTMLInputElement
  private titleWrap!: HTMLElement
  private clockEl!: HTMLElement
  private controls!: HTMLElement
  private chips!: HTMLElement
  private alertEl!: HTMLElement
  private captionEl!: HTMLElement
  private body!: HTMLElement
  private footRow!: HTMLElement
  private waveform: Waveform | undefined
  private transcript: TranscriptPane | undefined
  private player: TimelinePlayer | undefined
  private bodyMode: "hero" | "transcript" | undefined
  private busy = false
  private controlsKey = ""

  constructor(containerEl: HTMLElement, host: CardHost, id: string | undefined, ctx: MarkdownPostProcessorContext) {
    super(containerEl)
    this.host = host
    this.id = id
    this.ctx = ctx
  }

  override onload(): void {
    void this.mount()
  }

  private async mount(): Promise<void> {
    const el = this.containerEl
    el.addClass("ml-host")
    for (const type of ISOLATED_EVENTS) el.addEventListener(type, (e) => e.stopPropagation())
    const placeholder = el.createDiv({ cls: "ml-card is-loading" })
    placeholder.createDiv({ cls: "ml-loading-bar" })
    const session = this.id ? await this.host.manager.get(this.id) : undefined
    placeholder.remove()
    if (!session) {
      this.renderMissing()
      return
    }
    this.session = session
    this.build()
    const on = (name: string, fn: (...args: unknown[]) => void) => this.refs.push([session, session.on(name, fn)])
    on("change", () => this.update())
    on("utterance", (u) => {
      this.transcript?.append(u as Utterance)
      this.renderCaption()
    })
    on("interim", () => {
      this.transcript?.renderInterim()
      this.renderCaption()
    })
    on("gap", () => {
      this.transcript?.gapsChanged()
      this.player?.refresh()
    })
    on("summary", () => {
      this.renderAlert()
      this.renderChips()
      this.player?.refresh()
    })
    this.refs.push([this.host.manager, this.host.manager.on("active", () => this.update())])
    this.registerInterval(window.setInterval(() => this.tick(), 500))
    // Meetings summarized before summaries moved into the note get their section written once.
    if (session.meta.summaries.some((s) => s.status === "done")) void session.publishSummary()
  }

  override onunload(): void {
    for (const [source, ref] of this.refs) source.offref(ref)
    this.refs = []
    this.waveform?.stop()
    this.player?.destroy()
  }

  // ---------------------------------------------------------------- structure

  private renderMissing(): void {
    const card = this.containerEl.createDiv({ cls: "ml-card is-missing" })
    const box = card.createDiv({ cls: "ml-missing" })
    setIcon(box.createDiv({ cls: "ml-missing-icon" }), "audio-lines")
    const text = box.createDiv({ cls: "ml-missing-text" })
    if (this.id) {
      text.createDiv({ cls: "ml-missing-title", text: t("card.missing.title") })
      text.createDiv({ cls: "ml-missing-sub", text: t("card.missing.sub", this.id, this.host.settings.folder) })
      const retry = box.createEl("button", { cls: "ml-btn", text: t("card.missing.rescan") })
      retry.addEventListener("click", () => void this.rescan())
    } else {
      text.createDiv({ cls: "ml-missing-title", text: t("card.unlinked.title") })
      text.createDiv({ cls: "ml-missing-sub", text: t("card.unlinked.sub") })
      const create = box.createEl("button", { cls: "ml-btn is-primary", text: t("card.unlinked.create") })
      create.addEventListener("click", () => void this.createAndLink())
    }
  }

  private async rescan(): Promise<void> {
    await this.host.manager.reindex()
    if (await this.host.manager.get(this.id!)) this.rerender()
    else new Notice(t("card.missing.stillNot"))
  }

  private async createAndLink(): Promise<void> {
    const file = this.host.app.vault.getAbstractFileByPath(this.ctx.sourcePath)
    const info = this.ctx.getSectionInfo(this.containerEl)
    if (!(file instanceof TFile) || !info) {
      new Notice(t("card.unlinked.noBlock"))
      return
    }
    const session = await this.host.manager.create(file.basename, file.path)
    await this.host.app.vault.process(file, (data) => {
      const lines = data.split("\n")
      const fence = lines[info.lineStart].match(/^\s*(`{3,}|~{3,})/)?.[1] ?? "```"
      lines.splice(info.lineStart, info.lineEnd - info.lineStart + 1, `${fence}meeting-live`, `id: ${session.id}`, fence)
      return lines.join("\n")
    })
  }

  private rerender(): void {
    this.onunload()
    this.containerEl.empty()
    this.onload()
  }

  private build(): void {
    const session = this.session!
    this.root = this.containerEl.createDiv({ cls: "ml-card" })
    // A click anywhere on the capsule that is not a control or the title expands it.
    this.root.addEventListener("click", (e) => {
      if (session.meta.collapsed && !(e.target as HTMLElement).closest("button, input")) session.setCollapsed(false)
    })

    const head = this.root.createDiv({ cls: "ml-head" })
    const main = head.createDiv({ cls: "ml-head-main" })
    // The wrapper mirrors the value in a hidden copy so the input is exactly as wide as its text.
    this.titleWrap = main.createSpan({ cls: "ml-title-wrap" })
    this.titleInput = this.titleWrap.createEl("input", { cls: "ml-title", attr: { type: "text", size: "1", spellcheck: "false", "aria-label": t("card.titleLabel") } })
    this.setTitle(session.meta.title)
    this.titleInput.addEventListener("input", () => (this.titleWrap.dataset.value = this.titleInput.value))
    this.titleInput.addEventListener("change", () => session.rename(this.titleInput.value))
    this.titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.titleInput.blur()
      if (e.key === "Escape") {
        this.setTitle(session.meta.title)
        this.titleInput.blur()
      }
    })
    this.metaEl = main.createDiv({ cls: "ml-meta" })
    this.statusEl = this.metaEl.createSpan({ cls: "ml-status" })
    this.statusEl.createSpan({ cls: "ml-dot" })
    this.statusText = this.statusEl.createSpan()
    // Chips live in the status line of the expanded card and move up into the header row of the capsule.
    this.chips = createSpan({ cls: "ml-chips" })

    const side = head.createDiv({ cls: "ml-head-side" })
    const meter = side.createDiv({ cls: "ml-meter" })
    this.clockEl = meter.createDiv({ cls: "ml-clock" })
    this.waveform = new Waveform(meter, session)
    this.controls = side.createDiv({ cls: "ml-controls" })

    this.alertEl = this.root.createDiv({ cls: "ml-alert" })
    this.body = this.root.createDiv({ cls: "ml-body" })

    // Hangs below the capsule, outside the card, so the pill keeps its shape.
    this.captionEl = this.containerEl.createDiv({ cls: "ml-caption", attr: { "aria-live": "polite" } })
    const foot = this.root.createDiv({ cls: "ml-foot" })
    this.player = new TimelinePlayer(foot, session)
    this.player.onPosition = (ms, playing) => this.transcript?.setPlaying(playing ? ms : undefined)
    this.footRow = foot.createDiv({ cls: "ml-foot-row" })
    this.statusLine = this.root.createDiv({ cls: "ml-statusline" })
    this.statusItems = this.statusLine.createDiv({ cls: "ml-statusline-items" })
    this.metaText = this.statusLine.createSpan({ cls: "ml-meta-text" })
    this.update()
  }

  private setTitle(title: string): void {
    this.titleInput.value = title
    this.titleWrap.dataset.value = title
  }

  private buildBody(mode: "hero" | "transcript"): void {
    this.bodyMode = mode
    this.body.empty()
    this.transcript = undefined
    this.root.toggleClass("is-hero", mode === "hero")
    if (mode === "hero") return this.buildHero()
    const session = this.session!
    const actions = createDiv({ cls: "ml-pane-actions" })
    this.iconButton(actions, "copy", t("card.copyAll"), () => {
      void navigator.clipboard.writeText(this.transcript?.plainText() ?? "")
      new Notice(t("card.copied"))
    })
    this.iconButton(actions, "file-text", t("card.openRaw"), () => this.host.openPath(session.transcriptPath))
    this.transcript = new TranscriptPane(this.body, session, actions)
    this.transcript.onSeek = (ms) => void this.player?.play(ms)
  }

  private buildHero(): void {
    const hero = this.body.createDiv({ cls: "ml-hero" })
    const intro = hero.createDiv({ cls: "ml-hero-intro" })
    intro.createDiv({ cls: "ml-hero-title", text: t("card.hero.title") })
    intro.createDiv({ cls: "ml-hero-sub", text: t("card.hero.sub") })
    const checks = hero.createDiv({ cls: "ml-checks" })
    const settings = this.host.settings
    const asr = this.host.asr()
    const llmProblem = this.session!.llmProblem
    const check = (ok: boolean, icon: string, title: string, detail: string) => {
      const row = checks.createDiv({ cls: `ml-check ${ok ? "is-ok" : "is-off"}` })
      setIcon(row.createSpan({ cls: "ml-check-icon" }), icon)
      const label = row.createDiv({ cls: "ml-check-text" })
      label.createSpan({ cls: "ml-check-title", text: title })
      label.createSpan({ cls: "ml-check-detail", text: detail })
      if (ok) {
        row.createSpan({ cls: "ml-check-state", text: t("card.check.ready") })
      } else {
        const fix = row.createEl("button", { cls: "ml-link", text: t("card.check.fix") })
        fix.addEventListener("click", () => this.host.openSettings())
      }
    }
    check(true, "mic", t("card.check.recording"), t("card.check.recordingDetail", settings.audioFormat === "ogg" ? t("card.check.opus") : t("card.check.wav"), settings.folder))
    check(!asr.problem, "captions", t("card.check.live"), asr.problem ? t("card.check.liveProblem", asr.problem) : t("card.check.liveOk", asr.name))
    check(!llmProblem, "list", t("card.check.summary"), llmProblem ? t("card.check.summaryProblem", llmProblem) : t("card.check.summaryOk", settings.summaryIntervalMin, this.host.llm().model))
    hero.createDiv({ cls: "ml-privacy", text: t("card.privacy", asr.name) })
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, action: () => void): HTMLButtonElement {
    const b = parent.createEl("button", { cls: "ml-icon-btn", attr: { "aria-label": label } })
    setIcon(b, icon)
    b.addEventListener("click", action)
    return b
  }

  // ---------------------------------------------------------------- updates

  private update(): void {
    const session = this.session
    if (!session || !this.root) return
    const status = session.status
    this.root.dataset.status = status
    this.statusEl.dataset.status = status
    this.statusText.setText(t(STATUS_LABEL[status]))
    if (document.activeElement !== this.titleInput) this.setTitle(session.meta.title)
    this.root.toggleClass("is-capsule", !!session.meta.collapsed)
    const chipsHome = session.meta.collapsed ? this.metaEl : this.statusItems
    if (this.chips.parentElement !== chipsHome) chipsHome.appendChild(this.chips)
    this.renderCaption()

    const mode = status === "idle" && session.meta.segments.length === 0 ? "hero" : "transcript"
    if (mode !== this.bodyMode) this.buildBody(mode)

    if (status === "recording") this.waveform?.start()
    else {
      this.waveform?.stop()
      this.waveform?.draw(true)
    }
    this.renderControls()
    this.renderAlert()
    this.tick()
    this.transcript?.updateMeta()
    this.player?.refresh()
    this.renderFoot()
  }

  private tick(): void {
    const session = this.session
    if (!session || !this.root?.isConnected) return
    this.clockEl.setText(formatClock(session.durationMs, true))
    const parts = [formatShortDateTime(new Date(session.meta.createdAt))]
    if (session.status === "ended" || session.status === "interrupted") {
      parts.push(t("card.meta.utterances", session.utterances.length))
      if (session.meta.summaries.length) parts.push(t("card.meta.stages", session.meta.summaries.length))
    }
    this.metaText.setText(parts.join(" · "))
    this.renderChips()
    this.player?.refresh()
    this.root.toggleClass("is-playing", !!this.player?.playing)
  }

  private renderChips(): void {
    const session = this.session!
    const chips: { icon: string; text: string; tone: string; title?: string; action?: () => void }[] = []
    if (session.status !== "idle" || session.meta.segments.length) {
      const live = session.status === "recording" || session.status === "paused" || session.status === "stopping"
      if (live) {
        const [labelKey, tone] = ASR_LABEL[session.asrState] ?? [undefined, "idle"]
        const label = labelKey ? t(labelKey) : ""
        const backlog = session.asrBacklogMs
        const text = session.asrState === "reconnecting" && backlog > 1500 ? t("card.chip.buffered", label, Math.round(backlog / 1000)) : label
        chips.push({ icon: session.asrState === "live" ? "audio-lines" : session.asrState === "failed" || session.asrState === "reconnecting" ? "wifi-off" : "captions", text, tone, title: session.asrDetail })
      }
      if (!session.llmProblem && session.status === "recording" && this.host.settings.autoSummary) {
        const running = session.meta.summaries.some((s) => s.status === "running")
        chips.push({ icon: running ? "list" : "timer", text: running ? t("card.chip.summarizing") : t("card.chip.nextSummary", formatClock(Math.max(0, session.nextSummaryInMs))), tone: running ? "busy" : "idle" })
      }
      if (!session.llmProblem) {
        const failed = session.meta.summaries.filter((s) => s.status === "failed").length
        if (failed) chips.push({ icon: "triangle-alert", text: failed > 1 ? t("card.chip.summariesFailed", failed) : t("card.chip.summaryFailed"), tone: "warn" })
        else if (session.meta.overview?.error && !session.overviewRunning) chips.push({ icon: "triangle-alert", text: t("card.chip.overviewFailed"), tone: "warn" })
      }
      const save = session.saveState
      chips.push({ icon: save === "error" ? "triangle-alert" : "check", text: save === "error" ? t("card.chip.saveFailed") : save === "saving" ? t("card.chip.saving") : t("card.chip.saved"), tone: save === "error" ? "error" : "idle" })
      // Least important last: it is the first to drop when the header runs out of room.
      if (live && session.deviceLabel) chips.push({ icon: "mic", text: session.deviceLabel.replace(/^(?:Default|Communications) - /, "").replace(/\s*\(.*\)$/, ""), tone: "idle" })
    }
    const key = JSON.stringify(chips.map((c) => [c.icon, c.text, c.tone, c.title]))
    if (this.chips.dataset.key === key) return
    this.chips.dataset.key = key
    this.chips.empty()
    for (const chip of chips) {
      const el = this.chips.createSpan({ cls: "ml-chip", attr: chip.title ? { "aria-label": chip.title } : {} })
      el.dataset.tone = chip.tone
      setIcon(el.createSpan({ cls: "ml-chip-icon" }), chip.icon)
      el.createSpan({ text: chip.text })
    }
  }

  private renderControls(): void {
    const session = this.session!
    const status = session.status
    const blocked = this.host.manager.active && this.host.manager.active !== session
    const collapsed = !!session.meta.collapsed
    const key = `${status}:${this.busy}:${blocked}:${collapsed}`
    if (key === this.controlsKey) return
    this.controlsKey = key
    this.controls.empty()
    const button = (cls: string, icon: string, label: string, action: () => Promise<void> | void, disabled = false) => {
      const b = this.controls.createEl("button", { cls: `ml-ctl ${cls}` })
      setIcon(b.createSpan({ cls: "ml-ctl-icon" }), icon)
      b.createSpan({ cls: "ml-ctl-label", text: label })
      b.disabled = disabled || this.busy
      b.addEventListener("click", () => void this.run(action))
      return b
    }
    if (status === "stopping") {
      const b = button("is-wait", "loader", t("card.ctl.wrapping"), () => undefined, true)
      b.addClass("is-spinning")
    } else if (status === "recording") {
      button("is-secondary", "pause", t("card.ctl.pause"), () => session.pause())
      button("is-stop", "square", t("card.ctl.end"), () => session.stop())
    } else if (status === "paused" || status === "interrupted") {
      button("is-record", "circle", t("card.ctl.resume"), () => this.startRecording(), !!blocked)
      button("is-stop", "square", t("card.ctl.end"), () => session.stop())
    } else if (status === "ended") {
      button("is-secondary", "mic", t("card.ctl.resumeRecording"), () => this.startRecording(), !!blocked)
    } else {
      button("is-record is-hero", "circle", t("card.ctl.start"), () => this.startRecording(), !!blocked)
    }
    const fold = this.controls.createEl("button", { cls: "ml-ctl is-fold", attr: { "aria-label": collapsed ? t("card.ctl.expand") : t("card.ctl.collapse"), "aria-expanded": String(!collapsed) } })
    setIcon(fold, collapsed ? "chevrons-up-down" : "chevrons-down-up")
    fold.addEventListener("click", () => session.setCollapsed(!collapsed))
    const more = this.controls.createEl("button", { cls: "ml-ctl is-more", attr: { "aria-label": t("card.ctl.more") } })
    setIcon(more, "ellipsis")
    more.addEventListener("click", (e) => this.openMenu(e))
  }

  private async run(action: () => Promise<void> | void): Promise<void> {
    this.busy = true
    this.renderControls()
    try {
      await action()
    } catch (error) {
      new Notice((error as Error).message)
    } finally {
      this.busy = false
      this.controlsKey = ""
      this.update()
    }
  }

  private async startRecording(): Promise<void> {
    if (!(await this.host.ensureConsent())) return
    await this.session!.start()
  }

  private summarizeNow(): void {
    const session = this.session!
    if (session.llmProblem) {
      new Notice(t("notice.configureFirst", session.llmProblem))
      return
    }
    if (!session.summarizeNow()) new Notice(t("notice.nothingToSummarize"))
    else new Notice(t("notice.summarizing"))
  }

  private openMenu(event: MouseEvent): void {
    const session = this.session!
    const menu = new Menu()
    menu.addItem((i) => i.setTitle(t("card.menu.summarize")).setIcon("list").onClick(() => this.summarizeNow()))
    if (session.isLive && (session.asrState === "failed" || session.asrState === "reconnecting")) {
      menu.addItem((i) => i.setTitle(t("card.menu.reconnect")).setIcon("refresh-cw").onClick(() => session.retryAsr()))
    }
    menu.addItem((i) => i.setTitle(t("card.menu.minutes")).setIcon("file-pen-line").onClick(() => this.host.openMinutes(session)))
    menu.addSeparator()
    menu.addItem((i) => i.setTitle(t("card.menu.openRaw")).setIcon("captions").onClick(() => this.host.openPath(session.transcriptPath)))
    menu.addItem((i) => i.setTitle(platformText("reveal")).setIcon("folder-open").onClick(() => this.host.revealFolder(session)))
    menu.addItem((i) =>
      i
        .setTitle(t("card.menu.copyId"))
        .setIcon("copy")
        .onClick(() => void navigator.clipboard.writeText(session.id)),
    )
    menu.addSeparator()
    menu.addItem((i) => i.setTitle(t("card.menu.settings")).setIcon("settings").onClick(() => this.host.openSettings()))
    menu.showAtMouseEvent(event)
  }

  private renderAlert(): void {
    const session = this.session!
    this.alertEl.empty()
    let tone = ""
    let text = ""
    const actions: [string, () => void][] = []
    if (session.status === "interrupted") {
      tone = "warn"
      text = t("card.alert.interrupted", formatClock(session.durationMs, true))
    } else if (session.error) {
      tone = "error"
      text = session.error
      actions.push([t("card.alert.dismiss"), () => ((session.error = undefined), this.update())])
    } else if (session.isLive && session.asrState === "failed") {
      tone = "error"
      text = t("card.alert.asrStopped", session.asrDetail ?? t("common.unknownError"))
      actions.push([t("common.retry"), () => session.retryAsr()], [t("card.alert.settings"), () => this.host.openSettings()])
    } else if (session.isLive && session.asrState === "reconnecting") {
      tone = "warn"
      text = t("card.alert.reconnecting", session.asrName, session.asrDetail ?? "")
      actions.push([t("card.alert.reconnectNow"), () => session.retryAsr()])
    } else if (!session.llmProblem) {
      const failed = session.meta.summaries.filter((s) => s.status === "failed")
      const overview = session.meta.overview
      const backlog = session.overviewBacklog.length
      if (failed.length) {
        tone = "warn"
        const last = failed[failed.length - 1]
        text = failed.length > 1 ? t("card.alert.summariesFailed", failed.length, last.error ?? t("common.unknownError")) : t("card.alert.summaryFailed", last.index, last.error ?? t("common.unknownError"))
        actions.push([t("common.retry"), () => failed.forEach((s) => session.retrySummary(s.index))])
      } else if (overview?.error && !session.overviewRunning) {
        tone = "warn"
        text = t("card.alert.overviewFailed", overview.error)
        actions.push([t("common.retry"), () => void session.updateOverview()])
      } else if (backlog > 0 && !session.isLive && !session.overviewRunning && session.meta.summaries.every((s) => s.status === "done" || s.status === "failed")) {
        tone = "warn"
        text = t("card.alert.backlog", backlog)
        actions.push([t("card.alert.merge"), () => void session.updateOverview()])
      }
    }
    this.alertEl.toggleClass("is-visible", !!text)
    if (!text) return
    this.alertEl.dataset.tone = tone
    setIcon(this.alertEl.createSpan({ cls: "ml-alert-icon" }), tone === "error" ? "circle-alert" : "triangle-alert")
    this.alertEl.createDiv({ cls: "ml-alert-text", text })
    for (const [label, action] of actions) {
      const b = this.alertEl.createEl("button", { cls: "ml-link", text: label })
      b.addEventListener("click", action)
    }
  }

  /** Two subtitle lines under the capsule: the latest confirmed speech, then what is being recognized. */
  private renderCaption(): void {
    const session = this.session!
    const el = this.captionEl
    const finals = session.utterances.slice(-3).map((u) => u.text)
    const interim = session.interims.map((u) => u.text).join("")
    const visible = !!session.meta.collapsed && session.isLive && (finals.length > 0 || !!interim)
    el.toggleClass("is-visible", visible)
    el.empty()
    if (!visible) return
    const text = el.createDiv({ cls: "ml-caption-text" }).createSpan()
    text.appendText(finals.join(" "))
    if (interim) {
      text.createSpan({ cls: "ml-caption-interim", text: `${finals.length ? " " : ""}${interim}` })
      text.createSpan({ cls: "ml-caret" })
    }
  }

  private renderFoot(): void {
    const session = this.session!
    const row = this.footRow
    row.empty()
    const files = row.createDiv({ cls: "ml-files" })
    const link = (icon: string, label: string, path: string) => {
      const a = files.createEl("button", { cls: "ml-file" })
      setIcon(a.createSpan({ cls: "ml-file-icon" }), icon)
      a.createSpan({ text: label })
      a.addEventListener("click", () => this.host.openPath(path))
    }
    link("captions", t("card.foot.raw"), session.transcriptPath)
    for (const [i, path] of session.meta.minutes.entries()) link("file-pen-line", session.meta.minutes.length > 1 ? t("card.foot.minutesN", i + 1) : t("card.foot.minutes"), path)
    const segs = session.meta.segments
    if (segs.length) {
      const fmt = segs[segs.length - 1]
      files.createSpan({ cls: "ml-audio-info", text: t("card.foot.audio", segs.length, Math.round(fmt.sampleRate / 1000), fmt.format === "ogg" ? "Opus" : "WAV") })
    }
    const ended = session.status === "ended" || session.status === "interrupted"
    const running = session.minutes.status === "running"
    const minutes = row.createEl("button", { cls: `ml-btn ml-minutes ${ended ? "is-primary" : ""}` })
    setIcon(minutes.createSpan({ cls: "ml-btn-icon" }), running ? "loader" : "file-pen-line")
    minutes.createSpan({ text: running ? t("card.foot.generating") : t("card.foot.generate") })
    minutes.toggleClass("is-spinning", running)
    minutes.disabled = running || session.utterances.length === 0
    minutes.addEventListener("click", () => this.host.openMinutes(session))
  }
}
