import { Notice, Setting } from "obsidian"
import { t } from "../../../i18n/index.ts"
import { textField } from "../../../ui/settingFields.ts"
import { testLiveConnection } from "../liveTest.ts"
import type { ProviderSettingsContext } from "../types.ts"
import { SHERPA_DEFAULT_ENDPOINT, SHERPA_LIVE_PACING } from "./info.ts"
import { sherpaConfigProblem, sherpaConnector } from "./live.ts"
import { sherpaConfig } from "./settings.ts"

export function renderSherpaSettings({ containerEl, settings, save }: ProviderSettingsContext): void {
  const sherpa = settings.providers.sherpa
  new Setting(containerEl).setName(t("sherpa.settings.heading", t("provider.sherpa"))).setHeading()
  containerEl.createDiv({ cls: "setting-item-description ml-settings-note", text: t("sherpa.settings.note") })
  textField(new Setting(containerEl).setName(t("sherpa.settings.endpoint.name")).setDesc(t("sherpa.settings.endpoint.desc")), sherpa, "endpoint", save, SHERPA_DEFAULT_ENDPOINT)
  new Setting(containerEl)
    .setName(t("settings.liveTest.name"))
    .setDesc(t("sherpa.settings.test.desc"))
    .addButton((b) =>
      b.setButtonText(t("settings.test")).onClick(() => {
        const config = sherpaConfig(sherpa)
        const problem = sherpaConfigProblem(config)
        if (problem) return void new Notice(problem)
        void testLiveConnection(sherpaConnector(config), SHERPA_LIVE_PACING, t("provider.sherpa"), b.buttonEl)
      }),
    )
}
