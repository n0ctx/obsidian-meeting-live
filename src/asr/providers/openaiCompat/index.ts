import { sectionOf, type Account } from "../../../accounts/account.ts"
import { t, tr, type Lang } from "../../../i18n/index.ts"
import { hostOf } from "../../../url.ts"
import type { AsrProvider, ProviderEnv } from "../types.ts"
import { openAiFileProvider, isDiarizeModel } from "./file.ts"
import { OPENAI_COMPAT_ID } from "./info.ts"
import { fileSizeLimit, openAiFileConfig, readOpenAiCompatSettings } from "./settings.ts"
import { renderOpenAiCompatAdvanced } from "./ui.ts"

export const openAiSettingsOf = (account: Account) => readOpenAiCompatSettings(sectionOf(account))

const configOf = ({ secrets, settings, account }: ProviderEnv) => openAiFileConfig(secrets, openAiSettingsOf(account), settings.asrLanguage)

export const openAiCompatProvider: AsrProvider = {
  id: OPENAI_COMPAT_ID,
  get name() {
    return t("provider.openaiCompat")
  },
  nameIn: (lang: Lang) => tr(lang, "provider.openaiCompat"),
  file: {
    capabilities: (account) => ({ language: true, diarization: isDiarizeModel(openAiSettingsOf(account).model), fileSizeLimit: fileSizeLimit(openAiSettingsOf(account)) }),
    host: (account) => hostOf(openAiSettingsOf(account).baseUrl),
    resolve: (env) => openAiFileProvider(configOf(env)),
  },
  renderAdvanced: renderOpenAiCompatAdvanced,
}
