import { MarkdownRenderChild, setIcon, type EventRef } from "obsidian"
import { formatClock } from "../meeting/types.ts"
import { type JobStage, type TranscribeJob, type TranscribeJobs } from "./transcribeJob.ts"

const STEPS: JobStage[] = ["reading", "uploading", "recognizing", "writing"]
const STEP_NAME: Partial<Record<JobStage, string>> = { reading: "读取", uploading: "上传", recognizing: "识别", writing: "整理" }
const ISOLATED_EVENTS = ["mousedown", "pointerdown", "keydown"]

/** Temporary status bar rendered from a `meeting-live-job` block; the job replaces the block when done. */
export class JobBar extends MarkdownRenderChild {
  private readonly jobs: TranscribeJobs
  private readonly id: string | undefined
  private readonly fileName: string
  private readonly removeBlock: () => void
  private ref: EventRef | undefined
  private bar!: HTMLElement
  private clock!: HTMLElement

  constructor(containerEl: HTMLElement, jobs: TranscribeJobs, block: { id?: string; file?: string }, removeBlock: () => void) {
    super(containerEl)
    this.jobs = jobs
    this.id = block.id
    this.fileName = block.file ?? ""
    this.removeBlock = removeBlock
  }

  override onload(): void {
    this.containerEl.addClass("ml-host")
    for (const type of ISOLATED_EVENTS) this.containerEl.addEventListener(type, (e) => e.stopPropagation())
    this.bar = this.containerEl.createDiv({ cls: "ml-jobbar" })
    this.ref = this.jobs.on("change", (job: unknown) => {
      if ((job as TranscribeJob).id === this.id) this.render()
    })
    this.registerInterval(window.setInterval(() => this.tick(), 1000))
    this.render()
  }

  override onunload(): void {
    if (this.ref) this.jobs.offref(this.ref)
  }

  private job(): TranscribeJob | undefined {
    return this.id ? this.jobs.get(this.id) : undefined
  }

  private tick(): void {
    const job = this.job()
    if (job && !job.finished && this.clock) this.clock.setText(formatClock(Date.now() - job.stageStartedAt))
  }

  private render(): void {
    const job = this.job()
    const bar = this.bar
    bar.empty()
    const icon = bar.createSpan({ cls: "ml-jobbar-icon" })
    const main = bar.createDiv({ cls: "ml-jobbar-main" })
    const title = main.createDiv({ cls: "ml-jobbar-title" })
    title.createSpan({ cls: "ml-jobbar-name", text: job?.writeUp === false ? "录音转写" : "录音生成访谈记录" })
    title.createSpan({ cls: "ml-jobbar-file", text: job?.source.name ?? this.fileName })

    if (!job) {
      bar.dataset.state = "lost"
      setIcon(icon, "circle-alert")
      main.createDiv({ cls: "ml-jobbar-detail", text: "任务已中断（Obsidian 重启或插件重新加载）。如已生成原始转写，可在会议数据目录的「录音转写」中找到；需要时请重新运行命令。" })
      this.action(bar, "移除", this.removeBlock)
      return
    }

    bar.dataset.state = job.stage === "failed" ? "failed" : "running"
    const current = job.stage === "failed" ? job.failedAt : job.stage
    const steps = main.createDiv({ cls: "ml-jobbar-steps" })
    const reached = STEPS.indexOf(current ?? "reading")
    for (const [i, step] of STEPS.entries()) {
      if (step === "writing" && !job.writeUp) continue
      const el = steps.createSpan({ cls: "ml-jobbar-step", text: STEP_NAME[step] })
      el.toggleClass("is-done", i < reached)
      el.toggleClass("is-current", i === reached)
      el.toggleClass("is-failed", i === reached && job.stage === "failed")
    }

    if (job.stage === "failed") {
      setIcon(icon, "triangle-alert")
      main.createDiv({ cls: "ml-jobbar-detail", text: `${job.error ?? "未知错误"}${job.rawPath ? "。原始转写已保存，重试只会重新整理，不会重新识别" : ""}` })
      this.action(bar, job.recognized ? "重试整理" : "重试", () => void this.jobs.start(job), true)
      this.action(bar, "移除", () => void this.jobs.dismiss(job))
      return
    }
    setIcon(icon, "loader")
    icon.addClass("is-spinning")
    this.clock = bar.createSpan({ cls: "ml-jobbar-clock", text: formatClock(Date.now() - job.stageStartedAt) })
    bar.createDiv({ cls: "ml-jobbar-progress" })
  }

  private action(bar: HTMLElement, text: string, run: () => void, primary = false): void {
    const button = bar.createEl("button", { cls: `ml-btn is-small ${primary ? "is-primary" : ""}`, text })
    button.addEventListener("click", run)
  }
}
