import { Notice, Setting } from "obsidian"
import { t } from "../../../i18n/index.ts"
import { secretField, textField } from "../../../ui/settingFields.ts"
import { testLiveConnection } from "../liveTest.ts"
import type { ProviderSettingsContext } from "../types.ts"
import { DASHSCOPE_LIVE_MODEL, isDashScopeRegion } from "./info.ts"
import { dashScopeConfigProblem, dashScopeConnector } from "./live.ts"
import { dashScopeConfig } from "./settings.ts"

export function renderDashScopeSettings({ app, containerEl, settings, save, roles }: ProviderSettingsContext): void {
  const dashscope = settings.providers.dashscope
  new Setting(containerEl).setName(t("dashscope.settings.heading", t("provider.dashscope"))).setHeading()
  containerEl.createDiv({ cls: "setting-item-description ml-settings-note", text: roles.live ? t("dashscope.settings.note") : t("dashscope.settings.fileNote") })
  if (roles.live && roles.file) containerEl.createDiv({ cls: "setting-item-description ml-settings-note", text: t("dashscope.settings.fileNote") })
  secretField(app, new Setting(containerEl).setName("API Key"), dashscope, "apiKeySecret", save)
  new Setting(containerEl)
    .setName(t("dashscope.settings.region.name"))
    .setDesc(t("dashscope.settings.region.desc"))
    .addDropdown((d) =>
      d
        .addOption("cn", t("dashscope.settings.region.cn"))
        .addOption("intl", t("dashscope.settings.region.intl"))
        .setValue(dashscope.region)
        .onChange((v) => {
          if (!isDashScopeRegion(v)) return
          dashscope.region = v
          save()
        }),
    )
  if (roles.live) {
    textField(new Setting(containerEl).setName(t("dashscope.settings.model.name")).setDesc(t("dashscope.settings.model.desc")), dashscope, "model", save, DASHSCOPE_LIVE_MODEL)
    new Setting(containerEl)
      .setName(t("settings.liveTest.name"))
      .setDesc(t("settings.liveTest.desc"))
      .addButton((b) =>
        b.setButtonText(t("settings.test")).onClick(() => {
          const config = dashScopeConfig(app.secretStorage, dashscope, settings.asrLanguage, settings.hotwords)
          const problem = dashScopeConfigProblem(config)
          if (problem) return void new Notice(problem)
          void testLiveConnection(dashScopeConnector(config), t("provider.dashscope"), b.buttonEl)
        }),
      )
  }
}
