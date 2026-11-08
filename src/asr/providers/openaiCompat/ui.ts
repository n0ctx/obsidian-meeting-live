import { Setting } from "obsidian"
import { t } from "../../../i18n/index.ts"
import { secretField, textField } from "../../../ui/settingFields.ts"
import type { ProviderSettingsContext } from "../types.ts"
import { OPENAI_FILE_LIMIT } from "./info.ts"

export function renderOpenAiCompatSettings({ app, containerEl, settings, save }: ProviderSettingsContext): void {
  const openai = settings.providers.openaiCompat
  new Setting(containerEl).setName(t("openai.settings.heading", t("provider.openaiCompat"))).setHeading()
  containerEl.createDiv({
    cls: "setting-item-description ml-settings-note",
    text: t("openai.settings.note"),
  })
  textField(new Setting(containerEl).setName(t("openai.settings.url")), openai, "baseUrl", save, "https://api.openai.com/v1")
  textField(new Setting(containerEl).setName(t("openai.settings.model")), openai, "model", save, "whisper-1")
  secretField(app, new Setting(containerEl).setName("API Key"), openai, "apiKeySecret", save)
  new Setting(containerEl)
    .setName(t("openai.settings.limit.name"))
    .setDesc(t("openai.settings.limit.desc", OPENAI_FILE_LIMIT / 1024 / 1024))
    .addText((field) =>
      field
        .setPlaceholder(String(OPENAI_FILE_LIMIT / 1024 / 1024))
        .setValue(openai.fileSizeLimitMb > 0 ? String(openai.fileSizeLimitMb) : "")
        .onChange((v) => {
          const n = Number(v)
          openai.fileSizeLimitMb = Number.isFinite(n) && n > 0 ? n : 0
          save()
        }),
    )
}
