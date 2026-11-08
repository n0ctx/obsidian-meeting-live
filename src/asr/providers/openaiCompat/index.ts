import { t, tr, type Lang } from "../../../i18n/index.ts"
import { hostOf } from "../../../url.ts"
import type { AsrProvider, ProviderEnv } from "../types.ts"
import { openAiFileProvider, isDiarizeModel } from "./file.ts"
import { OPENAI_COMPAT_ID } from "./info.ts"
import { fileSizeLimit, openAiFileConfig } from "./settings.ts"
import { renderOpenAiCompatSettings } from "./ui.ts"

const configOf = ({ secrets, settings }: ProviderEnv) => openAiFileConfig(secrets, settings.providers.openaiCompat, settings.asrLanguage)

export const openAiCompatProvider: AsrProvider = {
  id: OPENAI_COMPAT_ID,
  get name() {
    return t("provider.openaiCompat")
  },
  nameIn: (lang: Lang) => tr(lang, "provider.openaiCompat"),
  file: {
    capabilities: (settings) => ({ language: true, diarization: isDiarizeModel(settings.providers.openaiCompat.model), fileSizeLimit: fileSizeLimit(settings.providers.openaiCompat) }),
    host: (settings) => hostOf(settings.providers.openaiCompat.baseUrl),
    resolve: (env) => openAiFileProvider(configOf(env)),
  },
  renderSettings: renderOpenAiCompatSettings,
}
