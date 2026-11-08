import { Setting } from "obsidian"
import { t } from "../../../i18n/index.ts"
import { presetById } from "../../../llm/presets.ts"
import { textField } from "../../../ui/settingFields.ts"
import type { AdvancedSettingsContext } from "../types.ts"
import { DASHSCOPE_LIVE_MODEL, isDashScopeRegion } from "./info.ts"

export function renderDashScopeAdvanced({ containerEl, account, save, refresh }: AdvancedSettingsContext): void {
  const options = account.options
  new Setting(containerEl)
    .setName(t("dashscope.settings.region.name"))
    .setDesc(t("dashscope.settings.region.desc"))
    .addDropdown((d) =>
      d
        .addOption("cn", t("dashscope.settings.region.cn"))
        .addOption("intl", t("dashscope.settings.region.intl"))
        .setValue(String(options.region))
        .onChange((v) => {
          if (!isDashScopeRegion(v)) return
          options.region = v
          // The language model's address follows the region, so a change of region moves it too.
          options.baseUrl = presetById(v === "intl" ? "qwen-intl" : "qwen").baseUrl
          save()
          refresh()
        }),
    )
  textField(new Setting(containerEl).setName(t("dashscope.settings.model.name")).setDesc(t("dashscope.settings.model.desc")), options, "model", save, DASHSCOPE_LIVE_MODEL)
  containerEl.createDiv({ cls: "setting-item-description ml-settings-note", text: t("dashscope.settings.fileNote") })
}
