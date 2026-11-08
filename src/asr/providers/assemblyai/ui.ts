import { Setting } from "obsidian"
import { t } from "../../../i18n/index.ts"
import { textField } from "../../../ui/settingFields.ts"
import type { AdvancedSettingsContext } from "../types.ts"
import { ASSEMBLYAI_LIVE_MODEL, isAssemblyAiRegion } from "./info.ts"

export function renderAssemblyAiAdvanced({ containerEl, account, save }: AdvancedSettingsContext): void {
  const options = account.options
  new Setting(containerEl)
    .setName(t("assemblyai.settings.region.name"))
    .setDesc(t("assemblyai.settings.region.desc"))
    .addDropdown((d) =>
      d
        .addOption("default", t("assemblyai.settings.region.default"))
        .addOption("eu", t("assemblyai.settings.region.eu"))
        .setValue(String(options.region))
        .onChange((v) => {
          if (!isAssemblyAiRegion(v)) return
          options.region = v
          save()
        }),
    )
  new Setting(containerEl)
    .setName(t("assemblyai.settings.diarize.name"))
    .setDesc(t("assemblyai.settings.diarize.desc"))
    .addToggle((field) =>
      field.setValue(options.diarize === true).onChange((v) => {
        options.diarize = v
        save()
      }),
    )
  textField(new Setting(containerEl).setName(t("assemblyai.settings.model.name")).setDesc(t("assemblyai.settings.model.desc")), options, "model", save, ASSEMBLYAI_LIVE_MODEL)
}
