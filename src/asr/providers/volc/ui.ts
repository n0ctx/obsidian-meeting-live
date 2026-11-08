import { Notice, Setting } from "obsidian"
import type { SecretReader } from "../../../secrets.ts"
import type { MeetingLiveSettings } from "../../../settings.ts"
import { secretField, textField } from "../../../ui/settingFields.ts"
import { testLiveConnection } from "../liveTest.ts"
import type { ProviderSettingsContext } from "../types.ts"
import { VOLC_LIVE_CAPABILITIES, VOLC_NAME } from "./info.ts"
import { volcConfigProblem, volcConnector } from "./live.ts"
import { volcConfig } from "./settings.ts"

export function renderVolcSettings({ app, containerEl, settings, save, roles }: ProviderSettingsContext): void {
  const volc = settings.providers.volc
  new Setting(containerEl).setName(`${VOLC_NAME}语音识别`).setHeading()
  containerEl.createDiv({ cls: "setting-item-description ml-settings-note", text: "新版控制台只需 API Key；旧版控制台填写 App ID 与 Access Token。Resource ID 需与控制台开通的服务一致：2.0 小时版 volc.seedasr.sauc.duration，1.0 小时版 volc.bigasr.sauc.duration。" })
  secretField(app, new Setting(containerEl).setName("API Key（新版控制台）"), volc, "apiKeySecret", save)
  textField(new Setting(containerEl).setName("App ID（旧版控制台）"), volc, "appId", save)
  secretField(app, new Setting(containerEl).setName("Access Token（旧版控制台）"), volc, "accessTokenSecret", save)
  if (roles.live) {
    textField(new Setting(containerEl).setName("Resource ID"), volc, "resourceId", save, "volc.seedasr.sauc.duration")
    textField(new Setting(containerEl).setName("WebSocket 地址").setDesc("默认使用双向流式优化版（bigmodel_async），结果有变化时才返回，并启用二遍识别提升准确率。"), volc, "endpoint", save)
    if (VOLC_LIVE_CAPABILITIES.endWindow) {
      new Setting(containerEl)
        .setName("断句静音时长")
        .setDesc("说话停顿超过该时长即确认一句，单位毫秒，最小 200。")
        .addSlider((s) =>
          s
            .setLimits(200, 2000, 100)
            .setValue(volc.endWindowMs)
            .onChange((v) => {
              volc.endWindowMs = v
              save()
            }),
        )
    }
  }
  if (roles.file) {
    textField(
      new Setting(containerEl).setName("录音文件识别 Resource ID").setDesc("命令「转写录音文件到当前笔记」使用，凭证与上方相同。2.0：volc.seedasr.auc；1.0：volc.bigasr.auc；极速版：volc.bigasr.auc_turbo。"),
      volc,
      "fileResourceId",
      save,
      "volc.seedasr.auc",
    )
  }
  if (roles.live) {
    new Setting(containerEl)
      .setName("测试识别连接")
      .setDesc("建立一次连接并发送 1 秒静音，会产生极少量计费时长。")
      .addButton((b) => b.setButtonText("测试").onClick(() => testConnection(app.secretStorage, settings, b.buttonEl)))
  }
}

function testConnection(secrets: SecretReader, settings: MeetingLiveSettings, button: HTMLButtonElement): void {
  const config = volcConfig(secrets, settings.providers.volc, settings.hotwords)
  const problem = volcConfigProblem(config)
  if (problem) return void new Notice(problem)
  void testLiveConnection(volcConnector(config), VOLC_NAME, button)
}
