import { languageHint } from "../../language.ts"
import { sectionOf, type Account } from "../../../accounts/account.ts"
import { t, tr, type Lang } from "../../../i18n/index.ts"
import { hostOf } from "../../../url.ts"
import type { AsrProvider, ProviderEnv } from "../types.ts"
import { assemblyAiFileProvider } from "./file.ts"
import { ASSEMBLYAI_FILE_CAPABILITIES, ASSEMBLYAI_ID, ASSEMBLYAI_LIVE_CAPABILITIES, ASSEMBLYAI_LIVE_PACING } from "./info.ts"
import { assemblyAiConfigProblem, assemblyAiConnector } from "./live.ts"
import { assemblyAiConfig, assemblyAiEndpoints, assemblyAiFileConfig, readAssemblyAiSettings } from "./settings.ts"
import { renderAssemblyAiAdvanced } from "./ui.ts"

export const assemblyAiSettingsOf = (account: Account) => readAssemblyAiSettings(sectionOf(account))

const configOf = ({ secrets, settings, account }: ProviderEnv) => assemblyAiConfig(secrets, assemblyAiSettingsOf(account), settings.hotwords)

export const assemblyAiProvider: AsrProvider = {
  id: ASSEMBLYAI_ID,
  get name() {
    return t("provider.assemblyai")
  },
  nameIn: (lang: Lang) => tr(lang, "provider.assemblyai"),
  live: {
    capabilities: () => ASSEMBLYAI_LIVE_CAPABILITIES,
    pacing: () => ASSEMBLYAI_LIVE_PACING,
    host: (account) => hostOf(assemblyAiEndpoints(assemblyAiSettingsOf(account)).live.replace(/^ws/, "http")),
    resolve: (env) => {
      const config = configOf(env)
      const problem = assemblyAiConfigProblem(config)
      return problem ? { connect: null, problem } : { connect: assemblyAiConnector(config) }
    },
  },
  file: {
    capabilities: () => ASSEMBLYAI_FILE_CAPABILITIES,
    host: (account) => hostOf(assemblyAiEndpoints(assemblyAiSettingsOf(account)).api),
    resolve: ({ secrets, settings, account }) => assemblyAiFileProvider(assemblyAiFileConfig(secrets, assemblyAiSettingsOf(account), languageHint(settings.asrLanguage))),
  },
  renderAdvanced: renderAssemblyAiAdvanced,
}
