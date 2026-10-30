import { Events } from "obsidian"
import { AudioCapture } from "../audio/capture.ts"
import { AsrResampler } from "../audio/pcm.ts"
import { SegmentRecorder, opusSupported, repairSegment } from "../audio/recorder.ts"
import { AsrStreamer, type AsrConnect, type AsrState } from "../asr/streamer.ts"
import type { LlmClient } from "../llm/client.ts"
import { buildMinutesMessages } from "../llm/minutes.ts"
import { buildOverviewMessages, buildSummaryMessages, isEmptySummary, overviewMarkdown, parseSummary, summaryMarkdown } from "../llm/summary.ts"
import type { MeetingLiveSettings } from "../settings.ts"
import { dueCutoff, uncovered } from "./schedule.ts"
import { MINUTES_FILE, SUMMARY_FILE, TRANSCRIPT_FILE, meetingFile, movedPath, noteName, type MeetingStore } from "./store.ts"
import { audioLine, blockId, gapLine, parseTranscript, utteranceLine } from "./transcriptFormat.ts"
import { formatClock, formatDate, formatDateTime, totalDuration, type AudioFormat, type AudioSegment, type MeetingMeta, type SummaryRecord, type TranscriptGap, type Utterance } from "./types.ts"

export interface SessionEnv {
  store: MeetingStore
  settings: () => MeetingLiveSettings
  asrConnector: () => { connect: AsrConnect | null; problem?: string }
  llm: () => LlmClient
  /** Ensures only one meeting records at a time; returns an error message if blocked. */
  claim: (session: MeetingSession) => string | undefined
  release: (session: MeetingSession) => void
}

export type SaveState = "saved" | "saving" | "error"
export type MinutesState = { status: "idle" } | { status: "running" } | { status: "error"; message: string }

const LEVEL_HISTORY = 256
const SUMMARY_RETRY_MS = [5000, 20000]
const MAX_SUMMARY_ATTEMPTS = 3
const SAVE_DEBOUNCE_MS = 2000

const basename = (path: string) => path.split("/").pop()!.replace(/\.md$/, "")

/**
 * Runtime of one meeting. Lives in the plugin, not in any rendered card, so re-rendering,
 * switching notes or changing view mode never interrupts recording or recognition.
 */
export class MeetingSession extends Events {
  folder: string
  meta: MeetingMeta
  utterances: Utterance[] = []
  interims: Utterance[] = []
  asrState: AsrState = "idle"
  asrDetail: string | undefined
  saveState: SaveState = "saved"
  savedAt = Date.now()
  minutes: MinutesState = { status: "idle" }
  overviewRunning = false
  error: string | undefined
  deviceLabel = ""
  /** Recent input levels (0–1, perceptual), newest at levelCursor - 1. */
  readonly levels = new Float32Array(LEVEL_HISTORY)
  levelCursor = 0

  private readonly env: SessionEnv
  private capture: AudioCapture | undefined
  private recorder: SegmentRecorder | undefined
  private resampler: AsrResampler | undefined
  private asr: AsrStreamer | undefined
  private liveSegment: AudioSegment | undefined
  private liveFrames = 0
  private ticker: number | undefined
  private io: Promise<unknown> = Promise.resolve()
  private saveTimer: number | undefined
  private queueRunning = false
  private runGapStart = 0
  private transition: Promise<void> | undefined

  constructor(env: SessionEnv, folder: string, meta: MeetingMeta, transcript: string) {
    super()
    this.env = env
    this.folder = folder
    this.meta = meta
    this.utterances = parseTranscript(transcript)
  }

  get id(): string {
    return this.meta.id
  }

  get status() {
    return this.meta.status
  }

  get isLive(): boolean {
    return this.meta.status === "recording" || this.meta.status === "paused" || this.meta.status === "stopping"
  }

  get durationMs(): number {
    return totalDuration(this.meta)
  }

  get transcriptPath(): string {
    return this.env.store.path(this.folder, meetingFile(this.meta.name, TRANSCRIPT_FILE))
  }

  get summaryPath(): string {
    return this.env.store.path(this.folder, meetingFile(this.meta.name, SUMMARY_FILE))
  }

  get llmProblem(): string | undefined {
    return this.env.llm().problem
  }

  get summaryIntervalMs(): number {
    return this.env.settings().summaryIntervalMin * 60_000
  }

  /** Milliseconds of meeting time until the next automatic summary window closes. */
  get nextSummaryInMs(): number {
    return this.meta.lastCutoffMs + this.summaryIntervalMs - this.durationMs
  }

  get asrBacklogMs(): number {
    return this.asr?.backlogMs ?? 0
  }

  resourceUrl(path: string): string {
    return this.env.store.resourceUrl(path)
  }

  private emitChange(): void {
    this.trigger("change")
  }

  // ---------------------------------------------------------------- lifecycle

  start(): Promise<void> {
    return this.serialize(() => this.doStart())
  }

  pause(): Promise<void> {
    return this.serialize(async () => {
      if (this.meta.status !== "recording") return
      await this.endRun("paused")
    })
  }

  stop(): Promise<void> {
    return this.serialize(async () => {
      if (this.meta.status === "recording") await this.endRun("stopping")
      else if (!["paused", "interrupted", "stopping"].includes(this.meta.status)) return
      this.env.release(this)
      this.enqueueSummary(this.durationMs, "final")
      this.meta.status = "ended"
      await this.saveNow()
      this.emitChange()
      void this.syncName()
    })
  }

  private async serialize(action: () => Promise<void>): Promise<void> {
    while (this.transition) await this.transition
    this.transition = action().finally(() => (this.transition = undefined))
    return this.transition
  }

  private async doStart(): Promise<void> {
    if (this.meta.status === "recording" || this.meta.status === "stopping") return
    const blocked = this.env.claim(this)
    if (blocked) throw new Error(blocked)
    const settings = this.env.settings()
    this.error = undefined
    let capture: AudioCapture | undefined
    try {
      capture = await AudioCapture.open(
        { deviceId: settings.deviceId, voiceProcessing: settings.voiceProcessing },
        (channels) => this.onFrames(channels),
        () => void this.onDeviceLost(),
      )
      const format: AudioFormat = settings.audioFormat === "ogg" && (await opusSupported(capture.sampleRate, capture.channels)) ? "ogg" : "wav"
      await this.openSegment(capture, format)
    } catch (error) {
      await capture?.close()
      if (this.meta.status !== "paused") this.env.release(this)
      this.error = (error as Error).message
      this.emitChange()
      throw error
    }
    this.capture = capture
    this.deviceLabel = capture.deviceLabel
    this.resampler = new AsrResampler(capture.sampleRate)
    this.startAsr()
    this.meta.status = "recording"
    this.ticker = window.setInterval(() => this.onTick(), 1000)
    await this.saveNow()
    this.emitChange()
  }

  private async openSegment(capture: AudioCapture, format: AudioFormat): Promise<void> {
    const path = await this.env.store.audioFile(this.folder, this.meta.name, this.meta.segments.length + 1, format)
    this.recorder = await SegmentRecorder.create(this.env.store.fullPath(path), format, capture.sampleRate, capture.channels, (error) => this.onRecorderError(error))
    this.liveFrames = 0
    this.liveSegment = { file: path, format, startMs: this.durationMs, durationMs: 0, startedAt: new Date().toISOString(), sampleRate: capture.sampleRate, channels: capture.channels }
    this.meta.segments.push(this.liveSegment)
    void this.writeIo(() => this.env.store.appendTranscript(this.transcriptPath, audioLine(path)))
  }

  private startAsr(): void {
    const { connect, problem } = this.env.asrConnector()
    this.asrDetail = problem
    if (!this.asr) {
      this.asr = new AsrStreamer(connect, {
        onFinal: (u) => this.onFinal(u),
        onInterim: (list) => {
          this.interims = list
          this.trigger("interim")
        },
        onGap: (gap) => this.onGap(gap),
        onState: (state, detail) => {
          this.asrState = state
          this.asrDetail = detail ?? (state === "disabled" ? problem : undefined)
          this.emitChange()
        },
        onLogId: (id) => {
          this.meta.asrLogIds = [...this.meta.asrLogIds.slice(-49), id]
        },
      })
      this.asr.restore(this.utterances)
    }
    this.asrState = this.asr.currentState
    this.runGapStart = this.meta.gaps.length
    this.asr.begin(this.durationMs)
  }

  /** Stops capture and closes the run; status becomes paused, or stopping for a full stop. */
  private async endRun(next: "paused" | "stopping"): Promise<void> {
    this.meta.status = next
    this.emitChange()
    if (this.ticker) window.clearInterval(this.ticker)
    this.ticker = undefined
    const capture = this.capture
    const recorder = this.recorder
    this.capture = undefined
    this.recorder = undefined
    await capture?.close()
    await recorder?.close()
    this.liveSegment = undefined
    await this.asr?.end()
    this.levels.fill(0)
    for (const gap of this.meta.gaps.slice(this.runGapStart)) void this.writeIo(() => this.env.store.appendTranscript(this.transcriptPath, gapLine(gap)))
    await this.saveNow()
    this.emitChange()
  }

  private onFrames(channels: Float32Array[]): void {
    if (this.meta.status !== "recording" || !this.liveSegment || !this.capture) return
    const frames = channels[0]?.length ?? 0
    try {
      this.recorder?.write(channels)
    } catch (error) {
      this.onRecorderError(error as Error)
    }
    if (this.resampler) this.asr?.push(this.resampler.process(channels))
    this.liveFrames += frames
    this.liveSegment.durationMs = (this.liveFrames / this.capture.sampleRate) * 1000
    let sum = 0
    for (const channel of channels) for (let i = 0; i < frames; i++) sum += channel[i] * channel[i]
    const rms = Math.sqrt(sum / Math.max(1, frames * channels.length))
    const db = 20 * Math.log10(Math.max(rms, 1e-5))
    this.levels[this.levelCursor % LEVEL_HISTORY] = Math.max(0, Math.min(1, (db + 60) / 54))
    this.levelCursor++
  }

  private async onDeviceLost(): Promise<void> {
    if (this.meta.status !== "recording") return
    this.error = "麦克风已断开，会议已暂停。重新连接设备后点击继续"
    await this.pause()
  }

  /** An encoder or disk failure must not lose audio: continue in a fresh WAV segment. */
  private onRecorderError(error: Error): void {
    console.error("[meeting-live]", error)
    if (this.meta.status !== "recording" || !this.capture) return
    const broken = this.recorder
    this.recorder = undefined
    const capture = this.capture
    this.error = `${error.message}，已切换为 WAV 录音继续`
    void (async () => {
      await broken?.close().catch(() => undefined)
      if (this.liveSegment) this.liveSegment = undefined
      if (this.meta.status === "recording") await this.openSegment(capture, "wav")
      this.emitChange()
    })()
  }

  private onTick(): void {
    const settings = this.env.settings()
    if (settings.autoSummary && !this.llmProblem && this.asr) {
      const cutoff = dueCutoff(this.durationMs, this.meta.lastCutoffMs, this.summaryIntervalMs, this.asr.deliveredMs, this.asrState === "live")
      if (cutoff !== undefined) this.enqueueSummary(cutoff, "auto")
    }
    this.markDirty()
    this.trigger("tick")
  }

  retryAsr(): void {
    this.asr?.retryNow()
  }

  // ---------------------------------------------------------------- transcript

  private onFinal(u: Utterance): void {
    const index = this.utterances.findIndex((x) => x.startMs > u.startMs)
    if (index < 0) this.utterances.push(u)
    else this.utterances.splice(index, 0, u)
    void this.writeIo(() => this.env.store.appendTranscript(this.transcriptPath, utteranceLine(u)))
    this.trigger("utterance", u)
  }

  private onGap(gap: TranscriptGap): void {
    const last = this.meta.gaps[this.meta.gaps.length - 1]
    if (last && last.reason === gap.reason && gap.startMs - last.endMs < 50) last.endMs = Math.max(last.endMs, gap.endMs)
    else this.meta.gaps.push({ ...gap })
    this.markDirty()
    this.trigger("gap")
  }

  // ---------------------------------------------------------------- summaries

  summarizeNow(): boolean {
    const before = this.meta.summaries.length
    this.enqueueSummary(this.durationMs, "manual")
    return this.meta.summaries.length > before
  }

  private enqueueSummary(cutoff: number, trigger: SummaryRecord["trigger"]): void {
    const items = uncovered(this.utterances, this.meta.summaries, trigger === "auto" ? cutoff : Infinity)
    const startMs = this.meta.lastCutoffMs
    this.meta.lastCutoffMs = Math.max(this.meta.lastCutoffMs, cutoff)
    this.markDirty()
    if (items.length === 0 || this.llmProblem) return
    this.meta.summaries.push({
      index: this.meta.summaries.length + 1,
      startMs: Math.min(startMs, items[0].startMs),
      endMs: Math.max(cutoff, items[items.length - 1].endMs),
      trigger,
      status: "pending",
      attempts: 0,
      utterances: items.map((u) => Math.round(u.startMs)),
    })
    this.trigger("summary")
    void this.runQueue()
  }

  retrySummary(index: number): void {
    const record = this.meta.summaries.find((s) => s.index === index)
    if (!record || record.status === "running") return
    record.status = "pending"
    record.attempts = 0
    record.error = undefined
    this.trigger("summary")
    void this.runQueue()
  }

  async runQueue(): Promise<void> {
    if (this.queueRunning) return
    this.queueRunning = true
    try {
      for (let record = this.nextPending(); record; record = this.nextPending()) {
        await this.runSummary(record)
        await this.updateOverview()
      }
    } finally {
      this.queueRunning = false
    }
  }

  private nextPending(): SummaryRecord | undefined {
    return this.meta.summaries.find((s) => s.status === "pending")
  }

  private async runSummary(record: SummaryRecord): Promise<void> {
    const llm = this.env.llm()
    if (llm.problem) {
      record.status = "failed"
      record.error = llm.problem
      this.trigger("summary")
      return
    }
    const keys = new Set(record.utterances)
    const items = this.utterances.filter((u) => keys.has(Math.round(u.startMs)))
    const previous = this.meta.summaries.filter((s) => s.index < record.index)
    record.status = "running"
    record.attempts++
    this.trigger("summary")
    try {
      const messages = buildSummaryMessages(this.meta.title, this.env.settings().summaryFocus, record, items, previous, this.meta.overview?.content)
      const text = await llm.complete(messages)
      const content = parseSummary(text, items)
      record.content = content
      record.raw = content ? undefined : text
      record.status = "done"
      record.error = undefined
      record.model = llm.model
      record.createdAt = new Date().toISOString()
    } catch (error) {
      record.error = (error as Error).message
      if (record.attempts < MAX_SUMMARY_ATTEMPTS) {
        record.status = "pending"
        this.trigger("summary")
        await new Promise((r) => window.setTimeout(r, SUMMARY_RETRY_MS[record.attempts - 1] ?? 20000))
      } else record.status = "failed"
    }
    this.trigger("summary")
    await this.saveNow()
    if (record.status === "done") void this.writeIo(() => this.env.store.write(this.summaryPath, this.summariesMarkdown()))
  }

  /** Completed stage summaries not yet merged into the overview. */
  get overviewBacklog(): SummaryRecord[] {
    const merged = new Set(this.meta.overview?.stages ?? [])
    return this.meta.summaries.filter((s) => s.status === "done" && !merged.has(s.index))
  }

  /** Timeline position the overview covers up to. */
  get overviewThroughMs(): number {
    const merged = new Set(this.meta.overview?.stages ?? [])
    return Math.max(0, ...this.meta.summaries.filter((s) => merged.has(s.index)).map((s) => s.endMs))
  }

  /** Merges completed stages into the overview; on failure keeps the previous overview and records the error. */
  async updateOverview(): Promise<void> {
    if (this.overviewRunning || this.overviewBacklog.length === 0) return
    this.overviewRunning = true
    try {
      for (let stages = this.overviewBacklog; stages.length; stages = this.overviewBacklog) {
        const llm = this.env.llm()
        if (llm.problem) return
        const overview = this.meta.overview ?? { stages: [] }
        const merged = [...overview.stages, ...stages.map((s) => s.index)].sort((a, b) => a - b)
        const substantive = stages.filter((s) => !s.content || !isEmptySummary(s.content))
        if (substantive.length === 0) {
          this.meta.overview = { ...overview, stages: merged }
          continue
        }
        this.trigger("summary")
        try {
          const text = await llm.complete(buildOverviewMessages(this.meta.title, this.env.settings().summaryFocus, overview.content, substantive))
          const content = parseSummary(text, this.utterances)
          if (!content) throw new Error("模型返回的概览格式无法识别")
          this.meta.overview = { stages: merged, content, createdAt: new Date().toISOString(), model: llm.model }
        } catch (error) {
          this.meta.overview = { ...overview, error: (error as Error).message }
          return
        }
      }
    } finally {
      this.overviewRunning = false
      this.trigger("summary")
      await this.saveNow()
      void this.writeIo(() => this.env.store.write(this.summaryPath, this.summariesMarkdown()))
    }
  }

  summaryLink(ms: number): string {
    const u = this.utterances.find((x) => Math.round(x.startMs) === Math.round(ms))
    const target = this.transcriptPath.replace(/\.md$/, "")
    return u ? `[[${target}#^${blockId(u)}|${formatClock(ms)}]]` : formatClock(ms)
  }

  summariesMarkdown(): string {
    const head = [
      "---",
      `meeting: ${this.meta.id}`,
      "type: meeting-summaries",
      `note: "[[${this.meta.notePath.replace(/\.md$/, "")}]]"`,
      `date: ${this.meta.createdAt.slice(0, 10)}`,
      `transcript: "[[${this.transcriptPath.replace(/\.md$/, "")}]]"`,
      "---",
      "",
      `# AI 阶段摘要 · ${this.meta.title}`,
      "",
      "> [!caution] AI 生成内容，可能存在遗漏或误读。所有事实以原始转写与录音为准。",
      "",
    ]
    const link = (ms: number) => this.summaryLink(ms)
    const overview = this.meta.overview?.content ? [overviewMarkdown(this.meta.overview.content, this.overviewThroughMs, link)] : []
    const body = this.meta.summaries.filter((s) => s.status === "done").map((s) => summaryMarkdown(s, link))
    return [...head, ...overview, ...body].join("\n")
  }

  // ---------------------------------------------------------------- minutes

  async generateMinutes(prompt: string, notes: { path: string; content: string }[]): Promise<string> {
    const llm = this.env.llm()
    if (llm.problem) throw new Error(llm.problem)
    if (this.utterances.length === 0) throw new Error("还没有可用的转写内容")
    this.minutes = { status: "running" }
    this.emitChange()
    try {
      const messages = buildMinutesMessages(prompt, {
        title: this.meta.title,
        date: formatDate(new Date(this.meta.createdAt)),
        utterances: this.utterances,
        summaries: this.meta.summaries,
        notes,
      })
      const text = await llm.complete(messages)
      const path = await this.env.store.uniquePath(this.folder, meetingFile(this.meta.name, MINUTES_FILE), "md")
      const note = this.meta.notePath.replace(/\.md$/, "")
      const doc = [
        "---",
        `meeting: ${this.meta.id}`,
        "type: meeting-minutes",
        `note: "[[${note}]]"`,
        `date: ${this.meta.createdAt.slice(0, 10)}`,
        `transcript: "[[${this.transcriptPath.replace(/\.md$/, "")}]]"`,
        ...(this.meta.summaries.some((s) => s.status === "done") ? [`summary: "[[${this.summaryPath.replace(/\.md$/, "")}]]"`] : []),
        `model: ${llm.model}`,
        `generated: ${formatDateTime(new Date())}`,
        "---",
        "",
        `# ${this.meta.title} 纪要`,
        "",
        "> [!caution] 本纪要由 AI 根据原始转写整理，发布前请对照转写与录音核实关键事实与数字。",
        "",
        text,
        "",
      ].join("\n")
      await this.env.store.write(path, doc)
      this.meta.minutes.push(path)
      this.minutes = { status: "idle" }
      await this.saveNow()
      return path
    } catch (error) {
      this.minutes = { status: "error", message: (error as Error).message }
      throw error
    } finally {
      this.emitChange()
      void this.syncName()
    }
  }

  // ---------------------------------------------------------------- persistence

  rename(title: string): void {
    const clean = title.trim()
    if (!clean || clean === this.meta.title) return
    this.meta.title = clean
    void this.saveNow()
    this.emitChange()
  }

  /** Follows the note to a new path; a title never edited by hand follows its name. */
  setNotePath(path: string): Promise<unknown> {
    if (this.meta.title === basename(this.meta.notePath)) this.meta.title = basename(path)
    this.meta.notePath = path
    void this.saveNow()
    this.emitChange()
    return this.syncName()
  }

  /** Renames the meeting folder and files after the note, once nothing is recording or writing minutes into them. */
  syncName(): Promise<unknown> {
    if (!this.meta.name || this.isLive || this.minutes.status === "running") return Promise.resolve()
    return this.writeIo(async () => {
      const from = this.meta.name
      if (!from || this.isLive) return
      const { folder, name } = await this.env.store.renameMeeting(this.folder, from, noteName(this.meta.notePath))
      if (name === from) return
      const moved = (path: string) => movedPath(path, this.folder, folder, from, name)
      for (const segment of this.meta.segments) segment.file = moved(segment.file)
      this.meta.minutes = this.meta.minutes.map(moved)
      this.meta.name = name
      this.folder = folder
      await this.env.store.saveMeta(folder, structuredClone(this.meta))
      this.emitChange()
    })
  }

  private writeIo(task: () => Promise<void>): Promise<unknown> {
    this.saveState = "saving"
    this.io = this.io
      .then(task)
      .then(() => {
        this.saveState = "saved"
        this.savedAt = Date.now()
      })
      .catch((error: Error) => {
        this.saveState = "error"
        this.error = `保存失败：${error.message}`
        console.error("[meeting-live]", error)
        this.emitChange()
      })
    return this.io
  }

  private markDirty(): void {
    if (this.saveTimer) return
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = undefined
      void this.saveNow()
    }, SAVE_DEBOUNCE_MS)
  }

  async saveNow(): Promise<void> {
    if (this.saveTimer) window.clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    this.meta.updatedAt = new Date().toISOString()
    const snapshot = structuredClone(this.meta)
    await this.writeIo(() => this.env.store.saveMeta(this.folder, snapshot))
  }

  /** Called on plugin unload. Closes files promptly; anything unfinished is repaired on next launch. */
  shutdown(): void {
    if (this.ticker) window.clearInterval(this.ticker)
    void this.capture?.close()
    void this.recorder?.close()
    this.asr?.dispose()
    if (this.saveTimer) window.clearTimeout(this.saveTimer)
  }

  /** Repairs state left by a crash or quit while recording. */
  static async recover(store: MeetingStore, meta: MeetingMeta): Promise<boolean> {
    let changed = false
    if (meta.status === "recording" || meta.status === "paused" || meta.status === "stopping") {
      meta.status = "interrupted"
      changed = true
      const kept: AudioSegment[] = []
      for (const segment of meta.segments) {
        if (!(await store.exists(segment.file))) continue
        if (segment === meta.segments[meta.segments.length - 1]) {
          try {
            const duration = await repairSegment(store.fullPath(segment.file), segment.format, segment.sampleRate, segment.channels)
            if (duration > 0) segment.durationMs = duration
          } catch (error) {
            console.error("[meeting-live] 录音修复失败", error)
          }
        }
        if (segment.durationMs > 0) {
          segment.startMs = kept.reduce((sum, s) => sum + s.durationMs, 0)
          kept.push(segment)
        }
      }
      meta.segments = kept
    }
    for (const s of meta.summaries) {
      if (s.status === "running") {
        s.status = "pending"
        changed = true
      }
    }
    return changed
  }
}
