import { FuzzySuggestModal, Modal, Notice, TFile, setIcon, type App } from "obsidian"
import { DECODABLE_EXTENSIONS } from "../audio/transcode.ts"
import { t } from "../i18n/index.ts"
import { TranscribeJob, type AudioSource, type TranscribeDeps, type TranscribeJobs } from "./transcribeJob.ts"

class AudioPicker extends FuzzySuggestModal<TFile> {
  private readonly extensions: string[]
  private readonly onPick: (file: TFile) => void

  constructor(app: App, extensions: string[], onPick: (file: TFile) => void) {
    super(app)
    this.extensions = extensions
    this.onPick = onPick
    this.setPlaceholder(t("transcribe.pickPlaceholder"))
  }

  getItems(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter((f) => this.extensions.includes(f.extension.toLowerCase()))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
  }

  getItemText(file: TFile): string {
    return file.path
  }

  onChooseItem(file: TFile): void {
    this.onPick(file)
  }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** Picks a recording and hands it to a background job that writes the result into the note. */
export class TranscribeFileModal extends Modal {
  private readonly deps: TranscribeDeps
  private readonly jobs: TranscribeJobs
  private readonly target: TFile
  private source: AudioSource | undefined

  constructor(app: App, deps: TranscribeDeps, jobs: TranscribeJobs, target: TFile) {
    super(app)
    this.deps = deps
    this.jobs = jobs
    this.target = target
  }

  override onOpen(): void {
    this.modalEl.addClass("ml-modal")
    this.setTitle(t("transcribe.title"))
    const { contentEl } = this
    const asr = this.deps.fileAsr()
    const extensions = [...Object.keys(asr.directFormats), ...DECODABLE_EXTENSIONS]
    contentEl.createDiv({
      cls: "ml-consent-text",
      text: t("transcribe.intro", asr.name, asr.capabilities.diarization, this.target.basename),
    })

    const pick = contentEl.createDiv({ cls: "ml-file-pick" })
    const chosen = pick.createDiv({ cls: "ml-file-chosen" })
    const buttons = pick.createDiv({ cls: "ml-file-pick-buttons" })
    const fromVault = buttons.createEl("button", { cls: "ml-btn is-small" })
    setIcon(fromVault.createSpan({ cls: "ml-btn-icon" }), "folder-open")
    fromVault.createSpan({ text: t("transcribe.pickVault") })
    const fromDisk = buttons.createEl("button", { cls: "ml-btn is-small" })
    setIcon(fromDisk.createSpan({ cls: "ml-btn-icon" }), "hard-drive")
    fromDisk.createSpan({ text: t("transcribe.pickDisk") })
    const input = contentEl.createEl("input", { attr: { type: "file", accept: extensions.map((e) => `.${e}`).join(","), hidden: "" } })

    const speakersRow = contentEl.createEl("label", { cls: "ml-save-default" })
    const speakers = speakersRow.createEl("input", { attr: { type: "checkbox" } })
    speakers.checked = asr.capabilities.diarization
    speakers.disabled = !asr.capabilities.diarization
    speakersRow.createSpan({ text: t("transcribe.speakers") })
    const writeRow = contentEl.createEl("label", { cls: "ml-save-default" })
    const writeUp = writeRow.createEl("input", { attr: { type: "checkbox" } })
    writeUp.checked = true
    writeRow.createSpan({ text: t("transcribe.writeUp") })
    const llm = this.deps.llm()
    contentEl.createDiv({
      cls: "ml-privacy",
      text: t("transcribe.privacy", asr.name, asr.host, llm.target, this.deps.transcriptFolder(), Math.round(asr.capabilities.fileSizeLimit / 1024 / 1024)),
    })
    const footer = contentEl.createDiv({ cls: "modal-button-container" })
    footer.createEl("button", { text: t("common.cancel") }).addEventListener("click", () => this.close())
    const start = footer.createEl("button", { cls: "mod-cta", text: t("transcribe.start") })
    start.disabled = true

    const choose = (source: AudioSource) => {
      this.source = source
      chosen.empty()
      setIcon(chosen.createSpan({ cls: "ml-note-icon" }), "audio-lines")
      chosen.createSpan({ cls: "ml-note-path", text: source.name })
      const supported = source.extension in asr.directFormats
      chosen.createSpan({ cls: "ml-count", text: `${mb(source.size)}${!supported || source.size > asr.capabilities.fileSizeLimit ? t("transcribe.compress") : ""}` })
      start.disabled = false
    }
    chosen.createSpan({ cls: "ml-count", text: t("transcribe.none") })
    fromVault.addEventListener("click", () =>
      new AudioPicker(this.app, extensions, (picked) =>
        choose({ name: picked.name, extension: picked.extension.toLowerCase(), size: picked.stat.size, modified: picked.stat.mtime, vaultPath: picked.path, read: async () => new Uint8Array(await this.app.vault.readBinary(picked)) }),
      ).open(),
    )
    fromDisk.addEventListener("click", () => input.click())
    input.addEventListener("change", () => {
      const file = input.files?.[0]
      if (!file) return
      choose({ name: file.name, extension: file.name.split(".").pop()?.toLowerCase() ?? "", size: file.size, modified: file.lastModified, read: async () => new Uint8Array(await file.arrayBuffer()) })
    })

    start.addEventListener("click", async () => {
      const source = this.source
      if (!source) return
      const current = this.deps.fileAsr()
      if (current.problem) return void new Notice(current.problem)
      const llmProblem = writeUp.checked ? this.deps.llm().problem : undefined
      if (llmProblem) return void new Notice(t("transcribe.llmProblem", llmProblem))
      const job = new TranscribeJob(this.app, this.deps, this.target, source, current, { speakers: speakers.checked, writeUp: writeUp.checked })
      start.disabled = true
      if (await job.launch(this.jobs)) this.close()
      else start.disabled = false
    })
  }

  override onClose(): void {
    this.contentEl.empty()
  }
}
