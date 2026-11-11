import { Setting } from "obsidian"
import { t } from "../../../i18n/index.ts"
import type { AdvancedSettingsContext } from "../types.ts"
import { LOCAL_SPEECH_MAX_SECONDS, LOCAL_SPEECH_PAUSE_MS } from "./info.ts"

const numberField = (setting: Setting, target: Record<string, unknown>, key: string, save: () => void, fallback: number, min: number): void => {
  setting.addText((field) =>
    field
      .setPlaceholder(String(fallback))
      .setValue(Number(target[key]) > 0 ? String(target[key]) : "")
      .onChange((v) => {
        const n = Number(v)
        target[key] = Number.isFinite(n) && n >= min ? Math.round(n) : fallback
        save()
      }),
  )
}

/** Address and key are the account's own. The model is filled by a check, so it is shown, not typed. */
export function renderLocalSpeechAdvanced({ containerEl, account, save }: AdvancedSettingsContext): void {
  const options = account.options
  containerEl.createDiv({ cls: "setting-item-description ml-settings-note", text: t("localSpeech.settings.note") })
  const model = String(options.model ?? "").trim()
  containerEl.createDiv({ cls: "setting-item-description ml-settings-note", text: model ? t("localSpeech.settings.model", model) : t("localSpeech.settings.noModel") })
  numberField(new Setting(containerEl).setName(t("localSpeech.settings.pause.name")).setDesc(t("localSpeech.settings.pause.desc")), options, "pauseMs", save, LOCAL_SPEECH_PAUSE_MS, 200)
  numberField(new Setting(containerEl).setName(t("localSpeech.settings.max.name")).setDesc(t("localSpeech.settings.max.desc")), options, "maxSeconds", save, LOCAL_SPEECH_MAX_SECONDS, 1)
}
