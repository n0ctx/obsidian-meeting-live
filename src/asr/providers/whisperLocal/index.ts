import { t, tr, type Lang } from "../../../i18n/index.ts"
import { hostOf } from "../../../url.ts"
import { openAiFileProvider } from "../openaiCompat/file.ts"
import type { AsrProvider } from "../types.ts"
import { WHISPER_LOCAL_FILE_LIMIT, WHISPER_LOCAL_ID } from "./info.ts"
import { whisperLocalConfig } from "./settings.ts"
import { renderWhisperLocalSettings } from "./ui.ts"

/** A Whisper server on this machine, spoken to in the OpenAI transcription shape: the OpenAI-compatible adapter with the address filled in. */
export const whisperLocalProvider: AsrProvider = {
  id: WHISPER_LOCAL_ID,
  get name() {
    return t("provider.whisperLocal")
  },
  nameIn: (lang: Lang) => tr(lang, "provider.whisperLocal"),
  file: {
    capabilities: () => ({ language: true, diarization: false, fileSizeLimit: WHISPER_LOCAL_FILE_LIMIT }),
    host: (settings) => hostOf(settings.providers.whisperLocal.baseUrl),
    resolve: ({ settings }) => ({ ...openAiFileProvider(whisperLocalConfig(settings.providers.whisperLocal, settings.asrLanguage)), id: WHISPER_LOCAL_ID, name: t("provider.whisperLocal") }),
  },
  renderSettings: renderWhisperLocalSettings,
}
