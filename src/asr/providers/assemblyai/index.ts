import { languageHint } from "../../language.ts"
import { t, tr, type Lang } from "../../../i18n/index.ts"
import { hostOf } from "../../../url.ts"
import type { AsrProvider, ProviderEnv } from "../types.ts"
import { assemblyAiFileProvider } from "./file.ts"
import { ASSEMBLYAI_FILE_CAPABILITIES, ASSEMBLYAI_ID, ASSEMBLYAI_LIVE_CAPABILITIES, ASSEMBLYAI_LIVE_PACING } from "./info.ts"
import { assemblyAiConfigProblem, assemblyAiConnector } from "./live.ts"
import { assemblyAiConfig, assemblyAiEndpoints, assemblyAiFileConfig } from "./settings.ts"
import { renderAssemblyAiSettings } from "./ui.ts"

const configOf = ({ secrets, settings }: ProviderEnv) => assemblyAiConfig(secrets, settings.providers.assemblyai, settings.hotwords)

export const assemblyAiProvider: AsrProvider = {
  id: ASSEMBLYAI_ID,
  get name() {
    return t("provider.assemblyai")
  },
  nameIn: (lang: Lang) => tr(lang, "provider.assemblyai"),
  live: {
    capabilities: () => ASSEMBLYAI_LIVE_CAPABILITIES,
    pacing: () => ASSEMBLYAI_LIVE_PACING,
    host: (settings) => hostOf(assemblyAiEndpoints(settings.providers.assemblyai).live.replace(/^ws/, "http")),
    resolve: (env) => {
      const config = configOf(env)
      const problem = assemblyAiConfigProblem(config)
      return problem ? { connect: null, problem } : { connect: assemblyAiConnector(config) }
    },
  },
  file: {
    capabilities: () => ASSEMBLYAI_FILE_CAPABILITIES,
    host: (settings) => hostOf(assemblyAiEndpoints(settings.providers.assemblyai).api),
    resolve: ({ secrets, settings }) => assemblyAiFileProvider(assemblyAiFileConfig(secrets, settings.providers.assemblyai, languageHint(settings.asrLanguage))),
  },
  renderSettings: renderAssemblyAiSettings,
}
