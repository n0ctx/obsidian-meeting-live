import { Setting } from "obsidian"
import { t } from "../../../i18n/index.ts"
import { textField } from "../../../ui/settingFields.ts"
import type { AdvancedSettingsContext } from "../types.ts"
import { WHISPER_LOCAL_DEFAULT_MODEL } from "./info.ts"

/** The address is the account's own, shown with every account that has one. */
export function renderWhisperLocalAdvanced({ containerEl, account, save }: AdvancedSettingsContext): void {
  containerEl.createDiv({ cls: "setting-item-description ml-settings-note", text: t("whisperLocal.settings.note") })
  textField(new Setting(containerEl).setName(t("whisperLocal.settings.model.name")).setDesc(t("whisperLocal.settings.model.desc")), account.options, "model", save, WHISPER_LOCAL_DEFAULT_MODEL)
}
