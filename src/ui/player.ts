import { setIcon } from "obsidian"
import type { MeetingSession } from "../meeting/session.ts"
import { formatClock, type AudioSegment } from "../meeting/types.ts"

const RATES = [1, 1.25, 1.5, 2]

/** One continuous timeline over ordered audio segments; each segment is a separate valid file. */
export class TimelinePlayer {
  private readonly session: MeetingSession
  private readonly audio: HTMLAudioElement
  private readonly playButton: HTMLButtonElement
  private readonly timeEl: HTMLElement
  private readonly totalEl: HTMLElement
  private readonly track: HTMLElement
  private readonly fill: HTMLElement
  private readonly marks: HTMLElement
  private readonly hover: HTMLElement
  private readonly rateButton: HTMLButtonElement
  private segment: AudioSegment | undefined
  private rate = 0
  private positionMs = 0
  private markKey = ""
  onPosition: ((ms: number, playing: boolean) => void) | undefined

  constructor(parent: HTMLElement, session: MeetingSession) {
    this.session = session
    const root = parent.createDiv({ cls: "ml-player" })
    this.playButton = root.createEl("button", { cls: "ml-play", attr: { "aria-label": "播放录音" } })
    setIcon(this.playButton, "play")
    this.timeEl = root.createSpan({ cls: "ml-player-time", text: "00:00" })
    this.track = root.createDiv({ cls: "ml-track", attr: { role: "slider", "aria-label": "录音进度", tabindex: "0" } })
    this.marks = this.track.createDiv({ cls: "ml-track-marks" })
    this.fill = this.track.createDiv({ cls: "ml-track-fill" })
    this.hover = this.track.createDiv({ cls: "ml-track-hover" })
    this.totalEl = root.createSpan({ cls: "ml-player-time is-total", text: "00:00" })
    this.rateButton = root.createEl("button", { cls: "ml-rate", text: "1×", attr: { "aria-label": "播放速度" } })
    this.audio = root.createEl("audio", { attr: { preload: "metadata" } })

    this.playButton.addEventListener("click", () => (this.audio.paused ? void this.play() : this.audio.pause()))
    this.rateButton.addEventListener("click", () => {
      this.rate = (this.rate + 1) % RATES.length
      this.audio.playbackRate = RATES[this.rate]
      this.rateButton.setText(`${RATES[this.rate]}×`)
    })
    this.audio.addEventListener("play", () => this.syncButton())
    this.audio.addEventListener("pause", () => this.syncButton())
    this.audio.addEventListener("timeupdate", () => {
      if (!this.segment) return
      this.positionMs = this.segment.startMs + this.audio.currentTime * 1000
      this.refresh()
      this.onPosition?.(this.positionMs, !this.audio.paused)
    })
    this.audio.addEventListener("ended", () => {
      const segments = this.segments()
      const next = segments[segments.indexOf(this.segment!) + 1]
      if (next) void this.play(next.startMs)
      else this.syncButton()
    })
    this.audio.addEventListener("error", () => {
      this.playButton.addClass("is-error")
      this.playButton.setAttr("aria-label", "录音文件无法播放")
    })

    const positionAt = (event: PointerEvent) => {
      const rect = this.track.getBoundingClientRect()
      return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * this.total()
    }
    this.track.addEventListener("pointermove", (event) => {
      const ms = positionAt(event)
      this.hover.setText(formatClock(ms))
      this.hover.style.left = `${(ms / Math.max(1, this.total())) * 100}%`
    })
    this.track.addEventListener("pointerdown", (event) => {
      if (this.total() <= 0) return
      this.track.setPointerCapture(event.pointerId)
      const wasPlaying = !this.audio.paused
      this.seek(positionAt(event), wasPlaying)
      const move = (e: PointerEvent) => this.seek(positionAt(e), false)
      const up = () => {
        this.track.removeEventListener("pointermove", move)
        if (wasPlaying) void this.play(this.positionMs)
      }
      this.track.addEventListener("pointermove", move)
      this.track.addEventListener("pointerup", up, { once: true })
    })
    this.track.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight") this.seek(this.positionMs + 5000, !this.audio.paused)
      else if (event.key === "ArrowLeft") this.seek(this.positionMs - 5000, !this.audio.paused)
      else return
      event.preventDefault()
    })
    this.refresh()
  }

  private segments(): AudioSegment[] {
    return this.session.meta.segments.filter((s) => s.durationMs > 0)
  }

  private total(): number {
    return this.session.durationMs
  }

  get playing(): boolean {
    return !this.audio.paused
  }

  async play(atMs?: number): Promise<void> {
    if (atMs !== undefined) this.seek(atMs, false)
    if (!this.segment) this.seek(this.positionMs, false)
    if (!this.segment) return
    try {
      await this.audio.play()
    } catch (error) {
      console.error("[meeting-live] 播放失败", error)
    }
  }

  seek(ms: number, keepPlaying: boolean): void {
    const segments = this.segments()
    if (segments.length === 0) return
    const target = Math.max(0, Math.min(ms, this.total() - 50))
    const segment = segments.find((s) => target < s.startMs + s.durationMs) ?? segments[segments.length - 1]
    const offset = Math.max(0, (target - segment.startMs) / 1000)
    if (this.segment !== segment) {
      this.segment = segment
      this.audio.src = this.session.resourceUrl(segment.file)
      this.audio.playbackRate = RATES[this.rate]
      const apply = () => (this.audio.currentTime = offset)
      if (this.audio.readyState >= 1) apply()
      else this.audio.addEventListener("loadedmetadata", apply, { once: true })
    } else {
      this.audio.currentTime = offset
    }
    this.positionMs = target
    this.refresh()
    if (keepPlaying) void this.audio.play().catch(() => undefined)
  }

  pause(): void {
    this.audio.pause()
  }

  private syncButton(): void {
    setIcon(this.playButton, this.audio.paused ? "play" : "pause")
    this.playButton.setAttr("aria-label", this.audio.paused ? "播放录音" : "暂停播放")
    this.playButton.toggleClass("is-playing", !this.audio.paused)
  }

  /** Redraws progress and markers; called on ticks and when meeting data changes. */
  refresh(): void {
    const total = this.total()
    const has = this.segments().length > 0
    this.playButton.disabled = !has
    this.track.toggleClass("is-empty", !has)
    this.timeEl.setText(formatClock(this.positionMs))
    this.totalEl.setText(formatClock(total))
    this.fill.style.width = `${total > 0 ? Math.min(100, (this.positionMs / total) * 100) : 0}%`
    const meta = this.session.meta
    const key = `${Math.round(total / 5000)}:${meta.segments.length}:${meta.gaps.length}:${meta.summaries.length}`
    if (key === this.markKey || total <= 0) return
    this.markKey = key
    this.marks.empty()
    const pct = (ms: number) => `${(ms / total) * 100}%`
    for (const gap of meta.gaps) {
      const el = this.marks.createDiv({ cls: "ml-mark-gap", attr: { "aria-label": `转写缺口 ${formatClock(gap.startMs)}–${formatClock(gap.endMs)}` } })
      el.style.left = pct(gap.startMs)
      el.style.width = pct(Math.max(gap.endMs - gap.startMs, total / 400))
    }
    for (const segment of meta.segments.slice(1)) this.marks.createDiv({ cls: "ml-mark-seg" }).style.left = pct(segment.startMs)
    for (const s of meta.summaries) this.marks.createDiv({ cls: "ml-mark-stage", attr: { "aria-label": `阶段 ${s.index}` } }).style.left = pct(s.endMs)
  }

  destroy(): void {
    this.audio.pause()
    this.audio.removeAttribute("src")
    this.audio.load()
  }
}
