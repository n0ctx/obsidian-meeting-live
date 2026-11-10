import { Events } from "obsidian"
import { t, tr, type Lang } from "../i18n/index.ts"
import { AudioCapture } from "../audio/capture.ts"
import { AsrResampler } from "../audio/pcm.ts"
import { SegmentRecorder, opusSupported, repairSegment } from "../audio/recorder.ts"
import { addsToTyped, asrContextFor, type AsrContext } from "../asr/context.ts"
import { applyCorrections, correctionTables, type Correction } from "../asr/corrections.ts"
import type { ResolvedLive } from "../asr/providers/registry.ts"
import { extractVocabulary, type NoteVocabulary } from "../asr/vocabulary.ts"
import { AsrStreamer, type AsrState } from "../asr/streamer.ts"
import type { LlmClient } from "../llm/client.ts"
import { writeMinutes } from "../llm/contextGuard.ts"
import { acceptFixes, buildCorrectionMessages, correctionTerms, noTerms, parseFixes } from "../llm/correction.ts"
import { buildOverviewMessages, buildSummaryMessages, capOverview, hasUnverified, isEmptySummary, overviewMarkdown, overviewProblems, overviewRetryMessage, parseSummary, summaryMarkdown, type LineAnchor } from "../llm/summary.ts"
import type { MeetingLiveSettings } from "../settings.ts"
import { dueCutoff, uncovered } from "./schedule.ts"
import { placeCardHeading, placeSummary } from "./noteSummary.ts"
import { noteLang } from "./labels.ts"
import { meetingFile, movedPath, noteName, transcriptFileName, type MeetingStore } from "./store.ts"
import { audioLine, blockId, gapLine, linkTranscript, parseTranscript, retextTranscript, utteranceLine } from "./transcriptFormat.ts"
import { formatClock, formatDate, formatDateTime, totalDuration, type AudioFormat, type AudioSegment, type MeetingMeta, type SummaryRecord, type TranscriptGap, type Utterance } from "./types.ts"

export interface SessionEnv {
  store: MeetingStore
  settings: () => MeetingLiveSettings
  /** The live recognizer under the current settings; asked afresh for every recording run. `context` is read when it resolves. */
  asr: (context?: () => AsrContext | undefined) => ResolvedLive
  /**
   * Whether the meeting's speech context (the background and the note's names) may go to the live recognizer, asking the user if they
   * have not said. False when declined, which still records: the typed hotwords go, as always.
   */
  asrContextConsent: () => Promise<boolean>
  /**
   * Whether the speech context may go to the live recognizer as it is configured now, without asking. Read whenever the recognizer
   * is resolved, so a retry through another host sends only the typed hotwords until that host is agreed to.
   */
  asrContextConsented: () => boolean
  llm: () => LlmClient
  /**
   * Whether the user has agreed to send text to the model service as it is configured now. The host may have changed since the
   * meeting was recorded, so a meeting that is not recording must not send anything until they agree again.
   */
  llmConsented: () => boolean
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
/** How long the note must stay unchanged before its names and pairs are read again, so typing does not re-read on every key. */
const NOTE_SETTLE_MS = 1500

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
  /** The recognizer resolved for the current or latest run. */
  private asrRun: ResolvedLive | undefined
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
  /** What the note marked as names and the pairs it holds, read before each run and again after the note is edited. */
  private vocabulary: NoteVocabulary | undefined
  private unwatchNote: (() => void) | undefined
  private noteTimer: number | undefined
  /** The note's pairs the transcript was last corrected with, so an edit that leaves them as they were rewrites nothing. */
  private appliedPairs = ""
  /** Stages whose window the model has already checked for misheard names, so a retried summary does not ask again. */
  private readonly checkedStages = new Set<number>()

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
    return this.env.store.path(this.folder, transcriptFileName(this.meta))
  }

  get llmProblem(): string | undefined {
    return this.env.llm().problem
  }

  get llmConsented(): boolean {
    return this.env.llmConsented()
  }

  /** Language of what this meeting writes into notes and files, under the current settings. */
  get noteLang(): Lang {
    return noteLang(this.env.settings())
  }

  get summaryIntervalMs(): number {
    return this.env.settings().summaryIntervalMin * 60_000
  }

  /** Milliseconds of meeting time until the next automatic summary window closes. */
  get nextSummaryInMs(): number {
    return this.meta.lastCutoffMs + this.summaryIntervalMs - this.durationMs
  }

  /** Display name of the recognizer of the current or latest run. */
  get asrName(): string {
    return this.asrRun?.name ?? ""
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
    // The recording a pause just ended may still be sending its backlog; a resume must not wait for that, since nothing is recorded meanwhile.
    if (this.meta.status === "paused") this.asr?.interruptFlush()
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
      this.stopWatchingNote()
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
    // Read before resolving: the recognizer fixes its context when it connects, and a pause and resume reads the note again.
    this.vocabulary = await this.readVocabulary()
    // Asked only when there is more than the typed hotwords; the answer is read back through asrContextConsented when resolving.
    if (addsToTyped(settings, this.vocabulary) && !this.env.asrContextConsented()) await this.env.asrContextConsent().catch(() => false)
    const asr = this.env.asr(() => this.asrContext())
    this.asrRun = asr
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
    this.startAsr(asr)
    this.meta.status = "recording"
    this.ticker = window.setInterval(() => this.onTick(), 1000)
    this.watchNote()
    void this.applyNotePairs()
    await this.saveNow()
    this.emitChange()
  }

  private async openSegment(capture: AudioCapture, format: AudioFormat): Promise<void> {
    const path = await this.env.store.audioFile(this.folder, this.meta.name, this.meta.segments.length + 1, format, this.noteLang)
    this.recorder = await SegmentRecorder.create(this.env.store.fullPath(path), format, capture.sampleRate, capture.channels, (error) => this.onRecorderError(error))
    this.liveFrames = 0
    this.liveSegment = { file: path, format, startMs: this.durationMs, durationMs: 0, startedAt: new Date().toISOString(), sampleRate: capture.sampleRate, channels: capture.channels }
    if (this.asrRun?.connect) this.liveSegment.asrProvider = this.asrRun.id
    this.meta.segments.push(this.liveSegment)
    void this.writeIo(() => this.env.store.appendTranscript(this.transcriptPath, audioLine(path)))
  }

  /** Starts recognition with the recognizer resolved for this run, so settings changed between runs apply to the next one. */
  private startAsr({ connect, pacing, problem }: ResolvedLive): void {
    this.asrDetail = problem
    if (!this.asr) {
      this.asr = new AsrStreamer({
        onFinal: (u) => this.onFinal(u),
        onInterim: (list) => {
          this.interims = list
          this.trigger("interim")
        },
        onGap: (gap) => this.onGap(gap),
        onState: (state, detail) => {
          this.asrState = state
          this.asrDetail = detail ?? (state === "disabled" ? this.asrRun?.problem : undefined)
          this.emitChange()
        },
        onLogId: (id) => {
          this.meta.asrLogIds = [...this.meta.asrLogIds.slice(-49), id]
        },
      })
      this.asr.restore(this.utterances)
    }
    this.runGapStart = this.meta.gaps.length
    this.asr.begin(this.durationMs, connect, pacing)
    this.asrState = this.asr.currentState
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
    // A device that will not release must not keep the file from being closed or recognition from ending: the card says what failed.
    await capture?.close().catch((error: Error) => (this.error = error.message))
    await recorder?.close().catch((error: Error) => (this.error = t("recorder.write", error.message)))
    this.liveSegment = undefined
    await this.asr?.end()
    this.levels.fill(0)
    for (const gap of this.meta.gaps.slice(this.runGapStart)) void this.writeIo(() => this.env.store.appendTranscript(this.transcriptPath, gapLine(gap, this.noteLang)))
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
    this.error = t("session.micLost")
    await this.pause()
  }

  /** An encoder or disk failure must not lose audio: continue in a fresh WAV segment. */
  private onRecorderError(error: Error): void {
    console.error("[meeting-live]", error)
    if (this.meta.status !== "recording" || !this.capture) return
    const broken = this.recorder
    this.recorder = undefined
    const capture = this.capture
    this.error = t("session.wavFallback", error.message)
    void (async () => {
      await broken?.close().catch(() => undefined)
      if (this.liveSegment) this.liveSegment = undefined
      try {
        if (this.meta.status === "recording") await this.openSegment(capture, "wav")
      } catch (e) {
        // No new file to continue in (disk full, folder gone): frames are dropped from here on, so the status must not keep saying Recording.
        await this.pause()
        this.error = t("recorder.write", (e as Error).message)
      }
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

  /**
   * "Retry now" for a failed or waiting recognizer. The recognizer is resolved afresh, as `doStart` does, so a key corrected after a
   * fatal error applies without pausing; the buffered audio and the finals carry over. Settings that no longer resolve to a
   * recognizer leave the old connector in place and show why.
   */
  retryAsr(): void {
    if (!this.asr) return
    const resolved = this.env.asr(() => this.asrContext())
    if (!resolved.connect) {
      this.asrDetail = resolved.problem
      this.emitChange()
      return
    }
    if (!this.asr.retryNow(resolved.connect, resolved.pacing)) return
    this.asrRun = resolved
    // A stretch of audio is tagged with the provider it is sent to, which may be another one from here on.
    if (this.liveSegment) this.liveSegment.asrProvider = resolved.id
  }

  // ---------------------------------------------------------------- speech context and corrections

  /** What the recognizer is told for this meeting: the typed hotwords, and the note's names and the scene when the user agreed. */
  asrContext(): AsrContext {
    return asrContextFor(this.env.settings(), this.vocabulary, this.env.asrContextConsented())
  }

  /** The note's names and pairs. A note that cannot be read leaves what was read before (none at first): recording goes on regardless. */
  private async readVocabulary(): Promise<NoteVocabulary | undefined> {
    try {
      const note = await this.env.store.readNote(this.meta.notePath)
      return extractVocabulary(note, basename(this.meta.notePath), { ignoreLinksUnder: [this.env.settings().folder] })
    } catch (error) {
      console.warn("[meeting-live] could not read the meeting note for its names", error)
      return this.vocabulary
    }
  }

  /** The settings' table, then this meeting's own pairs. */
  private correctionTables(): Correction[][] {
    return correctionTables(this.env.settings().corrections, this.vocabulary?.corrections ?? [])
  }

  /** While the meeting is live, an edit of its note is read once the typing settles: new names for the next run, new pairs at once. */
  private watchNote(): void {
    if (this.unwatchNote) return
    this.unwatchNote = this.env.store.onNoteModified((path) => {
      if (path !== this.meta.notePath) return
      if (this.noteTimer) window.clearTimeout(this.noteTimer)
      this.noteTimer = window.setTimeout(() => void this.noteEdited(), NOTE_SETTLE_MS)
    })
  }

  private stopWatchingNote(): void {
    this.unwatchNote?.()
    this.unwatchNote = undefined
    if (this.noteTimer) window.clearTimeout(this.noteTimer)
    this.noteTimer = undefined
  }

  /**
   * Reads the note again. The plugin's own writes into the note (the summary region, the card heading) are outside what is read, so
   * they leave the names and pairs as they were, and nothing is rewritten for them.
   */
  private async noteEdited(): Promise<void> {
    this.noteTimer = undefined
    this.vocabulary = await this.readVocabulary()
    await this.applyNotePairs()
  }

  /** When the note's pairs changed, the transcript written so far is corrected with them. */
  private async applyNotePairs(): Promise<void> {
    const pairs = JSON.stringify(this.vocabulary?.corrections ?? [])
    if (pairs === this.appliedPairs) return
    this.appliedPairs = pairs
    await this.retext((text) => applyCorrections(text, this.correctionTables()))
  }

  /** Reads the note and corrects the whole transcript with the settings' table and the note's pairs; the number of sentences changed. */
  async correctTranscript(): Promise<number> {
    this.vocabulary = await this.readVocabulary()
    this.appliedPairs = JSON.stringify(this.vocabulary?.corrections ?? [])
    return this.retext((text) => applyCorrections(text, this.correctionTables()))
  }

  /**
   * Gives sentences new text and rewrites their transcript lines in place: only the text changes, the time link (which may point at a
   * summary anchor by now), the speaker and the block id stay. The number of sentences changed.
   */
  private async retext(edit: (text: string, u: Utterance) => string): Promise<number> {
    const changed = new Map<string, string>()
    for (const u of this.utterances) {
      const text = edit(u.text, u)
      if (text === u.text) continue
      u.text = text
      changed.set(blockId(u), text)
    }
    if (changed.size === 0) return 0
    this.trigger("retext")
    await this.writeIo(async () => {
      const path = this.transcriptPath
      const current = await this.env.store.readTranscript(path)
      const next = retextTranscript(current, changed)
      if (next !== current) await this.env.store.write(path, next)
    })
    return changed.size
  }

  // ---------------------------------------------------------------- transcript

  /** A final is corrected before it is kept or written, so neither the transcript nor what the summaries read has the misheard word. */
  private onFinal(final: Utterance): void {
    const u = { ...final, text: applyCorrections(final.text, this.correctionTables()) }
    const index = this.utterances.findIndex((x) => x.startMs > u.startMs)
    if (index < 0) this.utterances.push(u)
    else this.utterances.splice(index, 0, u)
    void this.writeIo(() => this.env.store.appendTranscript(this.transcriptPath, utteranceLine(u, this.noteLink)))
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
      // Records wait as pending, not failed, while consent is missing: nothing is lost, and they run once the user agrees.
      for (let record = this.nextPending(); record && this.llmConsented; record = this.nextPending()) {
        await this.runSummary(record)
        await this.updateOverview()
      }
    } catch (error) {
      // Callers start the queue and do not wait for it; what a record's own handling missed is logged, not an unhandled rejection.
      console.error("[meeting-live]", error)
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
      await this.correctWindow(record, items, llm)
      const messages = buildSummaryMessages(this.meta.title, this.env.settings().summaryFocus, record, items, previous, this.meta.overview?.content, this.noteLang)
      const text = await llm.complete(messages, { json: true })
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
    if (record.status === "done") void this.publishSummary()
  }

  /**
   * Asks the summary's model which words of the stage's window are misheard known terms, and applies the fixes that pass the checks
   * (acceptFixes) before the summary reads the window. Once per stage. A failure or a reply with nothing usable leaves the text as it
   * was and the summary goes on; with no known terms nothing is asked.
   */
  private async correctWindow(record: SummaryRecord, items: Utterance[], llm: LlmClient): Promise<void> {
    if (this.checkedStages.has(record.index) || items.length === 0) return
    this.checkedStages.add(record.index)
    this.vocabulary ??= await this.readVocabulary()
    const terms = correctionTerms(asrContextFor(this.env.settings(), this.vocabulary, true), this.correctionTables())
    if (noTerms(terms)) return
    try {
      const reply = await llm.complete(buildCorrectionMessages(items, terms, this.noteLang), { json: true })
      const fixes = acceptFixes(parseFixes(reply), items, terms)
      if (fixes.length === 0) return
      const window = new Set(items)
      await this.retext((text, u) => (window.has(u) ? applyCorrections(text, [fixes]) : text))
    } catch (error) {
      console.warn("[meeting-live] checking the transcript for misheard names failed; the summary reads it as it is", error)
    }
  }

  /** Completed stage summaries not yet merged into the overview. */
  get overviewBacklog(): SummaryRecord[] {
    const merged = new Set(this.meta.overview?.stages ?? [])
    return this.meta.summaries.filter((s) => s.status === "done" && !merged.has(s.index))
  }

  /** Merges completed stages into the overview; on failure keeps the previous overview and records the error. */
  async updateOverview(): Promise<void> {
    if (this.overviewRunning || this.overviewBacklog.length === 0) return
    this.overviewRunning = true
    try {
      for (let stages = this.overviewBacklog; stages.length; stages = this.overviewBacklog) {
        const llm = this.env.llm()
        if (llm.problem || !this.llmConsented) return
        const overview = this.meta.overview ?? { stages: [] }
        const merged = [...overview.stages, ...stages.map((s) => s.index)].sort((a, b) => a - b)
        const substantive = stages.filter((s) => !s.content || !isEmptySummary(s.content))
        if (substantive.length === 0) {
          this.meta.overview = { ...overview, stages: merged }
          continue
        }
        this.trigger("summary")
        try {
          const messages = buildOverviewMessages(this.meta.title, this.env.settings().summaryFocus, overview.content, substantive)
          const text = await llm.complete(messages, { json: true })
          let content = parseSummary(text, this.utterances)
          if (!content) throw new Error(t("session.overviewUnreadable"))
          // An overview past its limits gets one chance to fix itself; what is still over is cut to the lists' limits.
          const problems = overviewProblems(content)
          if (problems.length) {
            const retry = await llm.complete([...messages, { role: "assistant", content: text }, overviewRetryMessage(problems)], { json: true }).catch(() => "")
            content = parseSummary(retry, this.utterances) ?? content
          }
          this.meta.overview = { stages: merged, content: capOverview(content), createdAt: new Date().toISOString(), model: llm.model }
        } catch (error) {
          this.meta.overview = { ...overview, error: (error as Error).message }
          return
        }
      }
    } finally {
      this.overviewRunning = false
      this.trigger("summary")
      await this.saveNow()
      void this.publishSummary()
    }
  }

  summaryLink(ms: number): string {
    const u = this.utterances.find((x) => Math.round(x.startMs) === Math.round(ms))
    const target = this.transcriptPath.replace(/\.md$/, "")
    return u ? `[[${target}#^${blockId(u)}|${formatClock(ms)}]]` : formatClock(ms)
  }

  /** The meeting note as a link target. */
  private get noteLink(): string {
    return this.meta.notePath.replace(/\.md$/, "")
  }

  /**
   * The note section holding the overview and every finished stage (empty until a stage is done),
   * and the block each transcript line links back to: the point citing it, else its stage.
   * To-dos and open questions are listed once, under the overview; a stage the overview does not cover yet lists its own.
   */
  noteSummary(): { markdown: string; anchors: Map<number, string> } {
    const anchors = new Map<number, string>()
    const done = this.meta.summaries.filter((s) => s.status === "done")
    if (done.length === 0) return { markdown: "", anchors }
    const lang = this.noteLang
    const link = (ms: number) => this.summaryLink(ms)
    const overview = this.meta.overview?.content
    const covered = new Set(overview ? this.meta.overview?.stages : [])
    const cited = new Set<number>()
    const anchorFor = (stage?: string): LineAnchor => (point, first) => {
      const t = point?.t === undefined ? undefined : Math.round(point.t)
      const fresh = t !== undefined && !cited.has(t)
      const id = first && stage ? stage : fresh ? `${this.id}-t${t}` : undefined
      if (fresh && id) {
        cited.add(t)
        anchors.set(t, id)
      }
      return id
    }
    // The stages claim their lines first, the overview's to-dos and questions take what is left, whichever comes first in the note.
    const stages = done.map((s) => {
      const stage = `${this.id}-s${s.index}`
      for (const ms of s.utterances) if (!anchors.has(ms)) anchors.set(ms, stage)
      return summaryMarkdown(s, link, "###", anchorFor(stage), lang, !covered.has(s.index))
    })
    const index = overview ? overviewMarkdown(overview, link, "####", lang, anchorFor()) : ""
    const unverified = hasUnverified(overview) || done.some((s) => hasUnverified(s.content))
    const through = formatClock(Math.max(...done.map((s) => s.endMs)))
    const markdown = [tr(lang, "note.summaryHead", through), "", ...(index ? [index] : []), ...stages, tr(lang, "note.summaryFoot", unverified)].join("\n")
    return { markdown, anchors }
  }

  /** Writes the summaries into the meeting's note, right below its block, and links each transcript time back to them. */
  publishSummary(): Promise<unknown> {
    const { markdown, anchors } = this.noteSummary()
    const note = this.noteLink
    return this.writeIo(async () => {
      await this.env.store.editNote(this.meta.notePath, (content) => placeCardHeading(content, this.id, tr(this.noteLang, "note.cardHeading")))
      await this.env.store.editNote(this.meta.notePath, (content) => placeSummary(content, this.id, markdown))
      const path = this.transcriptPath
      const current = await this.env.store.readTranscript(path)
      const linked = linkTranscript(current, (ms) => {
        const anchor = anchors.get(ms)
        return anchor ? `${note}#^${anchor}` : note
      })
      if (linked !== current) await this.env.store.write(path, linked)
    })
  }

  // ---------------------------------------------------------------- minutes

  async generateMinutes(prompt: string, notes: { path: string; content: string }[], onProgress?: (text: string) => void): Promise<string> {
    const llm = this.env.llm()
    if (llm.problem) throw new Error(llm.problem)
    if (!this.llmConsented) throw new Error(t("session.consentNeeded"))
    if (this.utterances.length === 0) throw new Error(t("session.noTranscript"))
    this.minutes = { status: "running" }
    this.emitChange()
    try {
      const lang = this.noteLang
      const input = { title: this.meta.title, date: formatDate(new Date(this.meta.createdAt)), utterances: this.utterances, summaries: this.meta.summaries, notes, lang }
      const text = await writeMinutes(llm, prompt, input, { focus: this.env.settings().summaryFocus, onProgress })
      const path = await this.env.store.uniquePath(this.folder, meetingFile(this.meta.name, tr(lang, "note.minutesFile")), "md")
      const note = this.meta.notePath.replace(/\.md$/, "")
      const doc = [
        "---",
        `meeting: ${this.meta.id}`,
        "type: meeting-minutes",
        `note: "[[${note}]]"`,
        `date: ${this.meta.createdAt.slice(0, 10)}`,
        `transcript: "[[${this.transcriptPath.replace(/\.md$/, "")}]]"`,
        `model: ${llm.model}`,
        `generated: ${formatDateTime(new Date())}`,
        "---",
        "",
        `# ${tr(lang, "note.minutesTitle", this.meta.title)}`,
        "",
        tr(lang, "note.minutesCaution"),
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

  setCollapsed(collapsed: boolean): void {
    if (!!this.meta.collapsed === collapsed) return
    this.meta.collapsed = collapsed || undefined
    void this.saveNow()
    this.emitChange()
  }

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
    // The title is one of the names: a live meeting reads its note again under the new name.
    if (this.isLive) void this.noteEdited()
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
        this.error = t("session.saveFailed", error.message)
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
    this.stopWatchingNote()
    this.capture?.close().catch(() => undefined)
    this.recorder?.close().catch(() => undefined)
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
            console.error("[meeting-live] could not repair the recording", error)
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
