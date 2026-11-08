import { Notice, Setting } from "obsidian"
import { t } from "../../../i18n/index.ts"
import type { SecretReader } from "../../../secrets.ts"
import type { MeetingLiveSettings } from "../../../settings.ts"
import { secretField, textField } from "../../../ui/settingFields.ts"
import { testLiveConnection } from "../liveTest.ts"
import type { ProviderSettingsContext } from "../types.ts"
import { VOLC_LIVE_CAPABILITIES } from "./info.ts"
import { volcConfigProblem, volcConnector } from "./live.ts"
import { volcConfig } from "./settings.ts"

export function renderVolcSettings({ app, containerEl, settings, save, roles }: ProviderSettingsContext): void {
  const volc = settings.providers.volc
  new Setting(containerEl).setName(t("volc.settings.heading", t("provider.volc"))).setHeading()
  containerEl.createDiv({ cls: "setting-item-description ml-settings-note", text: t("volc.settings.note") })
  secretField(app, new Setting(containerEl).setName(t("volc.settings.apiKey")), volc, "apiKeySecret", save)
  textField(new Setting(containerEl).setName(t("volc.settings.appId")), volc, "appId", save)
  secretField(app, new Setting(containerEl).setName(t("volc.settings.accessToken")), volc, "accessTokenSecret", save)
  if (roles.live) {
    textField(new Setting(containerEl).setName("Resource ID"), volc, "resourceId", save, "volc.seedasr.sauc.duration")
    textField(new Setting(containerEl).setName(t("volc.settings.endpoint.name")).setDesc(t("volc.settings.endpoint.desc")), volc, "endpoint", save)
    if (VOLC_LIVE_CAPABILITIES.endWindow) {
      new Setting(containerEl)
        .setName(t("volc.settings.endWindow.name"))
        .setDesc(t("volc.settings.endWindow.desc"))
        .addSlider((s) =>
          s
            .setLimits(200, 2000, 100)
            .setValue(volc.endWindowMs)
            .onChange((v) => {
              volc.endWindowMs = v
              save()
            }),
        )
    }
  }
  if (roles.file) {
    textField(
      new Setting(containerEl).setName(t("volc.settings.fileResource.name")).setDesc(t("volc.settings.fileResource.desc")),
      volc,
      "fileResourceId",
      save,
      "volc.seedasr.auc",
    )
  }
  if (roles.live) {
    new Setting(containerEl)
      .setName(t("settings.liveTest.name"))
      .setDesc(t("settings.liveTest.desc"))
      .addButton((b) => b.setButtonText(t("settings.test")).onClick(() => testConnection(app.secretStorage, settings, b.buttonEl)))
  }
}

function testConnection(secrets: SecretReader, settings: MeetingLiveSettings, button: HTMLButtonElement): void {
  const config = volcConfig(secrets, settings.providers.volc, settings.hotwords)
  const problem = volcConfigProblem(config)
  if (problem) return void new Notice(problem)
  void testLiveConnection(volcConnector(config), t("provider.volc"), button)
}
