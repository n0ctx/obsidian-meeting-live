import { Notice, PluginSettingTab, Setting, type App } from "obsidian"
import { inBackground } from "./background.ts"
import { ASR_LANGUAGES, asrLanguageName, type AsrLanguage } from "./asr/language.ts"
import { liveIsLocal } from "./consent.ts"
import { asrProvider, fileProviders, liveProviders } from "./asr/providers/registry.ts"
import type { AsrProvider } from "./asr/providers/types.ts"
import { listInputDevices } from "./audio/capture.ts"
import { isNoteLanguage, t } from "./i18n/index.ts"
import { DEFAULT_MINUTES_PROMPT } from "./llm/minutes.ts"
import { LLM_PRESETS, presetById } from "./llm/presets.ts"
import { DEFAULT_SUMMARY_FOCUS } from "./llm/summary.ts"
import type MeetingLivePlugin from "./main.ts"
import type { MeetingLiveSettings } from "./settings.ts"
import { platformText } from "./platform.ts"
import { secretField, textField } from "./ui/settingFields.ts"

/** A reply to this proves the endpoint, the key and the model work together; it is English so that it asks the same of every model. */
const LLM_TEST_PROMPT = "Reply with only the two letters: OK"

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
    inBackground(this.plugin.saveSettings())
  }

  override display(): void {
    const { containerEl } = this
    containerEl.empty()
    containerEl.addClass("ml-settings")

    const privacy = containerEl.createDiv({ cls: "ml-settings-privacy" })
    privacy.createEl("strong", { text: t("settings.privacy.title") })
    privacy.createSpan({ text: t(liveIsLocal(this.s) ? "settings.privacy.bodyLocal" : "settings.privacy.body", asrProvider(this.s.liveProvider)?.name ?? this.s.liveProvider) })

    new Setting(containerEl).setName(t("settings.recording")).setHeading()
    textField(new Setting(containerEl).setName(t("settings.folder.name")).setDesc(t("settings.folder.desc")), this.s, "folder", () => this.save(), "Meetings")
    new Setting(containerEl)
      .setName(t("settings.noteLanguage.name"))
      .setDesc(t("settings.noteLanguage.desc"))
      .addDropdown((d) =>
        d
          .addOption("auto", t("settings.noteLanguage.auto"))
          .addOption("zh", t("settings.noteLanguage.zh"))
          .addOption("en", t("settings.noteLanguage.en"))
          .setValue(this.s.noteLanguage)
          .onChange((v) => {
            if (!isNoteLanguage(v)) return
            this.s.noteLanguage = v
            this.save()
          }),
      )
    new Setting(containerEl)
      .setName(t("settings.format.name"))
      .setDesc(t("settings.format.desc"))
      .addDropdown((d) =>
        d
          .addOption("ogg", t("settings.format.opus"))
          .addOption("wav", t("settings.format.wav"))
          .setValue(this.s.audioFormat)
          .onChange((v) => {
            this.s.audioFormat = v as MeetingLiveSettings["audioFormat"]
            this.save()
          }),
      )
    const device = new Setting(containerEl)
      .setName(t("settings.device.name"))
      .setDesc(platformText("systemAudio"))
    device.addDropdown(async (d) => {
      d.addOption("", t("settings.device.default"))
      try {
        for (const dev of await listInputDevices()) d.addOption(dev.deviceId, dev.label || t("settings.device.unnamed"))
      } catch {
        // Device labels need microphone permission; the default option still works.
      }
      d.setValue(this.s.deviceId).onChange((v) => {
        this.s.deviceId = v
        this.save()
      })
    })
    new Setting(containerEl)
      .setName(t("settings.voice.name"))
      .setDesc(t("settings.voice.desc"))
      .addToggle((field) =>
        field.setValue(this.s.voiceProcessing).onChange((v) => {
          this.s.voiceProcessing = v
          this.save()
        }),
      )

    this.asrSettings(containerEl)

    new Setting(containerEl).setName(t("settings.llm")).setHeading()
    this.compatibleSettings(containerEl)
    new Setting(containerEl).setName(t("settings.llm.test")).addButton((b) => b.setButtonText(t("settings.test")).onClick(() => void this.testLlm(b.buttonEl)))

    new Setting(containerEl).setName(t("settings.summary")).setHeading()
    new Setting(containerEl).setName(t("settings.auto.name")).addToggle((field) =>
      field.setValue(this.s.autoSummary).onChange((v) => {
        this.s.autoSummary = v
        this.save()
      }),
    )
    new Setting(containerEl)
      .setName(t("settings.interval.name"))
      .setDesc(t("settings.interval.desc"))
      .addSlider((s) =>
        s
          .setLimits(1, 30, 1)
          .setValue(this.s.summaryIntervalMin)
          .onChange((v) => {
            this.s.summaryIntervalMin = v
            this.save()
          }),
      )
    this.promptSetting(t("settings.focus.name"), t("settings.focus.desc"), "summaryFocus", DEFAULT_SUMMARY_FOCUS, 5)

    new Setting(containerEl).setName(t("settings.minutes")).setHeading()
    this.promptSetting(t("settings.minutesPrompt.name"), t("settings.minutesPrompt.desc"), "minutesPrompt", DEFAULT_MINUTES_PROMPT, 12)
  }

  private asrSettings(containerEl: HTMLElement): void {
    const s = this.s
    new Setting(containerEl).setName(t("settings.asr")).setHeading()
    this.providerChoice(containerEl, t("settings.liveProvider.name"), t("settings.liveProvider.desc"), liveProviders(), "liveProvider")
    this.providerChoice(containerEl, t("settings.fileProvider.name"), t("settings.fileProvider.desc"), fileProviders(), "fileProvider")
    if (asrProvider(s.liveProvider)?.live?.capabilities(s).hotwords) {
      new Setting(containerEl)
        .setName(t("settings.hotwords.name"))
        .setDesc(t("settings.hotwords.desc"))
        .addTextArea((field) => {
          field.inputEl.rows = 4
          field.setValue(s.hotwords).onChange((v) => {
            s.hotwords = v
            this.save()
          })
        })
    }
    const languageFor = [asrProvider(s.liveProvider)?.live?.capabilities(s).language && t("asr.role.live"), asrProvider(s.fileProvider)?.file?.capabilities(s).language && t("asr.role.file")].filter(Boolean)
    if (languageFor.length) {
      new Setting(containerEl)
        .setName(t("settings.language.name"))
        .setDesc(t("settings.language.desc", languageFor.join(t("settings.language.and"))))
        .addDropdown((d) => {
          for (const id of ASR_LANGUAGES) d.addOption(id, asrLanguageName(id))
          d.setValue(s.asrLanguage).onChange((v) => {
            s.asrLanguage = v as AsrLanguage
            this.save()
          })
        })
    }
    for (const id of new Set([s.liveProvider, s.fileProvider])) {
      const provider = asrProvider(id)
      if (provider) provider.renderSettings({ app: this.app, containerEl, settings: s, save: () => this.save(), roles: { live: id === s.liveProvider && !!provider.live, file: id === s.fileProvider && !!provider.file } })
      else containerEl.createDiv({ cls: "setting-item-description ml-settings-note", text: t("settings.unknownProvider", id) })
    }
  }

  /** A dropdown of the providers able to do the job; an id that is no longer available stays visible so the page tells the truth. */
  private providerChoice(containerEl: HTMLElement, name: string, desc: string, providers: AsrProvider[], key: "liveProvider" | "fileProvider"): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addDropdown((d) => {
        for (const p of providers) d.addOption(p.id, p.name)
        if (!providers.some((p) => p.id === this.s[key])) d.addOption(this.s[key], t("settings.providerUnavailable", this.s[key]))
        d.setValue(this.s[key]).onChange((v) => {
          this.s[key] = v
          this.save()
          this.display()
        })
      })
  }

  private compatibleSettings(containerEl: HTMLElement): void {
    const s = this.s
    const preset = presetById(s.llmPreset)
    containerEl.createDiv({ cls: "setting-item-description ml-settings-note", text: t("settings.llm.intro") })
    new Setting(containerEl).setName(t("settings.llm.service")).addDropdown((d) => {
      for (const p of LLM_PRESETS) d.addOption(p.id, p.name)
      d.setValue(preset.id).onChange((id) => {
        const next = presetById(id)
        s.llmPreset = next.id
        if (next.id !== "custom") {
          s.llmBaseUrl = next.baseUrl
          s.llmModel = next.model
        }
        this.save()
        this.display()
      })
    })
    textField(new Setting(containerEl).setName(t("settings.llm.url.name")).setDesc(t("settings.llm.url.desc")), s, "llmBaseUrl", () => this.save(), preset.baseUrl || t("settings.llm.url.placeholder"))
    textField(new Setting(containerEl).setName(t("settings.llm.model.name")).setDesc(preset.id === "azure" ? t("settings.llm.model.azure") : ""), s, "llmModel", () => this.save(), preset.model || t("settings.llm.model.placeholder"))
    secretField(this.app, new Setting(containerEl).setName(preset.keyRequired ? t("settings.llm.key.required") : t("settings.llm.key.optional")).setDesc(preset.keyRequired ? "" : t("settings.llm.key.optionalDesc")), s, "llmApiKeySecret", () => this.save())
    if (preset.customHeaders) {
      new Setting(containerEl)
        .setName(t("settings.llm.headers.name"))
        .setDesc(t("settings.llm.headers.desc"))
        .addTextArea((field) => {
          field.inputEl.rows = 3
          field.setValue(s.llmHeaders).onChange((v) => {
            s.llmHeaders = v
            this.save()
          })
        })
    }
    if (preset.effort !== "none") {
      new Setting(containerEl)
        .setName(t("settings.llm.effort.name"))
        .setDesc(preset.effort === "deepseek" ? t("settings.llm.effort.deepseek") : t("settings.llm.effort.plain"))
        .addDropdown((d) =>
          d
            .addOption("off", t("settings.llm.effort.off"))
            .addOption("low", t("settings.llm.effort.low"))
            .addOption("medium", t("settings.llm.effort.medium"))
            .addOption("high", t("settings.llm.effort.high"))
            .setValue(s.llmEffort)
            .onChange((v) => {
              s.llmEffort = v as MeetingLiveSettings["llmEffort"]
              this.save()
            }),
        )
    }
    if (preset.temperature) {
      new Setting(containerEl)
        .setName(t("settings.llm.temperature.name"))
        .setDesc(t("settings.llm.temperature.desc"))
        .addSlider((slider) =>
          slider
            .setLimits(0, 1, 0.05)
            .setValue(s.llmTemperature)
            .onChange((v) => {
              s.llmTemperature = v
              this.save()
            }),
        )
    }
    new Setting(containerEl)
      .setName(t("settings.llm.limit.name"))
      .setDesc(t("settings.llm.limit.desc", preset.name, preset.inputTokens.toLocaleString()))
      .addText((field) =>
        field
          .setPlaceholder(String(preset.inputTokens))
          .setValue(s.llmInputLimit > 0 ? String(s.llmInputLimit) : "")
          .onChange((v) => {
            const n = Math.floor(Number(v))
            s.llmInputLimit = Number.isFinite(n) && n > 0 ? n : 0
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
        .setTooltip(t("settings.resetDefault"))
        .onClick(() => {
          this.s[key] = fallback
          area.value = fallback
          this.save()
        }),
    )
    setting.addTextArea((field) => {
      area = field.inputEl
      field.inputEl.rows = rows
      field.setValue(this.s[key]).onChange((v) => {
        this.s[key] = v
        this.save()
      })
    })
  }

  private async testLlm(button: HTMLButtonElement): Promise<void> {
    const llm = this.plugin.llm()
    if (llm.problem) return void new Notice(llm.problem)
    button.disabled = true
    try {
      const reply = await llm.complete([{ role: "user", content: LLM_TEST_PROMPT }])
      new Notice(t("settings.llm.testOk", reply.slice(0, 40)))
    } catch (error) {
      new Notice((error as Error).message, 10000)
    } finally {
      button.disabled = false
    }
  }
}
