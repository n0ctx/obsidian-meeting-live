import { FuzzySuggestModal, Modal, Notice, TFile, setIcon, type App } from "obsidian"
import { t } from "../i18n/index.ts"
import { DEFAULT_MINUTES_PROMPT, stripMeetingBlocks } from "../llm/minutes.ts"
import type { Destination } from "../consent.ts"
import type { MeetingSession } from "../meeting/session.ts"

export class ConsentModal extends Modal {
  private resolve: (ok: boolean) => void = () => undefined
  private readonly destinations: Destination[]

  constructor(app: App, destinations: Destination[]) {
    super(app)
    this.destinations = destinations
  }

  ask(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve
      this.open()
    })
  }

  override onOpen(): void {
    this.modalEl.addClass("ml-modal")
    this.setTitle(t("consent.title"))
    const list = this.contentEl.createDiv({ cls: "ml-consent" })
    const item = (icon: string, title: string, text: string) => {
      const row = list.createDiv({ cls: "ml-consent-row" })
      setIcon(row.createSpan({ cls: "ml-consent-icon" }), icon)
      const body = row.createDiv()
      body.createDiv({ cls: "ml-consent-title", text: title })
      body.createDiv({ cls: "ml-consent-text", text })
    }
    item("hard-drive", t("consent.local.title"), t("consent.local.text"))
    for (const d of this.destinations) {
      if (d.kind === "live") item("captions", t("consent.live.title", d.name), t("consent.live.text", d.name, d.host))
      else if (d.kind === "file") item("file-audio", t("consent.file.title", d.name), t("consent.file.text", d.name, d.host))
      else item("send", t("consent.llm.title"), t("consent.llm.text", d.host, d.detail ?? ""))
    }
    list.createDiv({ cls: "ml-consent-note", text: t("consent.note") })
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" })
    buttons.createEl("button", { text: t("common.cancel") }).addEventListener("click", () => this.close())
    const ok = buttons.createEl("button", { cls: "mod-cta", text: t("consent.accept") })
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
    this.setPlaceholder(t("minutes.pickNote"))
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
    this.setTitle(t("minutes.title"))
    const { contentEl, session } = this
    const chars = session.utterances.reduce((n, u) => n + u.text.length, 0)
    const done = session.meta.summaries.filter((s) => s.status === "done").length
    const stats = contentEl.createDiv({ cls: "ml-sources" })
    const stat = (value: string, label: string) => {
      const s = stats.createDiv({ cls: "ml-source-stat" })
      s.createDiv({ cls: "ml-source-value", text: value })
      s.createDiv({ cls: "ml-source-label", text: label })
    }
    stat(`${session.utterances.length}`, t("minutes.stat.segments", chars.toLocaleString()))
    stat(`${done}`, t("minutes.stat.summaries"))
    if (session.meta.gaps.length) stat(`${session.meta.gaps.length}`, t("minutes.stat.gaps"))

    contentEl.createDiv({ cls: "ml-field-label", text: t("minutes.notes") })
    const noteList = contentEl.createDiv({ cls: "ml-note-list" })
    const renderNotes = () => {
      noteList.empty()
      for (const path of this.notes) {
        const row = noteList.createDiv({ cls: "ml-note-row" })
        setIcon(row.createSpan({ cls: "ml-note-icon" }), "notebook-pen")
        row.createSpan({ cls: "ml-note-path", text: path })
        const remove = row.createEl("button", { cls: "ml-icon-btn", attr: { "aria-label": t("common.remove") } })
        setIcon(remove, "x")
        remove.addEventListener("click", () => {
          this.notes.delete(path)
          renderNotes()
        })
      }
      const add = noteList.createEl("button", { cls: "ml-btn is-small is-ghost" })
      setIcon(add.createSpan({ cls: "ml-btn-icon" }), "plus")
      add.createSpan({ text: t("minutes.addNote") })
      add.addEventListener("click", () =>
        new NotePicker(this.app, (file) => {
          this.notes.add(file.path)
          renderNotes()
        }).open(),
      )
    }
    renderNotes()

    const promptHead = contentEl.createDiv({ cls: "ml-field-head" })
    promptHead.createDiv({ cls: "ml-field-label", text: t("minutes.prompt") })
    const reset = promptHead.createEl("button", { cls: "ml-link", text: t("settings.resetDefault") })
    const prompt = contentEl.createEl("textarea", { cls: "ml-prompt" })
    prompt.value = this.defaultPrompt
    reset.addEventListener("click", () => (prompt.value = DEFAULT_MINUTES_PROMPT))
    const saveRow = contentEl.createEl("label", { cls: "ml-save-default" })
    const save = saveRow.createEl("input", { attr: { type: "checkbox" } })
    saveRow.createSpan({ text: t("minutes.saveDefault") })

    contentEl.createDiv({ cls: "ml-privacy", text: t("minutes.privacy", this.target) })
    const status = contentEl.createDiv({ cls: "ml-modal-status" })
    const buttons = contentEl.createDiv({ cls: "modal-button-container" })
    buttons.createEl("button", { text: t("common.cancel") }).addEventListener("click", () => this.close())
    const go = buttons.createEl("button", { cls: "mod-cta", text: t("minutes.generate") })
    go.disabled = session.utterances.length === 0
    go.addEventListener("click", () => void generate())
    const generate = async () => {
      if (save.checked) this.onSavePrompt(prompt.value)
      go.disabled = true
      go.setText(t("minutes.generating"))
      status.setText(t("minutes.waiting"))
      const notes: { path: string; content: string }[] = []
      for (const path of this.notes) {
        const file = this.app.vault.getAbstractFileByPath(path)
        if (file instanceof TFile) notes.push({ path, content: stripMeetingBlocks(await this.app.vault.cachedRead(file)) })
      }
      session
        .generateMinutes(prompt.value, notes, (text) => status.setText(text))
        .then((path) => {
          new Notice(t("minutes.done"))
          this.onDone(path)
          this.close()
        })
        .catch((error: Error) => {
          new Notice(t("minutes.failed", error.message))
          status.setText(error.message)
          status.addClass("is-error")
          go.disabled = false
          go.setText(t("common.retry"))
        })
    }
  }

  override onClose(): void {
    this.contentEl.empty()
  }
}
