import { FuzzySuggestModal, Modal, Notice, TFile, setIcon, type App } from "obsidian"
import { DEFAULT_MINUTES_PROMPT, stripMeetingBlocks } from "../llm/minutes.ts"
import type { MeetingSession } from "../meeting/session.ts"

export class ConsentModal extends Modal {
  private resolve: (ok: boolean) => void = () => undefined
  private readonly llmTarget: string

  constructor(app: App, llmTarget: string) {
    super(app)
    this.llmTarget = llmTarget
  }

  ask(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve
      this.open()
    })
  }

  override onOpen(): void {
    this.modalEl.addClass("ml-modal")
    this.setTitle("开始前请确认数据去向")
    const list = this.contentEl.createDiv({ cls: "ml-consent" })
    const item = (icon: string, title: string, text: string) => {
      const row = list.createDiv({ cls: "ml-consent-row" })
      setIcon(row.createSpan({ cls: "ml-consent-icon" }), icon)
      const t = row.createDiv()
      t.createDiv({ cls: "ml-consent-title", text: title })
      t.createDiv({ cls: "ml-consent-text", text })
    }
    item("hard-drive", "原始录音只保存在本地", "录音、原始转写和会议元数据写入当前 Vault 的会议目录，插件不会上传录音文件。")
    item("captions", "音频实时上传至火山引擎", "录音时，音频流会实时发送到字节跳动火山引擎语音识别服务（openspeech.bytedance.com）进行转写。")
    item("sparkles", "转写文本发送至 LLM 服务", `阶段摘要和正式纪要会把转写文本与所选笔记发送到你配置的模型服务：${this.llmTarget}。`)
    list.createDiv({ cls: "ml-consent-note", text: "请确保已获得参会者对录音和使用云端服务处理的同意。此确认只需进行一次。" })
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" })
    buttons.createEl("button", { text: "取消" }).addEventListener("click", () => this.close())
    const ok = buttons.createEl("button", { cls: "mod-cta", text: "同意并开始" })
    ok.addEventListener("click", () => {
      this.resolve(true)
      this.resolve = () => undefined
      this.close()
    })
  }

  override onClose(): void {
    this.resolve(false)
    this.contentEl.empty()
  }
}

class NotePicker extends FuzzySuggestModal<TFile> {
  private readonly onPick: (file: TFile) => void

  constructor(app: App, onPick: (file: TFile) => void) {
    super(app)
    this.onPick = onPick
    this.setPlaceholder("选择要作为手动笔记参考的笔记")
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime)
  }

  getItemText(file: TFile): string {
    return file.path
  }

  onChooseItem(file: TFile): void {
    this.onPick(file)
  }
}

export class MinutesModal extends Modal {
  private readonly session: MeetingSession
  private readonly defaultPrompt: string
  private readonly target: string
  private readonly onSavePrompt: (prompt: string) => void
  private readonly onDone: (path: string) => void
  private readonly notes = new Set<string>()

  constructor(app: App, session: MeetingSession, options: { prompt: string; target: string; onSavePrompt: (p: string) => void; onDone: (path: string) => void }) {
    super(app)
    this.session = session
    this.defaultPrompt = options.prompt
    this.target = options.target
    this.onSavePrompt = options.onSavePrompt
    this.onDone = options.onDone
    if (app.vault.getAbstractFileByPath(session.meta.notePath) instanceof TFile) this.notes.add(session.meta.notePath)
  }

  override onOpen(): void {
    this.modalEl.addClass("ml-modal", "ml-minutes-modal")
    this.setTitle("生成正式纪要")
    const { contentEl, session } = this
    const chars = session.utterances.reduce((n, u) => n + u.text.length, 0)
    const done = session.meta.summaries.filter((s) => s.status === "done").length
    const stats = contentEl.createDiv({ cls: "ml-sources" })
    const stat = (value: string, label: string) => {
      const s = stats.createDiv({ cls: "ml-source-stat" })
      s.createDiv({ cls: "ml-source-value", text: value })
      s.createDiv({ cls: "ml-source-label", text: label })
    }
    stat(`${session.utterances.length}`, `段原始转写 · ${chars.toLocaleString()} 字`)
    stat(`${done}`, "段 AI 阶段摘要（仅供核对）")
    if (session.meta.gaps.length) stat(`${session.meta.gaps.length}`, "处转写缺口")

    contentEl.createDiv({ cls: "ml-field-label", text: "手动笔记（用于核对事实与专有名词）" })
    const noteList = contentEl.createDiv({ cls: "ml-note-list" })
    const renderNotes = () => {
      noteList.empty()
      for (const path of this.notes) {
        const row = noteList.createDiv({ cls: "ml-note-row" })
        setIcon(row.createSpan({ cls: "ml-note-icon" }), "notebook-pen")
        row.createSpan({ cls: "ml-note-path", text: path })
        const remove = row.createEl("button", { cls: "ml-icon-btn", attr: { "aria-label": "移除" } })
        setIcon(remove, "x")
        remove.addEventListener("click", () => {
          this.notes.delete(path)
          renderNotes()
        })
      }
      const add = noteList.createEl("button", { cls: "ml-btn is-small is-ghost" })
      setIcon(add.createSpan({ cls: "ml-btn-icon" }), "plus")
      add.createSpan({ text: "添加笔记" })
      add.addEventListener("click", () =>
        new NotePicker(this.app, (file) => {
          this.notes.add(file.path)
          renderNotes()
        }).open(),
      )
    }
    renderNotes()

    const promptHead = contentEl.createDiv({ cls: "ml-field-head" })
    promptHead.createDiv({ cls: "ml-field-label", text: "纪要 Prompt" })
    const reset = promptHead.createEl("button", { cls: "ml-link", text: "恢复默认" })
    const prompt = contentEl.createEl("textarea", { cls: "ml-prompt" })
    prompt.value = this.defaultPrompt
    reset.addEventListener("click", () => (prompt.value = DEFAULT_MINUTES_PROMPT))
    const saveRow = contentEl.createEl("label", { cls: "ml-save-default" })
    const save = saveRow.createEl("input", { attr: { type: "checkbox" } })
    saveRow.createSpan({ text: "保存为默认 Prompt" })

    contentEl.createDiv({ cls: "ml-privacy", text: `转写、摘要和所选笔记会发送到 ${this.target}。结果保存为会议目录中的新文档，不会覆盖已有纪要或原始资料。` })
    const status = contentEl.createDiv({ cls: "ml-modal-status" })
    const buttons = contentEl.createDiv({ cls: "modal-button-container" })
    buttons.createEl("button", { text: "取消" }).addEventListener("click", () => this.close())
    const go = buttons.createEl("button", { cls: "mod-cta", text: "生成" })
    go.disabled = session.utterances.length === 0
    go.addEventListener("click", () => void generate())
    const generate = async () => {
      if (save.checked) this.onSavePrompt(prompt.value)
      go.disabled = true
      go.setText("生成中…")
      status.setText("正在等待模型返回，长会议可能需要一两分钟。可以关闭此窗口，完成后会提示。")
      const notes: { path: string; content: string }[] = []
      for (const path of this.notes) {
        const file = this.app.vault.getAbstractFileByPath(path)
        if (file instanceof TFile) notes.push({ path, content: stripMeetingBlocks(await this.app.vault.cachedRead(file)) })
      }
      session
        .generateMinutes(prompt.value, notes)
        .then((path) => {
          new Notice("正式纪要已生成")
          this.onDone(path)
          this.close()
        })
        .catch((error: Error) => {
          new Notice(`纪要生成失败：${error.message}`)
          status.setText(error.message)
          status.addClass("is-error")
          go.disabled = false
          go.setText("重试")
        })
    }
  }

  override onClose(): void {
    this.contentEl.empty()
  }
}
