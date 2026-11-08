import { Setting } from "obsidian"
import { t } from "../../../i18n/index.ts"
import { textField } from "../../../ui/settingFields.ts"
import type { ProviderSettingsContext } from "../types.ts"
import { WHISPER_LOCAL_DEFAULT_MODEL, WHISPER_LOCAL_DEFAULT_URL } from "./info.ts"

export function renderWhisperLocalSettings({ containerEl, settings, save }: ProviderSettingsContext): void {
  const local = settings.providers.whisperLocal
  new Setting(containerEl).setName(t("whisperLocal.settings.heading", t("provider.whisperLocal"))).setHeading()
  containerEl.createDiv({ cls: "setting-item-description ml-settings-note", text: t("whisperLocal.settings.note") })
  textField(new Setting(containerEl).setName(t("whisperLocal.settings.url.name")).setDesc(t("whisperLocal.settings.url.desc")), local, "baseUrl", save, WHISPER_LOCAL_DEFAULT_URL)
  textField(new Setting(containerEl).setName(t("whisperLocal.settings.model.name")).setDesc(t("whisperLocal.settings.model.desc")), local, "model", save, WHISPER_LOCAL_DEFAULT_MODEL)
}
