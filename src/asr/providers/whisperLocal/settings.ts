import { languageHint, type AsrLanguage } from "../../language.ts"
import type { OpenAiFileConfig } from "../openaiCompat/file.ts"
import { readSection } from "../readSection.ts"
import { WHISPER_LOCAL_DEFAULT_MODEL, WHISPER_LOCAL_DEFAULT_URL, WHISPER_LOCAL_FILE_LIMIT } from "./info.ts"

export interface WhisperLocalSettings {
  /** Up to and including /v1; the request goes to <baseUrl>/audio/transcriptions. */
  baseUrl: string
  model: string
}

export const DEFAULT_WHISPER_LOCAL: WhisperLocalSettings = { baseUrl: WHISPER_LOCAL_DEFAULT_URL, model: WHISPER_LOCAL_DEFAULT_MODEL }

export const readWhisperLocalSettings = (source: unknown): WhisperLocalSettings => readSection(DEFAULT_WHISPER_LOCAL, source)

/** The OpenAI-compatible adapter's configuration for a local server: no key, and a size limit that a local server does not need to keep small. */
export const whisperLocalConfig = (settings: WhisperLocalSettings, language: AsrLanguage): OpenAiFileConfig => ({
  baseUrl: settings.baseUrl.trim(),
  model: settings.model.trim() || WHISPER_LOCAL_DEFAULT_MODEL,
  apiKey: "",
  language: languageHint(language),
  fileSizeLimit: WHISPER_LOCAL_FILE_LIMIT,
})
