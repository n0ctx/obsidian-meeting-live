import { t, tr, type Lang } from "../../../i18n/index.ts"
import { hostOf } from "../../../url.ts"
import type { AsrProvider, ProviderEnv } from "../types.ts"
import { dashScopeFileProvider } from "./file.ts"
import { DASHSCOPE_FILE_CAPABILITIES, DASHSCOPE_ID, DASHSCOPE_LIVE_PACING, dashScopeLiveCapabilities } from "./info.ts"
import { dashScopeConfigProblem, dashScopeConnector } from "./live.ts"
import { dashScopeConfig, dashScopeEndpoints, dashScopeFileConfig } from "./settings.ts"
import { renderDashScopeSettings } from "./ui.ts"

const configOf = ({ secrets, settings }: ProviderEnv) => dashScopeConfig(secrets, settings.providers.dashscope, settings.asrLanguage, settings.hotwords)

export const dashScopeProvider: AsrProvider = {
  id: DASHSCOPE_ID,
  get name() {
    return t("provider.dashscope")
  },
  nameIn: (lang: Lang) => tr(lang, "provider.dashscope"),
  live: {
    capabilities: (settings) => dashScopeLiveCapabilities(settings.providers.dashscope.model),
    pacing: () => DASHSCOPE_LIVE_PACING,
    host: (settings) => hostOf(dashScopeEndpoints(settings.providers.dashscope).live.replace(/^ws/, "http")),
    resolve: (env) => {
      const config = configOf(env)
      const problem = dashScopeConfigProblem(config)
      return problem ? { connect: null, problem } : { connect: dashScopeConnector(config) }
    },
  },
  file: {
    capabilities: () => DASHSCOPE_FILE_CAPABILITIES,
    host: (settings) => hostOf(dashScopeEndpoints(settings.providers.dashscope).api),
    resolve: ({ secrets, settings }) => dashScopeFileProvider(dashScopeFileConfig(secrets, settings.providers.dashscope, settings.asrLanguage)),
  },
  renderSettings: renderDashScopeSettings,
}
