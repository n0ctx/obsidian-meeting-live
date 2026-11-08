import { t } from "../../../i18n/index.ts"
import type { AdvancedSettingsContext } from "../types.ts"

/** The recognizer's address is the account's own and is drawn with the account; only the note about running it is here. */
export function renderSherpaAdvanced({ containerEl }: AdvancedSettingsContext): void {
  containerEl.createDiv({ cls: "setting-item-description ml-settings-note", text: t("sherpa.settings.note") })
}
