import { Setting } from "obsidian"
import { t } from "../../../i18n/index.ts"
import { textField } from "../../../ui/settingFields.ts"
import type { AdvancedSettingsContext } from "../types.ts"
import { OPENAI_FILE_LIMIT } from "./info.ts"
import { DEFAULT_OPENAI_COMPAT } from "./settings.ts"

/** The address is the account's own (it is shared with the language model), so only the transcription model and the upload limit are here. */
export function renderOpenAiCompatAdvanced({ containerEl, account, save }: AdvancedSettingsContext): void {
  const options = account.options
  textField(new Setting(containerEl).setName(t("openai.settings.model")), options, "model", save, "whisper-1")
  // https://developers.openai.com/api/docs/deprecations (whisper-1 shuts down 2027-02-26; replacement gpt-transcribe, which the guide shows without timestamps)
  if (String(options.model).trim() === DEFAULT_OPENAI_COMPAT.model) containerEl.createDiv({ cls: "setting-item-description ml-settings-note", text: t("openai.settings.deprecated") })
  new Setting(containerEl)
    .setName(t("openai.settings.limit.name"))
    .setDesc(t("openai.settings.limit.desc", OPENAI_FILE_LIMIT / 1024 / 1024))
    .addText((field) =>
      field
        .setPlaceholder(String(OPENAI_FILE_LIMIT / 1024 / 1024))
        .setValue(Number(options.fileSizeLimitMb) > 0 ? String(options.fileSizeLimitMb) : "")
        .onChange((v) => {
          const n = Number(v)
          options.fileSizeLimitMb = Number.isFinite(n) && n > 0 ? n : 0
          save()
        }),
    )
}
