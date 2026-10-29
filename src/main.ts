import { MarkdownView, Notice, Plugin, TFile, requestUrl, type Editor } from "obsidian"
import { volcConfigProblem, volcConnector } from "./asr/volcConnection.ts"
import { compatibleClient, type HttpPost, type LlmClient } from "./llm/client.ts"
import { DEFAULT_SUMMARY_FOCUS } from "./llm/summary.ts"
import { MeetingManager } from "./meeting/manager.ts"
import type { MeetingSession } from "./meeting/session.ts"
import { MeetingStore } from "./meeting/store.ts"
import { formatClock } from "./meeting/types.ts"
import { DEFAULT_SETTINGS, llmConfig, volcConfig, type MeetingLiveSettings } from "./settings.ts"
import { MeetingLiveSettingTab } from "./settingsTab.ts"
import { JobBar } from "./ui/jobBar.ts"
import { TranscribeFileModal } from "./ui/transcribeFile.ts"
import { TranscribeJobs } from "./ui/transcribeJob.ts"
import { JOB_LANGUAGE, parseJobBlock, removeJobBlock } from "./asr/jobBlock.ts"
import type { FileAsrPost } from "./asr/fileAsr.ts"
import { MeetingCard, parseBlockId, type CardHost } from "./ui/card.ts"
import { ConsentModal, MinutesModal } from "./ui/modals.ts"

const LEGACY_SUMMARY_FOCUS = `Focus on the questions discussed, decisions and conclusions, key numbers and dates, disagreements or uncertainties, and useful follow-up questions.`

export default class MeetingLivePlugin extends Plugin implements CardHost {
  override settings: MeetingLiveSettings = DEFAULT_SETTINGS
  manager!: MeetingManager
  private jobs!: TranscribeJobs
  private statusEl!: HTMLElement

  readonly post: HttpPost = async (url, headers, body) => {
    const response = await requestUrl({ url, method: "POST", headers, body, throw: false })
    return { status: response.status, text: response.text }
  }

  readonly filePost: FileAsrPost = async (url, headers, body) => {
    const response = await requestUrl({ url, method: "POST", headers, body, throw: false })
    return { status: response.status, headers: response.headers, text: response.text }
  }

  override async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<MeetingLiveSettings> | null) }
    // The previous default asked for follow-up questions, which stage summaries no longer include.
    if (this.settings.summaryFocus === LEGACY_SUMMARY_FOCUS) this.settings.summaryFocus = DEFAULT_SUMMARY_FOCUS
    const store = new MeetingStore(this.app, () => this.settings.folder)
    this.manager = new MeetingManager(store, {
      settings: () => this.settings,
      asrConnector: () => {
        const config = volcConfig(this.app, this.settings)
        const problem = volcConfigProblem(config)
        return problem ? { connect: null, problem } : { connect: volcConnector(config) }
      },
      llm: () => this.llm(),
    })

    this.registerMarkdownCodeBlockProcessor("meeting-live", (source, el, ctx) => {
      ctx.addChild(new MeetingCard(el, this, parseBlockId(source), ctx))
    })
    this.jobs = new TranscribeJobs(this.app, this.addStatusBarItem())
    this.registerInterval(window.setInterval(() => this.jobs.render(), 1000))
    this.registerMarkdownCodeBlockProcessor(JOB_LANGUAGE, (source, el, ctx) => {
      const block = parseJobBlock(source)
      ctx.addChild(
        new JobBar(el, this.jobs, block, () => {
          const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath)
          if (file instanceof TFile && block.id) void this.app.vault.process(file, (content) => removeJobBlock(content, block.id!))
        }),
      )
    })
    this.addSettingTab(new MeetingLiveSettingTab(this.app, this))
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

    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => void this.manager.handleRename(oldPath, file.path)))
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        menu.addItem((item) =>
          item
            .setTitle("插入会议组件")
            .setIcon("audio-lines")
            .onClick(() => view instanceof MarkdownView && void this.insertMeeting(editor, view)),
        )
      }),
    )
    this.app.workspace.onLayoutReady(() => void this.manager.load())
  }

  override onunload(): void {
    this.manager.shutdown()
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  // ---------------------------------------------------------------- CardHost

  asrProblem(): string | undefined {
    return volcConfigProblem(volcConfig(this.app, this.settings))
  }

  /** The configured model provider; rebuilt per call so setting changes apply immediately. */
  llm(): LlmClient {
    return compatibleClient(llmConfig(this.app, this.settings), this.post)
  }

  async ensureConsent(): Promise<boolean> {
    if (this.settings.consentAccepted) return true
    const ok = await new ConsentModal(this.app, this.llm().target).ask()
    if (ok) {
      this.settings.consentAccepted = true
      await this.saveSettings()
    }
    return ok
  }

  openMinutes(session: MeetingSession): void {
    if (session.llmProblem) {
      new Notice(`${session.llmProblem}，请先在设置中配置`)
      return
    }
    new MinutesModal(this.app, session, {
      prompt: this.settings.minutesPrompt,
      target: this.llm().target,
      onSavePrompt: (prompt) => {
        this.settings.minutesPrompt = prompt
        void this.saveSettings()
      },
      onDone: (path) => this.openPath(path),
    }).open()
  }

  openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting
    setting?.open()
    setting?.openTabById(this.manifest.id)
  }

  openPath(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path)
    if (file instanceof TFile) void this.app.workspace.getLeaf("tab").openFile(file)
    else new Notice(`文件尚未生成：${path}`)
  }

  revealFolder(session: MeetingSession): void {
    const { shell } = (window as unknown as { require(m: "electron"): { shell: { showItemInFolder(path: string): void } } }).require("electron")
    shell.showItemInFolder(this.manager.fullPath(session.transcriptPath))
  }

  // ---------------------------------------------------------------- commands

  private registerCommands(): void {
    this.addCommand({
      id: "insert-meeting",
      name: "插入会议组件",
      icon: "audio-lines",
      editorCallback: (editor, view) => view instanceof MarkdownView && void this.insertMeeting(editor, view),
    })
    this.addRibbonIcon("audio-lines", "Meeting Live：插入会议组件", () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView)
      if (view) void this.insertMeeting(view.editor, view)
      else new Notice("请先打开一篇笔记，再插入会议组件")
    })
    this.addRibbonIcon("file-audio", "Meeting Live：录音生成访谈记录", () => {
      const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file
      if (file) this.openTranscribe(file)
      else new Notice("请先打开一篇笔记，访谈记录会写入这篇笔记")
    })
    this.addCommand({
      id: "transcribe-audio-file",
      name: "录音生成访谈记录（写入当前笔记）",
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
    withSession("start", "开始或继续录音", "mic", async (s) => (await this.ensureConsent()) && s.start(), (s) => s.status !== "recording" && s.status !== "stopping")
    withSession("pause", "暂停录音", "pause", (s) => s.pause(), (s) => s.status === "recording")
    withSession("stop", "结束会议", "square", (s) => s.stop(), (s) => ["recording", "paused", "interrupted"].includes(s.status))
    withSession("summarize", "立即生成阶段摘要", "sparkles", (s) => !s.summarizeNow() && new Notice("没有新的转写内容需要总结"), () => true)
    withSession("minutes", "生成正式纪要", "file-pen-line", (s) => this.openMinutes(s), (s) => s.utterances.length > 0)
  }

  private openTranscribe(file: TFile): void {
    new TranscribeFileModal(
      this.app,
      {
        auth: () => {
          const config = volcConfig(this.app, this.settings)
          if (!config.apiKey && !(config.appId && config.accessToken)) return { problem: "未配置火山引擎凭证，请先在插件设置中填写" }
          return { auth: { apiKey: config.apiKey, appId: config.appId, accessToken: config.accessToken, resourceId: this.settings.fileAsrResourceId.trim() || "volc.seedasr.auc" } }
        },
        post: this.filePost,
        llm: () => this.llm(),
        prompt: () => this.settings.minutesPrompt,
        transcriptFolder: () => `${this.settings.folder}/录音转写`,
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

  private async insertMeeting(editor: Editor, view: MarkdownView): Promise<void> {
    const file = view.file
    if (!file) return
    try {
      const session = await this.manager.create(file.basename, file.path)
      const cursor = editor.getCursor()
      const line = editor.getLine(cursor.line)
      const prefix = line.trim() ? "\n\n" : ""
      const at = line.trim() ? { line: cursor.line, ch: line.length } : { line: cursor.line, ch: 0 }
      editor.replaceRange(`${prefix}\`\`\`meeting-live\nid: ${session.id}\n\`\`\`\n`, at)
      const after = at.line + (prefix ? 2 : 0) + 3
      editor.setCursor({ line: Math.min(after, editor.lastLine()), ch: 0 })
    } catch (error) {
      new Notice(`创建会议失败：${(error as Error).message}`)
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
    const label = active.status === "recording" ? "录音中" : active.status === "paused" ? "已暂停" : "收尾中"
    this.statusEl.setText(`${label} ${formatClock(active.durationMs)} · ${active.meta.title}`)
    this.statusEl.setAttr("aria-label", "点击打开会议所在笔记")
  }
}
