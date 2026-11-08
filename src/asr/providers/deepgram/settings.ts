import { readSecret, type SecretReader } from "../../../secrets.ts"
import { languageHint, type AsrLanguage } from "../../language.ts"
import { readSection } from "../readSection.ts"
import type { DeepgramFileConfig } from "./file.ts"
import type { DeepgramConfig } from "./live.ts"

export interface DeepgramSettings {
  /** The live endpoint; changed only for a self-hosted Deepgram or a local test server. */
  endpoint: string
  model: string
  /** SecretStorage id; the secret itself never touches data.json. */
  apiKeySecret: string
  /** Label speakers while streaming. */
  diarize: boolean
}

export const DEFAULT_DEEPGRAM: DeepgramSettings = {
  endpoint: "wss://api.deepgram.com/v1/listen",
  model: "nova-3",
  apiKeySecret: "",
  diarize: false,
}

export const readDeepgramSettings = (source: unknown): DeepgramSettings => readSection(DEFAULT_DEEPGRAM, source)

/**
 * Auto becomes `multi`, Deepgram's multilingual mode: without a language it assumes English
 * (https://developers.deepgram.com/docs/models-languages-overview). Whether `multi` covers Chinese on the chosen model is not confirmed.
 */
export function deepgramLanguage(language: AsrLanguage): string {
  return languageHint(language) ?? "multi"
}

export function deepgramConfig(secrets: SecretReader, settings: DeepgramSettings, language: AsrLanguage): DeepgramConfig {
  return { endpoint: settings.endpoint.trim(), apiKey: readSecret(secrets, settings.apiKeySecret), model: settings.model.trim(), language: deepgramLanguage(language), diarize: settings.diarize }
}

/** Where files go: the live endpoint's own host over HTTP(S), so a self-hosted server serves both. */
export const deepgramFileUrlOf = (settings: DeepgramSettings): string => settings.endpoint.trim().replace(/^ws/, "http")

export function deepgramFileConfig(secrets: SecretReader, settings: DeepgramSettings, language: AsrLanguage): DeepgramFileConfig {
  return { url: deepgramFileUrlOf(settings), apiKey: readSecret(secrets, settings.apiKeySecret), model: settings.model.trim(), language: languageHint(language) }
}
