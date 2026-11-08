import { sectionOf, type Account } from "../../../accounts/account.ts"
import { t, tr, type Lang } from "../../../i18n/index.ts"
import { hostOf } from "../../../url.ts"
import type { AsrProvider, ProviderEnv } from "../types.ts"
import { deepgramFileProvider } from "./file.ts"
import { DEEPGRAM_FILE_CAPABILITIES, DEEPGRAM_ID, DEEPGRAM_LIVE_CAPABILITIES, DEEPGRAM_LIVE_PACING } from "./info.ts"
import { deepgramConfigProblem, deepgramConnector } from "./live.ts"
import { deepgramConfig, deepgramFileConfig, deepgramFileUrlOf, readDeepgramSettings } from "./settings.ts"
import { renderDeepgramAdvanced } from "./ui.ts"

export const deepgramSettingsOf = (account: Account) => readDeepgramSettings(sectionOf(account))

const configOf = ({ secrets, settings, account }: ProviderEnv) => deepgramConfig(secrets, deepgramSettingsOf(account), settings.asrLanguage)

export const deepgramProvider: AsrProvider = {
  id: DEEPGRAM_ID,
  get name() {
    return t("provider.deepgram")
  },
  nameIn: (lang: Lang) => tr(lang, "provider.deepgram"),
  live: {
    capabilities: () => DEEPGRAM_LIVE_CAPABILITIES,
    pacing: () => DEEPGRAM_LIVE_PACING,
    host: (account) => hostOf(deepgramSettingsOf(account).endpoint.replace(/^ws/, "http")),
    resolve: (env) => {
      const config = configOf(env)
      const problem = deepgramConfigProblem(config)
      return problem ? { connect: null, problem } : { connect: deepgramConnector(config) }
    },
  },
  file: {
    capabilities: () => DEEPGRAM_FILE_CAPABILITIES,
    host: (account) => hostOf(deepgramFileUrlOf(deepgramSettingsOf(account))),
    resolve: ({ secrets, settings, account }) => deepgramFileProvider(deepgramFileConfig(secrets, deepgramSettingsOf(account), settings.asrLanguage)),
  },
  renderAdvanced: renderDeepgramAdvanced,
}
