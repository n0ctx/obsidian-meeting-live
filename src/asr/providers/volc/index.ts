import { sectionOf, type Account } from "../../../accounts/account.ts"
import { t, tr, type Lang } from "../../../i18n/index.ts"
import { hostOf } from "../../../url.ts"
import type { AsrProvider, ProviderEnv } from "../types.ts"
import { FILE_ASR_HOST, volcFileProvider } from "./file.ts"
import { VOLC_FILE_CAPABILITIES, VOLC_ID, VOLC_LIVE_PACING, volcLiveCapabilities } from "./info.ts"
import { volcConfigProblem, volcConnector } from "./live.ts"
import { readVolcSettings, volcConfig } from "./settings.ts"
import { renderVolcAdvanced } from "./ui.ts"

export const volcSettingsOf = (account: Account) => readVolcSettings(sectionOf(account), false)

const configOf = ({ secrets, settings, account }: ProviderEnv) => volcConfig(secrets, volcSettingsOf(account), settings.hotwords)

export const volcProvider: AsrProvider = {
  id: VOLC_ID,
  get name() {
    return t("provider.volc")
  },
  nameIn: (lang: Lang) => tr(lang, "provider.volc"),
  live: {
    capabilities: (account) => volcLiveCapabilities(volcSettingsOf(account).speakers),
    pacing: () => VOLC_LIVE_PACING,
    host: (account) => hostOf(volcSettingsOf(account).endpoint),
    resolve: (env) => {
      const config = configOf(env)
      const problem = volcConfigProblem(config)
      return problem ? { connect: null, problem } : { connect: volcConnector(config) }
    },
  },
  file: {
    capabilities: () => VOLC_FILE_CAPABILITIES,
    host: () => FILE_ASR_HOST,
    resolve: (env) => {
      const { apiKey, appId, accessToken } = configOf(env)
      return volcFileProvider({ apiKey, appId, accessToken, resourceId: volcSettingsOf(env.account).fileResourceId.trim() || "volc.seedasr.auc" })
    },
  },
  renderAdvanced: renderVolcAdvanced,
}
