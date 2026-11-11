import { readSecret, type SecretReader } from "../../../secrets.ts"
import { dedupe, type AsrContext } from "../../context.ts"
import { languageHint, type AsrLanguage } from "../../language.ts"
import { readSection } from "../readSection.ts"
import type { OpenAiFileConfig } from "../openaiCompat/file.ts"
import { LOCAL_SPEECH_DEFAULT_URL, LOCAL_SPEECH_FILE_LIMIT, LOCAL_SPEECH_MAX_SECONDS, LOCAL_SPEECH_PAUSE_MS } from "./info.ts"

export interface LocalSpeechSettings {
  /** Up to and including /v1; the request goes to <baseUrl>/audio/transcriptions. */
  baseUrl: string
  /** Filled from the service's model list by a check. Empty until then, and not typed. */
  model: string
  /** SecretStorage id; the secret itself never touches data.json. */
  apiKeySecret: string
  /** Silence that ends an utterance, in milliseconds. */
  pauseMs: number
  /** Longest utterance sent as one request, in seconds. A pause cuts first; this is only the bound. */
  maxSeconds: number
}

export const DEFAULT_LOCAL_SPEECH: LocalSpeechSettings = {
  baseUrl: LOCAL_SPEECH_DEFAULT_URL,
  model: "",
  apiKeySecret: "",
  pauseMs: LOCAL_SPEECH_PAUSE_MS,
  maxSeconds: LOCAL_SPEECH_MAX_SECONDS,
}

export const readLocalSpeechSettings = (source: unknown): LocalSpeechSettings => readSection(DEFAULT_LOCAL_SPEECH, source)

/** Terms and the meeting's scene, as the transcription `prompt`. Empty when there is nothing to send. */
export function speechPrompt(ctx: AsrContext | undefined): string | undefined {
  if (!ctx) return undefined
  const words = dedupe(ctx.hotwords)
  const scene = ctx.scene?.trim() ?? ""
  const text = [words.length ? words.join("，") : "", scene].filter(Boolean).join("\n").slice(0, 2000).trim()
  return text || undefined
}

export function localSpeechFileConfig(secrets: SecretReader, settings: LocalSpeechSettings, language: AsrLanguage, ctx: AsrContext | undefined): OpenAiFileConfig {
  return {
    baseUrl: settings.baseUrl.trim(),
    model: settings.model.trim(),
    apiKey: readSecret(secrets, settings.apiKeySecret),
    language: languageHint(language),
    fileSizeLimit: LOCAL_SPEECH_FILE_LIMIT,
    prompt: speechPrompt(ctx),
    responseFormat: "verbose_json",
  }
}

export const pauseMsOf = (settings: LocalSpeechSettings): number => (settings.pauseMs >= 200 ? settings.pauseMs : LOCAL_SPEECH_PAUSE_MS)

export const maxMsOf = (settings: LocalSpeechSettings): number => (settings.maxSeconds >= 1 ? settings.maxSeconds : LOCAL_SPEECH_MAX_SECONDS) * 1000
