import { t, tr, type Lang } from "../../../i18n/index.ts"
import { hostOf } from "../../../url.ts"
import type { AsrProvider, ProviderEnv } from "../types.ts"
import { deepgramFileProvider } from "./file.ts"
import { DEEPGRAM_FILE_CAPABILITIES, DEEPGRAM_ID, DEEPGRAM_LIVE_CAPABILITIES } from "./info.ts"
import { deepgramConfigProblem, deepgramConnector } from "./live.ts"
import { deepgramConfig, deepgramFileConfig, deepgramFileUrlOf } from "./settings.ts"
import { renderDeepgramSettings } from "./ui.ts"

const configOf = ({ secrets, settings }: ProviderEnv) => deepgramConfig(secrets, settings.providers.deepgram, settings.asrLanguage)

export const deepgramProvider: AsrProvider = {
  id: DEEPGRAM_ID,
  get name() {
    return t("provider.deepgram")
  },
  nameIn: (lang: Lang) => tr(lang, "provider.deepgram"),
  live: {
    capabilities: () => DEEPGRAM_LIVE_CAPABILITIES,
    host: (settings) => hostOf(settings.providers.deepgram.endpoint.replace(/^ws/, "http")),
    resolve: (env) => {
      const config = configOf(env)
      const problem = deepgramConfigProblem(config)
      return problem ? { connect: null, problem } : { connect: deepgramConnector(config) }
    },
  },
  file: {
    capabilities: () => DEEPGRAM_FILE_CAPABILITIES,
    host: (settings) => hostOf(deepgramFileUrlOf(settings.providers.deepgram)),
    resolve: ({ secrets, settings }) => deepgramFileProvider(deepgramFileConfig(secrets, settings.providers.deepgram, settings.asrLanguage)),
  },
  renderSettings: renderDeepgramSettings,
}
