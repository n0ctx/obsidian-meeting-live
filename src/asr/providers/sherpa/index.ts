import { sectionOf, type Account } from "../../../accounts/account.ts"
import { t, tr, type Lang } from "../../../i18n/index.ts"
import { hostOf } from "../../../url.ts"
import type { AsrProvider } from "../types.ts"
import { SHERPA_ID, SHERPA_LIVE_CAPABILITIES, SHERPA_LIVE_PACING } from "./info.ts"
import { sherpaConfigProblem, sherpaConnector } from "./live.ts"
import { readSherpaSettings, sherpaConfig } from "./settings.ts"
import { renderSherpaAdvanced } from "./ui.ts"

export const sherpaSettingsOf = (account: Account) => readSherpaSettings(sectionOf(account))

export const sherpaProvider: AsrProvider = {
  id: SHERPA_ID,
  get name() {
    return t("provider.sherpa")
  },
  nameIn: (lang: Lang) => tr(lang, "provider.sherpa"),
  live: {
    capabilities: () => SHERPA_LIVE_CAPABILITIES,
    pacing: () => SHERPA_LIVE_PACING,
    host: (account) => hostOf(sherpaSettingsOf(account).endpoint.trim().replace(/^ws/i, "http")),
    resolve: ({ account }) => {
      const config = sherpaConfig(sherpaSettingsOf(account))
      const problem = sherpaConfigProblem(config)
      return problem ? { connect: null, problem } : { connect: sherpaConnector(config) }
    },
  },
  renderAdvanced: renderSherpaAdvanced,
}
