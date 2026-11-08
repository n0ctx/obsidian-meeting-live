import { readSecret, type SecretReader } from "../../../secrets.ts"
import { languageHint, type AsrLanguage } from "../../language.ts"
import { readSection } from "../readSection.ts"
import { DASHSCOPE_FILE_MODEL, DASHSCOPE_LIVE_MODEL, DASHSCOPE_REGIONS, isDashScopeRegion, type DashScopeRegion } from "./info.ts"
import type { DashScopeFileConfig } from "./file.ts"
import type { DashScopeConfig } from "./live.ts"

export interface DashScopeSettings {
  /** Which Alibaba Cloud region the key belongs to; keys do not work across regions. */
  region: DashScopeRegion
  /** SecretStorage id; the secret itself never touches data.json. */
  apiKeySecret: string
  /** Live recognition model; the default is the one the documentation names for meetings. */
  model: string
}

export const DEFAULT_DASHSCOPE: DashScopeSettings = { region: "cn", apiKeySecret: "", model: DASHSCOPE_LIVE_MODEL }

export function readDashScopeSettings(source: unknown): DashScopeSettings {
  const settings = readSection<DashScopeSettings>(DEFAULT_DASHSCOPE, source)
  if (!isDashScopeRegion(settings.region)) settings.region = DEFAULT_DASHSCOPE.region
  return settings
}

export const dashScopeRegion = (settings: DashScopeSettings): DashScopeRegion => (isDashScopeRegion(settings.region) ? settings.region : "cn")

export const dashScopeEndpoints = (settings: DashScopeSettings) => DASHSCOPE_REGIONS[dashScopeRegion(settings)]

export function dashScopeConfig(secrets: SecretReader, settings: DashScopeSettings, language: AsrLanguage, hotwords: string): DashScopeConfig {
  return {
    endpoint: dashScopeEndpoints(settings).live,
    apiKey: readSecret(secrets, settings.apiKeySecret),
    model: settings.model.trim() || DASHSCOPE_LIVE_MODEL,
    language: languageHint(language),
    hotwords: hotwords.split(/\n|,|，/),
  }
}

/** The file service takes the key and region only; its model is fixed to the one that separates speakers. */
export function dashScopeFileConfig(secrets: SecretReader, settings: DashScopeSettings, language: AsrLanguage): DashScopeFileConfig {
  return { baseUrl: dashScopeEndpoints(settings).api, apiKey: readSecret(secrets, settings.apiKeySecret), model: DASHSCOPE_FILE_MODEL, language: languageHint(language) }
}
