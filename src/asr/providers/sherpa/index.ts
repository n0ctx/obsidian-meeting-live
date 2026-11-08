import { t, tr, type Lang } from "../../../i18n/index.ts"
import { hostOf } from "../../../url.ts"
import type { AsrProvider } from "../types.ts"
import { SHERPA_ID, SHERPA_LIVE_CAPABILITIES } from "./info.ts"
import { sherpaConfigProblem, sherpaConnector } from "./live.ts"
import { sherpaConfig } from "./settings.ts"
import { renderSherpaSettings } from "./ui.ts"

export const sherpaProvider: AsrProvider = {
  id: SHERPA_ID,
  get name() {
    return t("provider.sherpa")
  },
  nameIn: (lang: Lang) => tr(lang, "provider.sherpa"),
  live: {
    capabilities: () => SHERPA_LIVE_CAPABILITIES,
    host: (settings) => hostOf(settings.providers.sherpa.endpoint.trim().replace(/^ws/i, "http")),
    resolve: ({ settings }) => {
      const config = sherpaConfig(settings.providers.sherpa)
      const problem = sherpaConfigProblem(config)
      return problem ? { connect: null, problem } : { connect: sherpaConnector(config) }
    },
  },
  renderSettings: renderSherpaSettings,
}
