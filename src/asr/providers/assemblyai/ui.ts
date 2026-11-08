import { Notice, Setting } from "obsidian"
import { t } from "../../../i18n/index.ts"
import { secretField, textField } from "../../../ui/settingFields.ts"
import { testLiveConnection } from "../liveTest.ts"
import type { ProviderSettingsContext } from "../types.ts"
import { ASSEMBLYAI_LIVE_MODEL, isAssemblyAiRegion, ASSEMBLYAI_LIVE_PACING } from "./info.ts"
import { assemblyAiConfigProblem, assemblyAiConnector } from "./live.ts"
import { assemblyAiConfig } from "./settings.ts"

export function renderAssemblyAiSettings({ app, containerEl, settings, save, roles }: ProviderSettingsContext): void {
  const assemblyai = settings.providers.assemblyai
  new Setting(containerEl).setName(t("assemblyai.settings.heading", t("provider.assemblyai"))).setHeading()
  containerEl.createDiv({ cls: "setting-item-description ml-settings-note", text: t("assemblyai.settings.note") })
  secretField(app, new Setting(containerEl).setName("API Key"), assemblyai, "apiKeySecret", save)
  new Setting(containerEl)
    .setName(t("assemblyai.settings.region.name"))
    .setDesc(t("assemblyai.settings.region.desc"))
    .addDropdown((d) =>
      d
        .addOption("default", t("assemblyai.settings.region.default"))
        .addOption("eu", t("assemblyai.settings.region.eu"))
        .setValue(assemblyai.region)
        .onChange((v) => {
          if (!isAssemblyAiRegion(v)) return
          assemblyai.region = v
          save()
        }),
    )
  if (!roles.live) return
  new Setting(containerEl)
    .setName(t("assemblyai.settings.diarize.name"))
    .setDesc(t("assemblyai.settings.diarize.desc"))
    .addToggle((field) =>
      field.setValue(assemblyai.diarize).onChange((v) => {
        assemblyai.diarize = v
        save()
      }),
    )
  textField(new Setting(containerEl).setName(t("assemblyai.settings.model.name")).setDesc(t("assemblyai.settings.model.desc")), assemblyai, "model", save, ASSEMBLYAI_LIVE_MODEL)
  new Setting(containerEl)
    .setName(t("settings.liveTest.name"))
    .setDesc(t("settings.liveTest.desc"))
    .addButton((b) =>
      b.setButtonText(t("settings.test")).onClick(() => {
        const config = assemblyAiConfig(app.secretStorage, assemblyai, settings.hotwords)
        const problem = assemblyAiConfigProblem(config)
        if (problem) return void new Notice(problem)
        void testLiveConnection(assemblyAiConnector(config), ASSEMBLYAI_LIVE_PACING, t("provider.assemblyai"), b.buttonEl)
      }),
    )
}
