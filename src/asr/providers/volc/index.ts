import { hostOf } from "../../../url.ts"
import type { AsrProvider, ProviderEnv } from "../types.ts"
import { FILE_ASR_HOST, volcFileProvider } from "./file.ts"
import { VOLC_CAPABILITIES, VOLC_ID, VOLC_NAME } from "./info.ts"
import { volcConfigProblem, volcConnector } from "./live.ts"
import { volcConfig } from "./settings.ts"
import { renderVolcSettings } from "./ui.ts"

const configOf = ({ secrets, settings }: ProviderEnv) => volcConfig(secrets, settings.providers.volc, settings.hotwords)

export const volcProvider: AsrProvider = {
  id: VOLC_ID,
  name: VOLC_NAME,
  capabilities: VOLC_CAPABILITIES,
  liveHost: (settings) => hostOf(settings.providers.volc.endpoint),
  fileHost: () => FILE_ASR_HOST,
  live: (env) => {
    const config = configOf(env)
    const problem = volcConfigProblem(config)
    return problem ? { connect: null, problem } : { connect: volcConnector(config) }
  },
  file: (env) => {
    const { apiKey, appId, accessToken } = configOf(env)
    return volcFileProvider({ apiKey, appId, accessToken, resourceId: env.settings.providers.volc.fileResourceId.trim() || "volc.seedasr.auc" })
  },
  renderSettings: renderVolcSettings,
}
