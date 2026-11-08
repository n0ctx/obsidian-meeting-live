import { Setting } from "obsidian"
import { t } from "../../../i18n/index.ts"
import { textField } from "../../../ui/settingFields.ts"
import type { AdvancedSettingsContext } from "../types.ts"
import { SHERPA_DEFAULT_ENDPOINT } from "./info.ts"

export function renderSherpaAdvanced({ containerEl, account, save }: AdvancedSettingsContext): void {
  containerEl.createDiv({ cls: "setting-item-description ml-settings-note", text: t("sherpa.settings.note") })
  textField(new Setting(containerEl).setName(t("sherpa.settings.endpoint.name")).setDesc(t("sherpa.settings.endpoint.desc")), account.options, "endpoint", save, SHERPA_DEFAULT_ENDPOINT)
}
