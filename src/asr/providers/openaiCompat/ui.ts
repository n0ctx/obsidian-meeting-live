import { Setting } from "obsidian"
import { t } from "../../../i18n/index.ts"
import { secretField, textField } from "../../../ui/settingFields.ts"
import type { ProviderSettingsContext } from "../types.ts"
import { OPENAI_FILE_LIMIT } from "./info.ts"

export function renderOpenAiCompatSettings({ app, containerEl, settings, save }: ProviderSettingsContext): void {
  const openai = settings.providers.openaiCompat
  new Setting(containerEl).setName(`${t("provider.openaiCompat")}录音文件识别`).setHeading()
  containerEl.createDiv({
    cls: "setting-item-description ml-settings-note",
    text: "OpenAI、Groq 或本地 Whisper 服务，只要提供 /audio/transcriptions 接口即可。OpenAI 填 https://api.openai.com/v1，Groq 填 https://api.groq.com/openai/v1。whisper-1、Groq 的 whisper-large-v3 返回带时间的分段；gpt-*-transcribe 只返回文本，转写没有时间点；gpt-4o-transcribe-diarize 可区分说话人。",
  })
  textField(new Setting(containerEl).setName("API 地址"), openai, "baseUrl", save, "https://api.openai.com/v1")
  textField(new Setting(containerEl).setName("模型"), openai, "model", save, "whisper-1")
  secretField(app, new Setting(containerEl).setName("API Key"), openai, "apiKeySecret", save)
  new Setting(containerEl)
    .setName("文件大小上限（MB）")
    .setDesc(`单次上传的上限。留空使用默认的 ${OPENAI_FILE_LIMIT / 1024 / 1024} MB；本地服务或 Groq 开发者档（100 MB）可以调高。超过上限的录音会先压缩，仍然过大则按时间切段依次识别。`)
    .addText((t) =>
      t
        .setPlaceholder(String(OPENAI_FILE_LIMIT / 1024 / 1024))
        .setValue(openai.fileSizeLimitMb > 0 ? String(openai.fileSizeLimitMb) : "")
        .onChange((v) => {
          const n = Number(v)
          openai.fileSizeLimitMb = Number.isFinite(n) && n > 0 ? n : 0
          save()
        }),
    )
}
