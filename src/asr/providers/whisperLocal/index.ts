import { sectionOf, type Account } from "../../../accounts/account.ts"
import { t, tr, type Lang } from "../../../i18n/index.ts"
import { hostOf } from "../../../url.ts"
import { openAiFileProvider } from "../openaiCompat/file.ts"
import type { AsrProvider } from "../types.ts"
import { WHISPER_LOCAL_FILE_LIMIT, WHISPER_LOCAL_ID } from "./info.ts"
import { readWhisperLocalSettings, whisperLocalConfig } from "./settings.ts"
import { renderWhisperLocalAdvanced } from "./ui.ts"

export const whisperLocalSettingsOf = (account: Account) => readWhisperLocalSettings(sectionOf(account))

/** A Whisper server on this machine, spoken to in the OpenAI transcription shape: the OpenAI-compatible adapter with the address filled in. */
export const whisperLocalProvider: AsrProvider = {
  id: WHISPER_LOCAL_ID,
  get name() {
    return t("provider.whisperLocal")
  },
  nameIn: (lang: Lang) => tr(lang, "provider.whisperLocal"),
  file: {
    capabilities: () => ({ language: true, diarization: false, fileSizeLimit: WHISPER_LOCAL_FILE_LIMIT }),
    host: (account) => hostOf(whisperLocalSettingsOf(account).baseUrl),
    resolve: ({ settings, account }) => ({ ...openAiFileProvider(whisperLocalConfig(whisperLocalSettingsOf(account), settings.asrLanguage)), id: WHISPER_LOCAL_ID, name: t("provider.whisperLocal") }),
  },
  renderAdvanced: renderWhisperLocalAdvanced,
}
