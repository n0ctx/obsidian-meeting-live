import { Setting } from "obsidian"
import { t } from "../../../i18n/index.ts"
import { textField } from "../../../ui/settingFields.ts"
import type { AdvancedSettingsContext } from "../types.ts"

export function renderDeepgramAdvanced({ containerEl, account, save }: AdvancedSettingsContext): void {
  const options = account.options
  textField(new Setting(containerEl).setName(t("deepgram.settings.model")), options, "model", save, "nova-3")
  textField(new Setting(containerEl).setName(t("deepgram.settings.endpoint.name")).setDesc(t("deepgram.settings.endpoint.desc")), options, "endpoint", save, "wss://api.deepgram.com/v1/listen")
  new Setting(containerEl)
    .setName(t("deepgram.settings.diarize.name"))
    .setDesc(t("deepgram.settings.diarize.desc"))
    .addToggle((field) =>
      field.setValue(options.diarize === true).onChange((v) => {
        options.diarize = v
        save()
      }),
    )
}
