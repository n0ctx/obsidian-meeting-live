import { MarkdownView, Notice, Plugin, TFile, normalizePath, requestUrl, type Editor } from "obsidian"
import { inBackground } from "./background.ts"
import { contextConsented, ensureConsentFor, ensureContextConsent, needsConsent, withLlmConsent, type Destination } from "./consent.ts"
import { t, tr } from "./i18n/index.ts"
import { addsToTyped, asrContextFor, type AsrContext } from "./asr/context.ts"
import { correctionTables } from "./asr/corrections.ts"
import { resolveFile, resolveLive, type ResolveEnv } from "./asr/providers/registry.ts"
import { extractVocabulary } from "./asr/vocabulary.ts"
import { compatibleClient, type HttpGet, type HttpPost, type LlmClient } from "./llm/client.ts"
import { DEFAULT_SUMMARY_FOCUS } from "./llm/summary.ts"
import { MeetingManager } from "./meeting/manager.ts"
import type { MeetingSession } from "./meeting/session.ts"
import { noteLang, transcriptFolder } from "./meeting/labels.ts"
import { cardHeadingBefore, withCardHeadings } from "./meeting/noteSummary.ts"
import { MeetingStore } from "./meeting/store.ts"
import { formatClock } from "./meeting/types.ts"
import { DEFAULT_SETTINGS, llmConfig, loadSettings, storedSettings, type MeetingLiveSettings } from "./settings.ts"
import { MeetingLiveSettingTab } from "./settingsTab.ts"
import { JobBar } from "./ui/jobBar.ts"
import { TranscribeFileModal } from "./ui/transcribeFile.ts"
import { TranscribeJobs } from "./ui/transcribeJob.ts"
import { JOB_LANGUAGE, parseJobBlock, removeJobBlock } from "./asr/jobBlock.ts"
import type { FileAsrGet, FileAsrPost } from "./asr/fileAsr.ts"
import { MeetingCard, parseBlockId, type CardHost } from "./ui/card.ts"
import { ConsentModal, MinutesModal } from "./ui/modals.ts"
import { summaryMarkers } from "./ui/summaryMarkers.ts"
import { markSummarySection } from "./ui/summaryPanel.ts"

const LEGACY_SUMMARY_FOCUS = `Focus on the questions discussed, decisions and conclusions, key numbers and dates, disagreements or uncertainties, and useful follow-up questions.`

export default class MeetingLivePlugin extends Plugin implements CardHost {
  override settings: MeetingLiveSettings = structuredClone(DEFAULT_SETTINGS)
  /** Keys of the previous settings shape, written back unchanged so a downgrade still finds its settings. */
  private legacySettings: Record<string, unknown> = {}
  manager!: MeetingManager
  private jobs!: TranscribeJobs
  private statusEl!: HTMLElement
  private settingTab!: MeetingLiveSettingTab
  /** Speech-context destinations the user declined since the plugin loaded, so a resumed meeting does not ask again. */
  private readonly declinedContext = new Set<string>()

  readonly post: HttpPost = async (url, headers, body) => {
    const response = await requestUrl({ url, method: "POST", headers, body, throw: false })
    return { status: response.status, text: response.text }
  }

  readonly get: HttpGet = async (url, headers) => {
    const response = await requestUrl({ url, method: "GET", headers, throw: false })
    return { status: response.status, text: response.text }
  }

  readonly filePost: FileAsrPost = async (url, headers, body) => {
    // Multipart bodies need their boundary in the content type, so it goes in the field Obsidian names for it.
    const { "Content-Type": contentType, ...rest } = headers
    const response = await requestUrl({ url, method: "POST", headers: rest, contentType, body, throw: false })
    return { status: response.status, headers: response.headers, text: response.text }
  }

  readonly fileGet: FileAsrGet = async (url, headers) => {
    const response = await requestUrl({ url, method: "GET", headers, throw: false })
    return { status: response.status, headers: response.headers, text: response.text }
  }

  override async onload(): Promise<void> {
    const loaded = loadSettings(await this.loadData())
    this.settings = loaded.settings
    this.legacySettings = loaded.legacy
    if (loaded.migrated) await this.saveSettings()
    // The previous default asked for follow-up questions, which stage summaries no longer include.
    if (this.settings.summaryFocus === LEGACY_SUMMARY_FOCUS) this.settings.summaryFocus = DEFAULT_SUMMARY_FOCUS
    const store = new MeetingStore(this.app, () => this.settings.folder)
    this.manager = new MeetingManager(store, {
      settings: () => this.settings,
      asr: (context) => resolveLive({ ...this.providerEnv(), context }),
      asrContextConsent: () => this.ensureContextConsent("live"),
      asrContextConsented: () => contextConsented(this.settings, "live"),
      llm: () => this.llm(),
      llmConsented: () => !needsConsent(this.settings, ["llm"]),
    })

    this.registerMarkdownCodeBlockProcessor("meeting-live", (source, el, ctx) => {
      ctx.addChild(new MeetingCard(el, this, parseBlockId(source), ctx))
    })
    this.registerEditorExtension(summaryMarkers)
    this.registerMarkdownPostProcessor(markSummarySection)
    this.jobs = new TranscribeJobs(this.app, this.addStatusBarItem())
    this.registerInterval(window.setInterval(() => this.jobs.render(), 1000))
    this.registerMarkdownCodeBlockProcessor(JOB_LANGUAGE, (source, el, ctx) => {
      const block = parseJobBlock(source)
      ctx.addChild(
        new JobBar(el, this.jobs, block, () => {
          const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath)
          if (file instanceof TFile && block.id) inBackground(this.app.vault.process(file, (content) => removeJobBlock(content, block.id!)))
        }, () => this.transcriptFolder().split("/").pop() ?? ""),
      )
    })
    this.settingTab = new MeetingLiveSettingTab(this.app, this)
    this.addSettingTab(this.settingTab)
    this.registerCommands()

    this.statusEl = this.addStatusBarItem()
    this.statusEl.addClass("ml-statusbar", "mod-clickable")
    this.statusEl.addEventListener("click", () => {
      const active = this.manager.active
      if (active) void this.app.workspace.openLinkText(active.meta.notePath, "", false)
    })
    this.registerEvent(this.manager.on("active", () => this.updateStatusBar()))
    this.registerInterval(window.setInterval(() => this.updateStatusBar(), 1000))
    this.updateStatusBar()

    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => inBackground(this.manager.handleRename(oldPath, file.path))))
    this.registerEvent(this.app.vault.on("modify", (file) => void this.endDetachedMeeting(file.path)))
    this.registerEvent(this.app.vault.on("delete", (file) => void this.endDetachedMeeting(file.path)))
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        menu.addItem((item) =>
          item
            .setTitle(t("cmd.insert"))
            .setIcon("audio-lines")
            .onClick(() => view instanceof MarkdownView && inBackground(this.insertMeeting(editor, view))),
        )
      }),
    )
    this.app.workspace.onLayoutReady(() => {
      inBackground(this.manager.load())
      inBackground(this.addCardHeadings())
    })
  }

  /**
   * Meeting notes without a heading above their block (written before blocks carried one, or synced in from another machine) get
   * one, so heading navigation leads to their cards. On every load and on each machine: a note that already has it is not written.
   */
  private async addCardHeadings(): Promise<void> {
    const label = tr(noteLang(this.settings), "note.cardHeading")
    for (const file of this.app.vault.getMarkdownFiles()) {
      const content = await this.app.vault.cachedRead(file)
      if (!content.includes("meeting-live") || withCardHeadings(content, label) === content) continue
      await this.app.vault.process(file, (content) => withCardHeadings(content, label))
    }
  }

  override onunload(): void {
    this.manager.shutdown()
  }

  async saveSettings(): Promise<void> {
    await this.saveData(storedSettings(this.settings, this.legacySettings))
  }

  // ---------------------------------------------------------------- CardHost

  private providerEnv(): ResolveEnv {
    return { secrets: this.app.secretStorage, settings: this.settings }
  }

  asr(): { name: string; problem?: string } {
    return resolveLive(this.providerEnv())
  }

  /** The configured model provider; rebuilt per call so setting changes apply immediately. */
  llm(): LlmClient {
    return compatibleClient(llmConfig(this.app.secretStorage, this.settings), this.post)
  }

  /** Asks about the destinations of the given kinds, all of them by default. */
  ensureConsent(kinds?: Destination["kind"][]): Promise<boolean> {
    return ensureConsentFor(this.settings, (destinations) => new ConsentModal(this.app, destinations).ask(), () => this.saveSettings(), kinds)
  }

  /** Whether the speech context of a role may go to its recognizer, asking once if the user has not said; see ensureContextConsent. */
  ensureContextConsent(role: "live" | "file"): Promise<boolean> {
    return ensureContextConsent(this.settings, role, (destination) => new ConsentModal(this.app, [destination]).ask(), () => this.saveSettings(), this.declinedContext)
  }

  /**
   * The speech context and the corrections of a file transcribed into `note`: its names when the user agrees to send them, else the
   * typed hotwords. A note that cannot be read gives the typed hotwords and the settings' table; the transcription goes on.
   */
  private async fileContext(note: TFile): Promise<{ context: AsrContext; corrections: ReturnType<typeof correctionTables> }> {
    const text = await this.app.vault.cachedRead(note).catch((error: Error) => (console.warn("[meeting-live] could not read the target note", error), undefined))
    const vocabulary = text === undefined ? undefined : extractVocabulary(text, note.basename, { ignoreLinksUnder: [this.settings.folder] })
    // Declining, or failing to save the agreement, sends the typed hotwords: the transcription goes on either way.
    const withNote = addsToTyped(this.settings, vocabulary) && (await this.ensureContextConsent("file").catch(() => contextConsented(this.settings, "file")))
    return { context: asrContextFor(this.settings, vocabulary, withNote), corrections: correctionTables(this.settings.corrections, vocabulary?.corrections ?? []) }
  }

  /** Opens the minutes dialog once the user has agreed to where the model service is, which may have changed since the recording. */
  async openMinutes(session: MeetingSession): Promise<void> {
    if (session.llmProblem) {
      new Notice(t("notice.configureFirst", session.llmProblem))
      return
    }
    await withLlmConsent((kinds) => this.ensureConsent(kinds), () => this.showMinutes(session))
  }

  private showMinutes(session: MeetingSession): void {
    new MinutesModal(this.app, session, {
      prompt: this.settings.minutesPrompt,
      target: this.llm().target,
      onSavePrompt: (prompt) => {
        this.settings.minutesPrompt = prompt
        inBackground(this.saveSettings())
      },
      onDone: (path) => this.openPath(path),
    }).open()
  }

  /** Cuts a summary of what has not been summarized yet, after the user has agreed to where the model service is. */
  async summarize(session: MeetingSession): Promise<void> {
    if (session.llmProblem) {
      new Notice(t("notice.configureFirst", session.llmProblem))
      return
    }
    await withLlmConsent((kinds) => this.ensureConsent(kinds), () => new Notice(session.summarizeNow() ? t("notice.summarizing") : t("notice.nothingToSummarize")))
  }

  /** After the user agrees to a new model service, what waited for it goes out. */
  async confirmLlm(session: MeetingSession): Promise<void> {
    await withLlmConsent((kinds) => this.ensureConsent(kinds), () => Promise.all([session.runQueue(), session.updateOverview()]))
  }

  openSettings(addAccount = false): void {
    this.settingTab.addFormOpen = addAccount
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting
    setting?.open()
    setting?.openTabById(this.manifest.id)
  }

  openPath(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path)
    if (file instanceof TFile) void this.app.workspace.getLeaf("tab").openFile(file)
    else new Notice(t("notice.fileMissing", path))
  }

  revealFolder(session: MeetingSession): void {
    const { shell } = (window as unknown as { require(m: "electron"): { shell: { showItemInFolder(path: string): void } } }).require("electron")
    shell.showItemInFolder(this.manager.fullPath(session.transcriptPath))
  }

  // ---------------------------------------------------------------- commands

  private registerCommands(): void {
    this.addCommand({
      id: "insert-meeting",
      name: t("cmd.insert"),
      icon: "audio-lines",
      editorCallback: (editor, view) => view instanceof MarkdownView && inBackground(this.insertMeeting(editor, view)),
    })
    this.addRibbonIcon("audio-lines", t("cmd.ribbonInsert"), () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView)
      if (view) inBackground(this.insertMeeting(view.editor, view, true))
      else new Notice(t("notice.openNoteToInsert"))
    })
    this.addRibbonIcon("file-audio", t("cmd.ribbonTranscribe"), () => {
      const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file
      if (file) this.openTranscribe(file)
      else new Notice(t("notice.openNoteToTranscribe"))
    })
    this.addCommand({
      id: "transcribe-audio-file",
      name: t("cmd.transcribe"),
      icon: "file-audio",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file
        if (!file) return false
        if (!checking) this.openTranscribe(file)
        return true
      },
    })
    const withSession = (id: string, name: string, icon: string, action: (s: MeetingSession) => unknown, when: (s: MeetingSession) => boolean) =>
      this.addCommand({
        id,
        name,
        icon,
        checkCallback: (checking) => {
          const session = this.manager.active ?? this.sessionInActiveNote()
          if (!session || !when(session)) return false
          if (!checking) Promise.resolve(action(session)).catch((error: Error) => new Notice(error.message))
          return true
        },
      })
    withSession("start", t("cmd.start"), "mic", async (s) => (await this.ensureConsent()) && s.start(), (s) => s.status !== "recording" && s.status !== "stopping")
    withSession("pause", t("cmd.pause"), "pause", (s) => s.pause(), (s) => s.status === "recording")
    withSession("stop", t("cmd.stop"), "square", (s) => s.stop(), (s) => ["recording", "paused", "interrupted"].includes(s.status))
    withSession("summarize", t("cmd.summarize"), "list", (s) => this.summarize(s), () => true)
    withSession("minutes", t("cmd.minutes"), "file-pen-line", (s) => this.openMinutes(s), (s) => s.utterances.length > 0)
    withSession("apply-corrections", t("cmd.applyCorrections"), "replace", async (s) => new Notice(t("notice.corrected", await s.correctTranscript())), (s) => s.utterances.length > 0)
    withSession("restore-recognized", t("cmd.restoreRecognized"), "undo-2", async (s) => new Notice(t("notice.restored", await s.restoreRecognized())), (s) => s.cleanedLines > 0)
  }

  /** Where raw transcripts of recordings go: an existing folder keeps its name whatever the note language. */
  private transcriptFolder(): string {
    return transcriptFolder(normalizePath(this.settings.folder), noteLang(this.settings), (path) => !!this.app.vault.getFolderByPath(path))
  }

  private openTranscribe(file: TFile): void {
    new TranscribeFileModal(
      this.app,
      {
        fileAsr: (context) => resolveFile({ ...this.providerEnv(), context: context && (() => context) }),
        fileContext: (note) => this.fileContext(note),
        post: this.filePost,
        get: this.fileGet,
        ensureConsent: (kinds) => this.ensureConsent(kinds),
        llm: () => this.llm(),
        prompt: () => this.settings.minutesPrompt,
        summaryFocus: () => this.settings.summaryFocus,
        transcriptFolder: () => this.transcriptFolder(),
        noteLang: () => noteLang(this.settings),
      },
      this.jobs,
      file,
    ).open()
  }

  /** Session whose block appears in the active note, if it is already loaded. */
  private sessionInActiveNote(): MeetingSession | undefined {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    const id = view ? parseBlockId(view.getViewData()) : undefined
    return id ? this.manager.loaded(id) : undefined
  }

  private async insertMeeting(editor: Editor, view: MarkdownView, record = false): Promise<void> {
    const file = view.file
    if (!file) return
    let session: MeetingSession
    try {
      session = await this.manager.create(file.basename, file.path)
      const cursor = editor.getCursor()
      const line = editor.getLine(cursor.line)
      const prefix = line.trim() ? "\n\n" : ""
      const at = line.trim() ? { line: cursor.line, ch: line.length } : { line: cursor.line, ch: 0 }
      const before = editor.getRange({ line: 0, ch: 0 }, at) + prefix
      const heading = cardHeadingBefore(before, before.length, tr(noteLang(this.settings), "note.cardHeading"))
      editor.replaceRange(`${prefix}${heading}\`\`\`meeting-live\nid: ${session.id}\n\`\`\`\n`, at)
      const after = at.line + (prefix ? 2 : 0) + (heading ? 1 : 0) + 3
      editor.setCursor({ line: Math.min(after, editor.lastLine()), ch: 0 })
    } catch (error) {
      new Notice(t("notice.createFailed", (error as Error).message))
      return
    }
    if (!record || !(await this.ensureConsent())) return
    await session.start().catch((error: Error) => new Notice(error.message))
  }

  private async endDetachedMeeting(path: string): Promise<void> {
    try {
      const ended = await this.manager.endIfDetached(path)
      if (ended) new Notice(t("notice.detached", ended.meta.title))
    } catch (error) {
      new Notice(t("notice.endFailed", (error as Error).message))
    }
  }

  private updateStatusBar(): void {
    const active = this.manager.active
    this.statusEl.toggleClass("is-active", !!active)
    if (!active) {
      this.statusEl.empty()
      return
    }
    this.statusEl.dataset.status = active.status
    const label = active.status === "recording" ? t("status.recording") : active.status === "paused" ? t("status.paused") : t("status.stopping")
    this.statusEl.setText(`${label} ${formatClock(active.durationMs)} · ${active.meta.title}`)
    this.statusEl.setAttr("aria-label", t("status.openNote"))
  }
}
