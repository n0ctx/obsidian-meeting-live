import { Notice, Setting } from "obsidian"
import { t } from "../../../i18n/index.ts"
import { secretField, textField } from "../../../ui/settingFields.ts"
import { testLiveConnection } from "../liveTest.ts"
import type { ProviderSettingsContext } from "../types.ts"
import { deepgramConfigProblem, deepgramConnector } from "./live.ts"
import { deepgramConfig } from "./settings.ts"

export function renderDeepgramSettings({ app, containerEl, settings, save }: ProviderSettingsContext): void {
  const deepgram = settings.providers.deepgram
  new Setting(containerEl).setName(`${t("provider.deepgram")}实时识别`).setHeading()
  containerEl.createDiv({
    cls: "setting-item-description ml-settings-note",
    text: "录音时把音频实时发送到 Deepgram。语言跟随上方的「识别语言」；选自动检测时使用 Deepgram 的多语言模式（multi），已知语言是中文或英文时建议直接指定。",
  })
  secretField(app, new Setting(containerEl).setName("API Key"), deepgram, "apiKeySecret", save)
  textField(new Setting(containerEl).setName("模型"), deepgram, "model", save, "nova-3")
  textField(new Setting(containerEl).setName("WebSocket 地址").setDesc("默认指向 Deepgram 官方服务；自建服务或本地测试服务才需要修改。"), deepgram, "endpoint", save, "wss://api.deepgram.com/v1/listen")
  new Setting(containerEl)
    .setName("区分说话人")
    .setDesc("识别时给说话人编号。目前只记录在识别结果里，卡片暂不显示。")
    .addToggle((t) =>
      t.setValue(deepgram.diarize).onChange((v) => {
        deepgram.diarize = v
        save()
      }),
    )
  new Setting(containerEl)
    .setName("测试识别连接")
    .setDesc("建立一次连接并发送 1 秒静音，会产生极少量计费时长。")
    .addButton((b) =>
      b.setButtonText("测试").onClick(() => {
        const config = deepgramConfig(app.secretStorage, deepgram, settings.asrLanguage)
        const problem = deepgramConfigProblem(config)
        if (problem) return void new Notice(problem)
        void testLiveConnection(deepgramConnector(config), t("provider.deepgram"), b.buttonEl)
      }),
    )
}
