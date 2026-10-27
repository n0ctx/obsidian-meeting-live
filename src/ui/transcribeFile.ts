import { FuzzySuggestModal, Modal, Notice, TFile, setIcon, type App } from "obsidian"
import { DECODABLE_EXTENSIONS, DIRECT_FORMATS } from "../asr/fileAsr.ts"
import { DIRECT_UPLOAD_LIMIT } from "../audio/transcode.ts"
import { TranscribeJob, type AudioSource, type TranscribeDeps, type TranscribeJobs } from "./transcribeJob.ts"

const AUDIO_EXTENSIONS = [...Object.keys(DIRECT_FORMATS), ...DECODABLE_EXTENSIONS]

class AudioPicker extends FuzzySuggestModal<TFile> {
  private readonly onPick: (file: TFile) => void

  constructor(app: App, onPick: (file: TFile) => void) {
    super(app)
    this.onPick = onPick
    this.setPlaceholder("选择库中的录音文件")
  }

  getItems(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter((f) => AUDIO_EXTENSIONS.includes(f.extension.toLowerCase()))
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
    this.setTitle("录音生成访谈记录")
    const { contentEl } = this
    contentEl.createDiv({
      cls: "ml-consent-text",
      text: `先用火山引擎把录音转成带说话人的文字，再由大模型整理成完整的访谈记录，写入「${this.target.basename}」末尾，不会覆盖已有内容。笔记中已有的速记会作为核对参考。开始后在后台进行，笔记中会显示进度横条，期间可以继续写作或切换笔记。`,
    })

    const pick = contentEl.createDiv({ cls: "ml-file-pick" })
    const chosen = pick.createDiv({ cls: "ml-file-chosen" })
    const buttons = pick.createDiv({ cls: "ml-file-pick-buttons" })
    const fromVault = buttons.createEl("button", { cls: "ml-btn is-small" })
    setIcon(fromVault.createSpan({ cls: "ml-btn-icon" }), "folder-open")
    fromVault.createSpan({ text: "从库中选择" })
    const fromDisk = buttons.createEl("button", { cls: "ml-btn is-small" })
    setIcon(fromDisk.createSpan({ cls: "ml-btn-icon" }), "hard-drive")
    fromDisk.createSpan({ text: "从电脑选择" })
    const input = contentEl.createEl("input", { attr: { type: "file", accept: AUDIO_EXTENSIONS.map((e) => `.${e}`).join(","), hidden: "" } })

    const speakersRow = contentEl.createEl("label", { cls: "ml-save-default" })
    const speakers = speakersRow.createEl("input", { attr: { type: "checkbox" } })
    speakers.checked = true
    speakersRow.createSpan({ text: "区分说话人" })
    const writeRow = contentEl.createEl("label", { cls: "ml-save-default" })
    const writeUp = writeRow.createEl("input", { attr: { type: "checkbox" } })
    writeUp.checked = true
    writeRow.createSpan({ text: "用大模型整理成访谈记录（取消则只写入原始转写）" })
    const llm = this.deps.llm()
    contentEl.createDiv({
      cls: "ml-privacy",
      text: `录音会上传至火山引擎录音文件识别服务；整理时转写文本和本笔记内容会发送到 ${llm.target}，使用设置中的「纪要 Prompt」。原始转写另存在「${this.deps.transcriptFolder()}」，不受 AI 改写。超过 60 MB 或格式不受支持的录音会先在本地压缩再上传。处理期间请勿退出 Obsidian。`,
    })
    const footer = contentEl.createDiv({ cls: "modal-button-container" })
    footer.createEl("button", { text: "取消" }).addEventListener("click", () => this.close())
    const start = footer.createEl("button", { cls: "mod-cta", text: "开始" })
    start.disabled = true

    const choose = (source: AudioSource) => {
      this.source = source
      chosen.empty()
      setIcon(chosen.createSpan({ cls: "ml-note-icon" }), "audio-lines")
      chosen.createSpan({ cls: "ml-note-path", text: source.name })
      const supported = source.extension in DIRECT_FORMATS
      chosen.createSpan({ cls: "ml-count", text: `${mb(source.size)}${!supported || source.size > DIRECT_UPLOAD_LIMIT ? " · 将先压缩" : ""}` })
      start.disabled = false
    }
    chosen.createSpan({ cls: "ml-count", text: "尚未选择录音" })
    fromVault.addEventListener("click", () =>
      new AudioPicker(this.app, (file) =>
        choose({ name: file.name, extension: file.extension.toLowerCase(), size: file.stat.size, modified: file.stat.mtime, vaultPath: file.path, read: async () => new Uint8Array(await this.app.vault.readBinary(file)) }),
      ).open(),
    )
    fromDisk.addEventListener("click", () => input.click())
    input.addEventListener("change", () => {
      const file = input.files?.[0]
      if (!file) return
      choose({ name: file.name, extension: file.name.split(".").pop()?.toLowerCase() ?? "", size: file.size, modified: file.lastModified, read: async () => new Uint8Array(await file.arrayBuffer()) })
    })

    start.addEventListener("click", () => {
      const source = this.source
      if (!source) return
      const { auth, problem } = this.deps.auth()
      if (!auth) return void new Notice(problem ?? "未配置火山引擎凭证")
      const llmProblem = writeUp.checked ? this.deps.llm().problem : undefined
      if (llmProblem) return void new Notice(`${llmProblem}。可在设置中配置模型，或取消「用大模型整理」只写入原始转写`)
      void this.jobs.start(new TranscribeJob(this.app, this.deps, this.target, source, auth, { speakers: speakers.checked, writeUp: writeUp.checked }))
      this.close()
    })
  }

  override onClose(): void {
    this.contentEl.empty()
  }
}
