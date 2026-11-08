import { Events, Notice, TFile, type App } from "obsidian"
import { t, tr, type Key, type Lang } from "../i18n/index.ts"
import { transcribeChunks, type ChunkResults } from "../asr/chunked.ts"
import { renderInterviewRecord, speakerUtterances, type FileAsrGet, type FileAsrPost, type FileAsrProvider, type FileAsrResult } from "../asr/fileAsr.ts"
import { appendJobBlock, hasJobBlock, newJobId, placeJobResult, removeJobBlock } from "../asr/jobBlock.ts"
import { providerNameIn } from "../asr/providers/registry.ts"
import type { Destination } from "../consent.ts"
import { prepareChunks, type AudioChunk } from "../audio/transcode.ts"
import type { LlmClient } from "../llm/client.ts"
import { writeMinutes } from "../llm/contextGuard.ts"
import { stripMeetingBlocks } from "../llm/minutes.ts"
import { formatClock, formatDate, formatDateTime } from "../meeting/types.ts"

export interface AudioSource {
  name: string
  extension: string
  size: number
  /** Last-modified time, used as the interview date. */
  modified: number
  vaultPath?: string
  read: () => Promise<Uint8Array>
}

export interface TranscribeDeps {
  /** Asks the user to agree to the destinations of these kinds, if they have not; false when declined. */
  ensureConsent: (kinds: Destination["kind"][]) => Promise<boolean>
  /** The recorded-file recognizer, resolved from the current settings. */
  fileAsr: () => FileAsrProvider
  post: FileAsrPost
  get?: FileAsrGet
  llm: () => LlmClient
  prompt: () => string
  /** The summary focus the condensing step of a long transcript uses. */
  summaryFocus: () => string
  /** Vault folder for raw transcripts produced by this command. */
  transcriptFolder: () => string
  /** Language of what is written into notes and files. */
  noteLang: () => Lang
}

export type JobStage = "reading" | "uploading" | "recognizing" | "writing" | "done" | "failed"

const STAGE_LABEL = { reading: "job.reading", uploading: "job.uploading", recognizing: "job.recognizing", writing: "job.writing", done: "job.done", failed: "job.failed" } as const satisfies Record<JobStage, Key>

const normalizeFolder = (path: string, lang: Lang) => path.trim().replace(/^\/+|\/+$/g, "") || `Meetings/${tr(lang, "note.transcriptFolder")}`

/** One recording → raw transcript → interview record, running independently of any modal. */
export class TranscribeJob {
  readonly id = newJobId()
  stage: JobStage = "reading"
  stageStartedAt = Date.now()
  error: string | undefined
  readonly target: TFile
  readonly source: AudioSource
  readonly writeUp: boolean
  private readonly app: App
  private readonly deps: TranscribeDeps
  private readonly file: FileAsrProvider
  private readonly speakers: boolean
  /** Kept after a failed write-up so a retry does not re-run (and re-bill) recognition. */
  private transcribed: { result: FileAsrResult; rawPath: string } | undefined
  /** A recording cut into pieces and what was recognized of them so far, so a retry continues instead of paying for the first pieces again. */
  private pieces: { chunks: AudioChunk[]; done: ChunkResults } | undefined
  /** Which piece is being uploaded, when the recording was cut into several. */
  part: { index: number; total: number } | undefined
  onChange: (() => void) | undefined

  constructor(app: App, deps: TranscribeDeps, target: TFile, source: AudioSource, file: FileAsrProvider, options: { speakers: boolean; writeUp: boolean }) {
    this.app = app
    this.deps = deps
    this.target = target
    this.source = source
    this.file = file
    this.speakers = options.speakers
    this.writeUp = options.writeUp
  }

  /**
   * Starts the job, or restarts it after a failure, once the user has agreed to where it sends data: the recognizer unless
   * its result is already in hand, and the model when it writes up. A refusal sends nothing and leaves the job as it was.
   */
  async launch(jobs: TranscribeJobs): Promise<boolean> {
    const kinds: Destination["kind"][] = [...(this.recognized ? [] : (["file"] as const)), ...(this.writeUp ? (["llm"] as const) : [])]
    if (!(await this.deps.ensureConsent(kinds))) return false
    await jobs.start(this)
    return true
  }

  get finished(): boolean {
    return this.stage === "done" || this.stage === "failed"
  }

  /** Status-bar text, e.g. "Recognizing 01:20". */
  get label(): string {
    const elapsed = this.stage === "recognizing" || this.stage === "writing" ? ` ${formatClock(Date.now() - this.stageStartedAt)}` : ""
    const part = this.part && this.part.total > 1 && (this.stage === "uploading" || this.stage === "recognizing") ? ` ${this.part.index + 1}/${this.part.total}` : ""
    return `${t(STAGE_LABEL[this.stage])}${part}${elapsed}`
  }

  get recognized(): boolean {
    return !!this.transcribed
  }

  /** Stage the job reached before failing, for the step indicator. */
  failedAt: JobStage | undefined

  private setStage(stage: JobStage): void {
    if (this.stage !== stage) this.stageStartedAt = Date.now()
    this.stage = stage
    this.onChange?.()
  }

  async run(): Promise<void> {
    this.error = undefined
    try {
      if (!this.transcribed) {
        this.setStage("reading")
        this.pieces ??= { chunks: await prepareChunks(await this.source.read(), this.source.extension, { directFormats: this.file.directFormats, maxBytes: this.file.capabilities.fileSizeLimit }), done: [] }
        const result = await transcribeChunks(
          this.file,
          this.pieces.chunks,
          {
            speakers: this.speakers,
            post: this.deps.post,
            get: this.deps.get,
            onStage: (s) => this.setStage(s.stage === "uploading" ? "uploading" : "recognizing"),
            onPart: (index, total) => {
              this.part = { index, total }
              this.onChange?.()
            },
          },
          this.pieces.done,
        )
        this.pieces = undefined
        const rawPath = this.writeUp ? await this.saveRawTranscript(result) : ""
        this.transcribed = { result, rawPath }
      }
      if (this.writeUp) await this.writeRecord(this.transcribed)
      else await this.appendTranscript(this.transcribed.result)
      this.setStage("done")
    } catch (error) {
      this.error = (error as Error).message
      this.failedAt = this.stage
      this.setStage("failed")
    }
  }

  private async saveRawTranscript(result: FileAsrResult): Promise<string> {
    const lang = this.deps.noteLang()
    const folder = normalizeFolder(this.deps.transcriptFolder(), lang)
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder)
    const title = tr(lang, "note.rawTranscript", this.target.basename)
    const base = `${folder}/${title}`
    let path = `${base}.md`
    for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = `${base} ${n}.md`
    const body = renderInterviewRecord(result, { title, source: this.source.name, vaultPath: this.source.vaultPath, transcribedAt: formatDateTime(new Date()), lang, provider: providerNameIn(this.file.id, lang), model: this.file.model }, true)
    await this.app.vault.create(path, `---\ntype: audio-transcript\nnote: "[[${this.target.path.replace(/\.md$/, "")}]]"\ndate: ${formatDate(new Date(this.source.modified))}\nsource: "${this.source.name}"\nprovider: ${this.file.id}\n---\n\n${body}`)
    return path
  }

  private async writeRecord(done: { result: FileAsrResult; rawPath: string }): Promise<void> {
    const llm = this.deps.llm()
    if (llm.problem) throw new Error(llm.problem)
    const lang = this.deps.noteLang()
    this.setStage("writing")
    const notes = stripMeetingBlocks(await this.app.vault.read(this.target))
    const speakerNote = done.result.utterances.some((u) => u.speaker) && (done.result.chunks ?? 1) > 1 ? `Note: the recording was recognized in ${done.result.chunks} separate parts, so speaker numbers may not refer to the same person in different parts.` : undefined
    const input = { title: this.target.basename, date: formatDate(new Date(this.source.modified)), utterances: speakerUtterances(done.result, lang), summaries: [], notes: notes ? [{ path: this.target.path, content: notes }] : [], speakerNote, lang }
    const text = await writeMinutes(llm, this.deps.prompt(), input, { focus: this.deps.summaryFocus() })
    const raw = done.rawPath.replace(/\.md$/, "")
    const lines = [
      tr(lang, "note.writeUpInfo", llm.model, this.source.name, done.result.durationMs ? formatClock(done.result.durationMs, true) : "", formatDateTime(new Date())),
      tr(lang, "note.rawLink", `[[${raw}|${raw.split("/").pop()}]]`),
      "",
    ]
    if (this.source.vaultPath) lines.push(`![[${this.source.vaultPath}]]`, "")
    lines.push(text.trim(), "")
    await this.place(lines.join("\n"))
  }

  private async appendTranscript(result: FileAsrResult): Promise<void> {
    const lang = this.deps.noteLang()
    const record = renderInterviewRecord(
      result,
      { title: this.target.basename, source: this.source.name, vaultPath: this.source.vaultPath, transcribedAt: formatDateTime(new Date()), lang, provider: providerNameIn(this.file.id, lang), model: this.file.model },
      false,
    )
    await this.place(record)
  }

  /** Writes the result where the status bar sits, so text typed meanwhile stays where it is. */
  private async place(result: string): Promise<void> {
    if (!this.app.vault.getAbstractFileByPath(this.target.path)) throw new Error(t("job.noteGone", this.target.basename))
    await this.app.vault.process(this.target, (content) => placeJobResult(content, this.id, result, `# ${this.target.basename}`))
  }

  /** Inserts the in-note status bar unless it is already there (e.g. on retry). */
  async showBar(): Promise<void> {
    await this.app.vault.process(this.target, (content) => (hasJobBlock(content, this.id) ? content : appendJobBlock(content, this.id, this.source.name)))
  }

  async removeBar(): Promise<void> {
    await this.app.vault.process(this.target, (content) => removeJobBlock(content, this.id))
  }

  /** Path of the saved raw transcript, available once recognition finished. */
  get rawPath(): string | undefined {
    return this.transcribed?.rawPath || undefined
  }
}

/** Runs transcription jobs in the background and reports them in the status bar and notices. */
export class TranscribeJobs extends Events {
  private readonly app: App
  private readonly statusEl: HTMLElement
  private readonly jobs = new Set<TranscribeJob>()
  /** Finished-with-error jobs stay addressable so their in-note bar can offer a retry. */
  private readonly known = new Map<string, TranscribeJob>()

  constructor(app: App, statusEl: HTMLElement) {
    super()
    this.app = app
    this.statusEl = statusEl
    statusEl.addClass("ml-statusbar", "ml-jobs", "mod-clickable")
    statusEl.addEventListener("click", () => {
      const first = [...this.jobs][0]
      if (first) void this.app.workspace.openLinkText(first.target.path, "", false)
    })
    this.render()
  }

  get running(): number {
    return this.jobs.size
  }

  get(id: string): TranscribeJob | undefined {
    return this.known.get(id)
  }

  async start(job: TranscribeJob): Promise<void> {
    this.jobs.add(job)
    this.known.set(job.id, job)
    job.onChange = () => {
      this.render()
      this.trigger("change", job)
    }
    try {
      await job.showBar()
    } catch (error) {
      this.jobs.delete(job)
      new Notice(t("job.cannotWrite", (error as Error).message))
      return
    }
    this.render()
    void job.run().then(() => this.finish(job))
  }

  async dismiss(job: TranscribeJob): Promise<void> {
    this.known.delete(job.id)
    await job.removeBar()
  }

  private finish(job: TranscribeJob): void {
    this.jobs.delete(job)
    if (job.stage === "done") this.known.delete(job.id)
    this.render()
    this.trigger("change", job)
    const fragment = createFragment()
    if (job.stage === "done") {
      fragment.createDiv({ text: t("job.written", job.source.name, job.target.basename) })
      this.noticeButton(fragment, t("common.openNote"), () => void this.app.workspace.openLinkText(job.target.path, "", false))
      new Notice(fragment, 8000)
      return
    }
    fragment.createDiv({ text: t("job.processFailed", job.source.name, job.error ?? "") })
    fragment.createDiv({ text: t("job.retryInNote") })
    this.noticeButton(fragment, t("common.openNote"), () => void this.app.workspace.openLinkText(job.target.path, "", false))
    new Notice(fragment, 15000)
  }

  private noticeButton(fragment: DocumentFragment, text: string, action: () => void): void {
    const button = fragment.createEl("button", { cls: "ml-notice-btn", text })
    button.addEventListener("click", (event) => {
      event.stopPropagation()
      action()
    })
  }

  /** Called every second by the plugin so elapsed times stay current. */
  render(): void {
    const jobs = [...this.jobs]
    this.statusEl.toggleClass("is-active", jobs.length > 0)
    if (jobs.length === 0) {
      this.statusEl.empty()
      return
    }
    const first = jobs[0]
    const more = jobs.length > 1 ? t("job.more", jobs.length - 1) : ""
    this.statusEl.setText(t("job.statusBar", first.target.basename, first.label, more))
    this.statusEl.setAttr("aria-label", t("job.statusBarAria"))
  }
}
