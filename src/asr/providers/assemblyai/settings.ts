import { readSecret, type SecretReader } from "../../../secrets.ts"
import { readSection } from "../readSection.ts"
import { ASSEMBLYAI_ENDPOINTS, ASSEMBLYAI_LIVE_MODEL, isAssemblyAiRegion, type AssemblyAiRegion } from "./info.ts"
import type { AssemblyAiFileConfig } from "./file.ts"
import type { AssemblyAiConfig } from "./live.ts"

export interface AssemblyAiSettings {
  region: AssemblyAiRegion
  /** SecretStorage id; the secret itself never touches data.json. */
  apiKeySecret: string
  /** Label speakers while streaming. */
  diarize: boolean
  /** Streaming model. */
  model: string
}

export const DEFAULT_ASSEMBLYAI: AssemblyAiSettings = { region: "default", apiKeySecret: "", diarize: false, model: ASSEMBLYAI_LIVE_MODEL }

export function readAssemblyAiSettings(source: unknown): AssemblyAiSettings {
  const settings = readSection<AssemblyAiSettings>(DEFAULT_ASSEMBLYAI, source)
  if (!isAssemblyAiRegion(settings.region)) settings.region = DEFAULT_ASSEMBLYAI.region
  return settings
}

export const assemblyAiEndpoints = (settings: AssemblyAiSettings) => ASSEMBLYAI_ENDPOINTS[isAssemblyAiRegion(settings.region) ? settings.region : "default"]

export function assemblyAiConfig(secrets: SecretReader, settings: AssemblyAiSettings, hotwords: string): AssemblyAiConfig {
  return { endpoint: assemblyAiEndpoints(settings).live, apiKey: readSecret(secrets, settings.apiKeySecret), model: settings.model.trim() || ASSEMBLYAI_LIVE_MODEL, diarize: settings.diarize, keyterms: hotwords.split(/\n|,|，/) }
}

/** The file service takes the key and region only: its model is the service's own choice of the best one for the language. */
export function assemblyAiFileConfig(secrets: SecretReader, settings: AssemblyAiSettings, language: string | undefined): AssemblyAiFileConfig {
  return { baseUrl: assemblyAiEndpoints(settings).api, apiKey: readSecret(secrets, settings.apiKeySecret), language }
}
