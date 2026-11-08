import { readSecret, type SecretReader } from "../../../secrets.ts"
import { languageHint, type AsrLanguage } from "../../language.ts"
import { readSection } from "../readSection.ts"
import { OPENAI_FILE_LIMIT } from "./info.ts"
import type { OpenAiFileConfig } from "./file.ts"

export interface OpenAiCompatSettings {
  /** Up to and including /v1; the request goes to <baseUrl>/audio/transcriptions. */
  baseUrl: string
  model: string
  /** SecretStorage id; the secret itself never touches data.json. */
  apiKeySecret: string
  /** Upload limit in MB for servers that differ from OpenAI's 25; 0 uses the default. */
  fileSizeLimitMb: number
}

export const DEFAULT_OPENAI_COMPAT: OpenAiCompatSettings = {
  baseUrl: "https://api.openai.com/v1",
  model: "whisper-1",
  apiKeySecret: "",
  fileSizeLimitMb: 0,
}

export const readOpenAiCompatSettings = (source: unknown): OpenAiCompatSettings => readSection(DEFAULT_OPENAI_COMPAT, source)

export function fileSizeLimit(settings: OpenAiCompatSettings): number {
  return settings.fileSizeLimitMb > 0 ? Math.floor(settings.fileSizeLimitMb * 1024 * 1024) : OPENAI_FILE_LIMIT
}

export function openAiFileConfig(secrets: SecretReader, settings: OpenAiCompatSettings, language: AsrLanguage): OpenAiFileConfig {
  return { baseUrl: settings.baseUrl.trim(), model: settings.model.trim(), apiKey: readSecret(secrets, settings.apiKeySecret), language: languageHint(language), fileSizeLimit: fileSizeLimit(settings) }
}
