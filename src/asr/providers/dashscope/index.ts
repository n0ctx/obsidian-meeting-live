import { sectionOf, type Account } from "../../../accounts/account.ts"
import { t, tr, type Lang } from "../../../i18n/index.ts"
import { hostOf } from "../../../url.ts"
import type { AsrProvider, ProviderEnv } from "../types.ts"
import { dashScopeFileProvider } from "./file.ts"
import { DASHSCOPE_FILE_CAPABILITIES, DASHSCOPE_ID, DASHSCOPE_LIVE_PACING, dashScopeLiveCapabilities } from "./info.ts"
import { dashScopeConfigProblem, dashScopeConnector } from "./live.ts"
import { dashScopeConfig, dashScopeEndpoints, dashScopeFileConfig, readDashScopeSettings } from "./settings.ts"
import { renderDashScopeAdvanced } from "./ui.ts"

export const dashScopeSettingsOf = (account: Account) => readDashScopeSettings(sectionOf(account))

const configOf = ({ secrets, settings, account }: ProviderEnv) => dashScopeConfig(secrets, dashScopeSettingsOf(account), settings.asrLanguage, settings.hotwords)

export const dashScopeProvider: AsrProvider = {
  id: DASHSCOPE_ID,
  get name() {
    return t("provider.dashscope")
  },
  nameIn: (lang: Lang) => tr(lang, "provider.dashscope"),
  live: {
    capabilities: (account) => dashScopeLiveCapabilities(dashScopeSettingsOf(account).model),
    pacing: () => DASHSCOPE_LIVE_PACING,
    host: (account) => hostOf(dashScopeEndpoints(dashScopeSettingsOf(account)).live.replace(/^ws/, "http")),
    resolve: (env) => {
      const config = configOf(env)
      const problem = dashScopeConfigProblem(config)
      return problem ? { connect: null, problem } : { connect: dashScopeConnector(config) }
    },
  },
  file: {
    capabilities: () => DASHSCOPE_FILE_CAPABILITIES,
    host: (account) => hostOf(dashScopeEndpoints(dashScopeSettingsOf(account)).api),
    resolve: ({ secrets, settings, account }) => dashScopeFileProvider(dashScopeFileConfig(secrets, dashScopeSettingsOf(account), settings.asrLanguage)),
  },
  renderAdvanced: renderDashScopeAdvanced,
}
