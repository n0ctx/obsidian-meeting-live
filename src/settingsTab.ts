import { Notice, PluginSettingTab, SecretComponent, Setting, type App } from "obsidian"
import { listInputDevices } from "./audio/capture.ts"
import { volcConfigProblem, volcConnector } from "./asr/volcConnection.ts"
import { DEFAULT_MINUTES_PROMPT } from "./llm/minutes.ts"
import { DEFAULT_SUMMARY_FOCUS } from "./llm/summary.ts"
import type MeetingLivePlugin from "./main.ts"
import { volcConfig, type MeetingLiveSettings } from "./settings.ts"

export class MeetingLiveSettingTab extends PluginSettingTab {
  private readonly plugin: MeetingLivePlugin

  constructor(app: App, plugin: MeetingLivePlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  private get s(): MeetingLiveSettings {
    return this.plugin.settings
  }

  private save(): void {
    void this.plugin.saveSettings()
  }

  private text<K extends keyof MeetingLiveSettings>(setting: Setting, key: K, placeholder = "") {
    setting.addText((t) =>
      t
        .setPlaceholder(placeholder)
        .setValue(String(this.s[key]))
        .onChange((v) => {
          ;(this.s[key] as string) = v.trim()
          this.save()
        }),
    )
  }

  private secret(setting: Setting, key: "volcApiKeySecret" | "volcAccessTokenSecret" | "llmApiKeySecret") {
    setting.addComponent((el) =>
      new SecretComponent(this.app, el).setValue(this.s[key]).onChange((id) => {
        this.s[key] = id ?? ""
        this.save()
      }),
    )
  }

  override display(): void {
    const { containerEl } = this
    containerEl.empty()
    containerEl.addClass("ml-settings")

    const privacy = containerEl.createDiv({ cls: "ml-settings-privacy" })
    privacy.createEl("strong", { text: "数据去向" })
    privacy.createSpan({ text: "：原始录音和转写只保存在本库。录音时音频实时上传至火山引擎识别；摘要和纪要会把转写文本发送到下方配置的 LLM 服务。凭证保存在 Obsidian 的密钥存储中，不写入笔记、会议文件或插件配置。" })

    new Setting(containerEl).setName("录音").setHeading()
    this.text(new Setting(containerEl).setName("会议数据目录").setDesc("每场会议一个子文件夹，包含录音、原始转写、AI 摘要与元数据。"), "folder", "Meetings")
    new Setting(containerEl)
      .setName("录音格式")
      .setDesc("Opus：48 kHz 高码率压缩，约 45 MB/小时，适合长会议。WAV：无损 PCM，约 330 MB/小时。")
      .addDropdown((d) =>
        d
          .addOption("ogg", "Opus（推荐）")
          .addOption("wav", "WAV 无损")
          .setValue(this.s.audioFormat)
          .onChange((v) => {
            this.s.audioFormat = v as MeetingLiveSettings["audioFormat"]
            this.save()
          }),
      )
    const device = new Setting(containerEl)
      .setName("输入设备")
      .setDesc("普通麦克风只能录到现场声音。线上会议的远端声音需要通过 BlackHole 等虚拟声卡或聚合设备接入后在此选择。")
    device.addDropdown(async (d) => {
      d.addOption("", "系统默认麦克风")
      try {
        for (const dev of await listInputDevices()) d.addOption(dev.deviceId, dev.label || "未命名设备")
      } catch {
        // Device labels need microphone permission; the default option still works.
      }
      d.setValue(this.s.deviceId).onChange((v) => {
        this.s.deviceId = v
        this.save()
      })
    })
    new Setting(containerEl)
      .setName("语音增强")
      .setDesc("开启浏览器的回声消除、降噪和自动增益。关闭时保存未经处理的原始声音（推荐）。")
      .addToggle((t) =>
        t.setValue(this.s.voiceProcessing).onChange((v) => {
          this.s.voiceProcessing = v
          this.save()
        }),
      )

    new Setting(containerEl).setName("火山引擎语音识别").setHeading()
    containerEl.createDiv({ cls: "setting-item-description ml-settings-note", text: "新版控制台只需 API Key；旧版控制台填写 App ID 与 Access Token。Resource ID 需与控制台开通的服务一致：2.0 小时版 volc.seedasr.sauc.duration，1.0 小时版 volc.bigasr.sauc.duration。" })
    this.secret(new Setting(containerEl).setName("API Key（新版控制台）"), "volcApiKeySecret")
    this.text(new Setting(containerEl).setName("App ID（旧版控制台）"), "volcAppId")
    this.secret(new Setting(containerEl).setName("Access Token（旧版控制台）"), "volcAccessTokenSecret")
    this.text(new Setting(containerEl).setName("Resource ID"), "volcResourceId", "volc.seedasr.sauc.duration")
    this.text(new Setting(containerEl).setName("WebSocket 地址").setDesc("默认使用双向流式优化版（bigmodel_async），结果有变化时才返回，并启用二遍识别提升准确率。"), "volcEndpoint")
    new Setting(containerEl)
      .setName("断句静音时长")
      .setDesc("说话停顿超过该时长即确认一句，单位毫秒，最小 200。")
      .addSlider((s) =>
        s
          .setLimits(200, 2000, 100)
          .setValue(this.s.volcEndWindowMs)
          .onChange((v) => {
            this.s.volcEndWindowMs = v
            this.save()
          }),
      )
    new Setting(containerEl)
      .setName("热词")
      .setDesc("公司名、人名、产品名等，一行一个，最多 100 个，提升专有名词识别准确率。")
      .addTextArea((t) => {
        t.inputEl.rows = 4
        t.setValue(this.s.hotwords).onChange((v) => {
          this.s.hotwords = v
          this.save()
        })
      })
    this.text(
      new Setting(containerEl).setName("录音文件识别 Resource ID").setDesc("命令「转写录音文件到当前笔记」使用，凭证与上方相同。2.0：volc.seedasr.auc；1.0：volc.bigasr.auc；极速版：volc.bigasr.auc_turbo。"),
      "fileAsrResourceId",
      "volc.seedasr.auc",
    )
    new Setting(containerEl)
      .setName("测试识别连接")
      .setDesc("建立一次连接并发送 1 秒静音，会产生极少量计费时长。")
      .addButton((b) => b.setButtonText("测试").onClick(() => void this.testAsr(b.buttonEl)))

    new Setting(containerEl).setName("LLM").setHeading()
    this.compatibleSettings(containerEl)
    new Setting(containerEl).setName("测试 LLM").addButton((b) => b.setButtonText("测试").onClick(() => void this.testLlm(b.buttonEl)))

    new Setting(containerEl).setName("阶段摘要").setHeading()
    new Setting(containerEl).setName("自动生成").addToggle((t) =>
      t.setValue(this.s.autoSummary).onChange((v) => {
        this.s.autoSummary = v
        this.save()
      }),
    )
    new Setting(containerEl)
      .setName("间隔（分钟）")
      .setDesc("按累计会议时长计算，暂停期间不计时。")
      .addSlider((s) =>
        s
          .setLimits(1, 30, 1)
          .setValue(this.s.summaryIntervalMin)
          .onChange((v) => {
            this.s.summaryIntervalMin = v
            this.save()
          }),
      )
    this.promptSetting("关注重点", "附加在固定的准确性规则之后，用于说明会议场景与需要重点提炼的信息。", "summaryFocus", DEFAULT_SUMMARY_FOCUS, 5)

    new Setting(containerEl).setName("正式纪要").setHeading()
    this.promptSetting("纪要 Prompt", "生成正式纪要时使用的系统提示词，每次生成前也可以临时修改。", "minutesPrompt", DEFAULT_MINUTES_PROMPT, 12)
  }

  private compatibleSettings(containerEl: HTMLElement): void {
    containerEl.createDiv({ cls: "setting-item-description ml-settings-note", text: "任意 OpenAI 兼容的 Chat Completions 接口，例如 DeepSeek、火山方舟、通义千问、OpenRouter 或本地模型服务。" })
    this.text(new Setting(containerEl).setName("API 地址").setDesc("填到 /v1 或完整的 /chat/completions 地址。"), "llmBaseUrl", "https://api.deepseek.com/v1")
    this.text(new Setting(containerEl).setName("模型"), "llmModel", "deepseek-flash")
    this.secret(new Setting(containerEl).setName("API Key"), "llmApiKeySecret")
    new Setting(containerEl)
      .setName("推理强度")
      .setDesc("发送 reasoning_effort；DeepSeek 同时开启思考模式。模型不支持推理时选关闭。")
      .addDropdown((d) =>
        d
          .addOption("off", "关闭")
          .addOption("low", "低")
          .addOption("medium", "中")
          .addOption("high", "高")
          .setValue(this.s.llmEffort)
          .onChange((v) => {
            this.s.llmEffort = v as MeetingLiveSettings["llmEffort"]
            this.save()
          }),
      )
    new Setting(containerEl)
      .setName("温度")
      .setDesc("越低越保守，事实性任务建议 0–0.3。开启推理后多数模型会忽略此项。")
      .addSlider((s) =>
        s
          .setLimits(0, 1, 0.05)
          .setValue(this.s.llmTemperature)
          .onChange((v) => {
            this.s.llmTemperature = v
            this.save()
          }),
      )
  }

  private promptSetting(name: string, desc: string, key: "summaryFocus" | "minutesPrompt", fallback: string, rows: number): void {
    const setting = new Setting(this.containerEl).setName(name).setDesc(desc)
    setting.settingEl.addClass("ml-prompt-setting")
    let area: HTMLTextAreaElement
    setting.addExtraButton((b) =>
      b
        .setIcon("rotate-ccw")
        .setTooltip("恢复默认")
        .onClick(() => {
          this.s[key] = fallback
          area.value = fallback
          this.save()
        }),
    )
    setting.addTextArea((t) => {
      area = t.inputEl
      t.inputEl.rows = rows
      t.setValue(this.s[key]).onChange((v) => {
        this.s[key] = v
        this.save()
      })
    })
  }

  private async testAsr(button: HTMLButtonElement): Promise<void> {
    const config = volcConfig(this.app, this.s)
    const problem = volcConfigProblem(config)
    if (problem) return void new Notice(problem)
    button.disabled = true
    try {
      let resolveFinal: () => void = () => undefined
      const final = new Promise<void>((r) => (resolveFinal = r))
      const { connection, logId } = await volcConnector(config)({
        onResult: (_data, last) => last && resolveFinal(),
        onClose: (error) => {
          new Notice(error.message)
          resolveFinal()
        },
      })
      for (let i = 0; i < 5; i++) connection.sendAudio(new Int16Array(3200), false)
      connection.sendAudio(new Int16Array(0), true)
      await Promise.race([final, new Promise((r) => window.setTimeout(r, 8000))])
      connection.close()
      new Notice(`火山引擎连接成功${logId ? `（logid ${logId}）` : ""}`)
    } catch (error) {
      new Notice((error as Error).message, 10000)
    } finally {
      button.disabled = false
    }
  }

  private async testLlm(button: HTMLButtonElement): Promise<void> {
    const llm = this.plugin.llm()
    if (llm.problem) return void new Notice(llm.problem)
    button.disabled = true
    try {
      const reply = await llm.complete([{ role: "user", content: "只回复两个字母：OK" }])
      new Notice(`LLM 连接成功：${reply.slice(0, 40)}`)
    } catch (error) {
      new Notice((error as Error).message, 10000)
    } finally {
      button.disabled = false
    }
  }
}
