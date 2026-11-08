import { Notice, Setting } from "obsidian"
import { t } from "../../../i18n/index.ts"
import { secretField, textField } from "../../../ui/settingFields.ts"
import { testLiveConnection } from "../liveTest.ts"
import type { ProviderSettingsContext } from "../types.ts"
import { DEEPGRAM_LIVE_PACING } from "./info.ts"
import { deepgramConfigProblem, deepgramConnector } from "./live.ts"
import { deepgramConfig } from "./settings.ts"

export function renderDeepgramSettings({ app, containerEl, settings, save, roles }: ProviderSettingsContext): void {
  const deepgram = settings.providers.deepgram
  new Setting(containerEl).setName(t(roles.live ? "deepgram.settings.heading" : "deepgram.settings.headingFile", t("provider.deepgram"))).setHeading()
  containerEl.createDiv({
    cls: "setting-item-description ml-settings-note",
    text: roles.live ? t("deepgram.settings.note") : t("deepgram.settings.fileNote"),
  })
  if (roles.live && roles.file) containerEl.createDiv({ cls: "setting-item-description ml-settings-note", text: t("deepgram.settings.fileNote") })
  secretField(app, new Setting(containerEl).setName("API Key"), deepgram, "apiKeySecret", save)
  textField(new Setting(containerEl).setName(t("deepgram.settings.model")), deepgram, "model", save, "nova-3")
  textField(new Setting(containerEl).setName(t("deepgram.settings.endpoint.name")).setDesc(t("deepgram.settings.endpoint.desc")), deepgram, "endpoint", save, "wss://api.deepgram.com/v1/listen")
  if (!roles.live) return
  new Setting(containerEl)
    .setName(t("deepgram.settings.diarize.name"))
    .setDesc(t("deepgram.settings.diarize.desc"))
    .addToggle((field) =>
      field.setValue(deepgram.diarize).onChange((v) => {
        deepgram.diarize = v
        save()
      }),
    )
  new Setting(containerEl)
    .setName(t("settings.liveTest.name"))
    .setDesc(t("settings.liveTest.desc"))
    .addButton((b) =>
      b.setButtonText(t("settings.test")).onClick(() => {
        const config = deepgramConfig(app.secretStorage, deepgram, settings.asrLanguage)
        const problem = deepgramConfigProblem(config)
        if (problem) return void new Notice(problem)
        void testLiveConnection(deepgramConnector(config), DEEPGRAM_LIVE_PACING, t("provider.deepgram"), b.buttonEl)
      }),
    )
}
