import { Events, Notice, TFile, type App } from "obsidian"
import { renderInterviewRecord, speakerUtterances, transcribeFile, type FileAsrAuth, type FileAsrPost, type FileAsrResult } from "../asr/fileAsr.ts"
import { appendJobBlock, hasJobBlock, newJobId, placeJobResult, removeJobBlock } from "../asr/jobBlock.ts"
import { prepareAudio } from "../audio/transcode.ts"
import type { LlmClient } from "../llm/client.ts"
import { buildMinutesMessages, stripMeetingBlocks } from "../llm/minutes.ts"
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
  auth: () => { auth?: FileAsrAuth; problem?: string }
  post: FileAsrPost
  llm: () => LlmClient
  prompt: () => string
  /** Vault folder for raw transcripts produced by this command. */
  transcriptFolder: () => string
}

export type JobStage = "reading" | "uploading" | "recognizing" | "writing" | "done" | "failed"

export const STAGE_LABEL: Record<JobStage, string> = {
  reading: "读取录音",
  uploading: "上传中",
  recognizing: "识别中",
  writing: "整理中",
  done: "已完成",
  failed: "失败",
}

const normalizeFolder = (path: string) => path.trim().replace(/^\/+|\/+$/g, "") || "Meetings/录音转写"

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
  private readonly auth: FileAsrAuth
  private readonly speakers: boolean
  /** Kept after a failed write-up so a retry does not re-run (and re-bill) recognition. */
  private transcribed: { result: FileAsrResult; rawPath: string } | undefined
  onChange: (() => void) | undefined

  constructor(app: App, deps: TranscribeDeps, target: TFile, source: AudioSource, auth: FileAsrAuth, options: { speakers: boolean; writeUp: boolean }) {
    this.app = app
    this.deps = deps
    this.target = target
    this.source = source
    this.auth = auth
    this.speakers = options.speakers
    this.writeUp = options.writeUp
  }

  get finished(): boolean {
    return this.stage === "done" || this.stage === "failed"
  }

  /** Status-bar text, e.g. "识别中 01:20". */
  get label(): string {
    const elapsed = this.stage === "recognizing" || this.stage === "writing" ? ` ${formatClock(Date.now() - this.stageStartedAt)}` : ""
    return `${STAGE_LABEL[this.stage]}${elapsed}`
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
        const audio = await prepareAudio(await this.source.read(), this.source.extension)
        const result = await transcribeFile(this.auth, audio, {
          speakers: this.speakers,
          post: this.deps.post,
          onStage: (s) => this.setStage(s.stage === "uploading" ? "uploading" : "recognizing"),
        })
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
    const folder = normalizeFolder(this.deps.transcriptFolder())
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder)
    const base = `${folder}/${formatDate(new Date(this.source.modified))} ${this.target.basename} 原始转写`
    let path = `${base}.md`
    for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = `${base} ${n}.md`
    const body = renderInterviewRecord(result, { title: `${this.target.basename} 原始转写`, source: this.source.name, vaultPath: this.source.vaultPath, transcribedAt: formatDateTime(new Date()), resourceId: this.auth.resourceId }, true)
    await this.app.vault.create(path, `---\ntype: audio-transcript\nnote: "[[${this.target.path.replace(/\.md$/, "")}]]"\nsource: "${this.source.name}"\n---\n\n${body}`)
    return path
  }

  private async writeRecord(done: { result: FileAsrResult; rawPath: string }): Promise<void> {
    const llm = this.deps.llm()
    if (llm.problem) throw new Error(llm.problem)
    this.setStage("writing")
    const notes = stripMeetingBlocks(await this.app.vault.read(this.target))
    const messages = buildMinutesMessages(this.deps.prompt(), {
      title: this.target.basename,
      date: formatDate(new Date(this.source.modified)),
      utterances: speakerUtterances(done.result),
      summaries: [],
      notes: notes ? [{ path: this.target.path, content: notes }] : [],
    })
    const text = await llm.complete(messages)
    const raw = done.rawPath.replace(/\.md$/, "")
    const lines = [
      `> [!info] 访谈记录由 ${llm.model} 根据录音「${this.source.name}」的转写整理（时长 ${formatClock(done.result.durationMs, true)}，${formatDateTime(new Date())}）。发布前请对照原始转写核实关键事实与数字。`,
      `> 原始转写：[[${raw}|${raw.split("/").pop()}]]`,
      "",
    ]
    if (this.source.vaultPath) lines.push(`![[${this.source.vaultPath}]]`, "")
    lines.push(text.trim(), "")
    await this.place(lines.join("\n"))
  }

  private async appendTranscript(result: FileAsrResult): Promise<void> {
    const record = renderInterviewRecord(
      result,
      { title: this.target.basename, source: this.source.name, vaultPath: this.source.vaultPath, transcribedAt: formatDateTime(new Date()), resourceId: this.auth.resourceId },
      false,
    )
    await this.place(record)
  }

  /** Writes the result where the status bar sits, so text typed meanwhile stays where it is. */
  private async place(result: string): Promise<void> {
    if (!this.app.vault.getAbstractFileByPath(this.target.path)) throw new Error(`目标笔记「${this.target.basename}」已被移动或删除`)
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
      new Notice(`无法写入笔记：${(error as Error).message}`)
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
      fragment.createDiv({ text: `「${job.source.name}」已写入「${job.target.basename}」` })
      this.noticeButton(fragment, "打开笔记", () => void this.app.workspace.openLinkText(job.target.path, "", false))
      new Notice(fragment, 8000)
      return
    }
    fragment.createDiv({ text: `「${job.source.name}」处理失败：${job.error}` })
    fragment.createDiv({ text: "可以在笔记中的状态横条上重试。" })
    this.noticeButton(fragment, "打开笔记", () => void this.app.workspace.openLinkText(job.target.path, "", false))
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
    const more = jobs.length > 1 ? `（另有 ${jobs.length - 1} 个）` : ""
    this.statusEl.setText(`访谈记录 · ${first.target.basename} · ${first.label}${more}`)
    this.statusEl.setAttr("aria-label", "录音转写在后台进行，点击打开目标笔记")
  }
}
