import { Setting } from "obsidian"
import { t } from "../../../i18n/index.ts"
import { secretField, textField } from "../../../ui/settingFields.ts"
import type { AdvancedSettingsContext } from "../types.ts"
import { VOLC_LIVE_CAPABILITIES } from "./info.ts"

/** The account's key covers the new console; everything else of Volcengine is here: the old console's credentials, the resources and the stream. */
export function renderVolcAdvanced({ app, containerEl, account, save }: AdvancedSettingsContext): void {
  const volc = account.options
  containerEl.createDiv({ cls: "setting-item-description ml-settings-note", text: t("volc.settings.note") })
  textField(new Setting(containerEl).setName("Resource ID").setDesc(t("volc.settings.resource.desc")), volc, "resourceId", save, "volc.seedasr.sauc.duration")
  textField(
    new Setting(containerEl).setName(t("volc.settings.fileResource.name")).setDesc(t("volc.settings.fileResource.desc")),
    volc,
    "fileResourceId",
    save,
    "volc.seedasr.auc",
  )
  textField(new Setting(containerEl).setName(t("volc.settings.appId")), volc, "appId", save)
  secretField(app, new Setting(containerEl).setName(t("volc.settings.accessToken")), volc, "accessTokenSecret", save)
  new Setting(containerEl)
    .setName(t("volc.settings.speakers.name"))
    .setDesc(t("volc.settings.speakers.desc"))
    .addToggle((field) =>
      field.setValue(volc.speakers === true).onChange((v) => {
        volc.speakers = v
        save()
      }),
    )
  if (VOLC_LIVE_CAPABILITIES.endWindow) {
    new Setting(containerEl)
      .setName(t("volc.settings.endWindow.name"))
      .setDesc(t("volc.settings.endWindow.desc"))
      .addSlider((s) =>
        s
          .setLimits(200, 2000, 100)
          .setValue(Number(volc.endWindowMs))
          .onChange((v) => {
            volc.endWindowMs = v
            save()
          }),
      )
  }
}
