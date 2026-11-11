import { sectionOf, type Account } from "../../../accounts/account.ts"
import { splitHotwords } from "../../context.ts"
import { t, tr, type Lang } from "../../../i18n/index.ts"
import { hostOf } from "../../../url.ts"
import { openAiFileProvider } from "../openaiCompat/file.ts"
import type { AsrProvider, ProviderEnv } from "../types.ts"
import { LOCAL_SPEECH_FILE_CAPABILITIES, LOCAL_SPEECH_ID, LOCAL_SPEECH_LIVE_CAPABILITIES, LOCAL_SPEECH_LIVE_PACING } from "./info.ts"
import { localSpeechConnector, localSpeechPost } from "./live.ts"
import { localSpeechFileConfig, maxMsOf, pauseMsOf, readLocalSpeechSettings } from "./settings.ts"
import { renderLocalSpeechAdvanced } from "./ui.ts"

export const localSpeechSettingsOf = (account: Account) => readLocalSpeechSettings(sectionOf(account))

const contextOf = (env: ProviderEnv) => env.context?.() ?? { hotwords: splitHotwords(env.settings.hotwords) }

export const localSpeechProvider: AsrProvider = {
  id: LOCAL_SPEECH_ID,
  get name() {
    return t("provider.localSpeech")
  },
  nameIn: (lang: Lang) => tr(lang, "provider.localSpeech"),
  live: {
    capabilities: () => LOCAL_SPEECH_LIVE_CAPABILITIES,
    pacing: () => LOCAL_SPEECH_LIVE_PACING,
    host: (account) => hostOf(localSpeechSettingsOf(account).baseUrl),
    resolve: (env) => {
      const settings = localSpeechSettingsOf(env.account)
      const config = localSpeechFileConfig(env.secrets, settings, env.settings.asrLanguage, contextOf(env))
      const file = openAiFileProvider(config)
      return file.problem ? { connect: null, problem: file.problem } : { connect: localSpeechConnector(config, pauseMsOf(settings), maxMsOf(settings), localSpeechPost) }
    },
  },
  file: {
    capabilities: () => LOCAL_SPEECH_FILE_CAPABILITIES,
    host: (account) => hostOf(localSpeechSettingsOf(account).baseUrl),
    resolve: (env) => {
      const file = openAiFileProvider(localSpeechFileConfig(env.secrets, localSpeechSettingsOf(env.account), env.settings.asrLanguage, contextOf(env)))
      return { ...file, id: LOCAL_SPEECH_ID, name: t("provider.localSpeech"), capabilities: LOCAL_SPEECH_FILE_CAPABILITIES }
    },
  },
  renderAdvanced: renderLocalSpeechAdvanced,
}
