import type { App } from "obsidian"
import type { VolcConfig } from "./asr/volcConnection.ts"
import type { CompatibleEffort, LlmConfig } from "./llm/client.ts"
import { DEFAULT_MINUTES_PROMPT } from "./llm/minutes.ts"
import { DEFAULT_SUMMARY_FOCUS } from "./llm/summary.ts"
import type { AudioFormat } from "./meeting/types.ts"

export interface MeetingLiveSettings {
  folder: string
  audioFormat: AudioFormat
  deviceId: string
  voiceProcessing: boolean
  volcEndpoint: string
  volcResourceId: string
  volcAppId: string
  /** SecretStorage ids; the secrets themselves never touch data.json. */
  volcApiKeySecret: string
  volcAccessTokenSecret: string
  volcEndWindowMs: number
  fileAsrResourceId: string
  hotwords: string
  llmBaseUrl: string
  llmModel: string
  llmTemperature: number
  llmEffort: CompatibleEffort
  llmApiKeySecret: string
  autoSummary: boolean
  summaryIntervalMin: number
  summaryFocus: string
  minutesPrompt: string
  consentAccepted: boolean
}

export const DEFAULT_SETTINGS: MeetingLiveSettings = {
  folder: "Meetings",
  audioFormat: "ogg",
  deviceId: "",
  voiceProcessing: false,
  volcEndpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
  volcResourceId: "volc.seedasr.sauc.duration",
  volcAppId: "",
  volcApiKeySecret: "",
  volcAccessTokenSecret: "",
  volcEndWindowMs: 800,
  fileAsrResourceId: "volc.seedasr.auc",
  hotwords: "",
  llmBaseUrl: "https://api.deepseek.com",
  llmModel: "deepseek-flash",
  llmTemperature: 0.2,
  llmEffort: "low",
  llmApiKeySecret: "",
  autoSummary: true,
  summaryIntervalMin: 1,
  summaryFocus: DEFAULT_SUMMARY_FOCUS,
  minutesPrompt: DEFAULT_MINUTES_PROMPT,
  consentAccepted: false,
}

function secret(app: App, id: string): string {
  return id ? (app.secretStorage.getSecret(id) ?? "").trim() : ""
}

export function volcConfig(app: App, s: MeetingLiveSettings): VolcConfig {
  return {
    endpoint: s.volcEndpoint,
    resourceId: s.volcResourceId,
    apiKey: secret(app, s.volcApiKeySecret),
    appId: s.volcAppId.trim(),
    accessToken: secret(app, s.volcAccessTokenSecret),
    endWindowMs: s.volcEndWindowMs,
    hotwords: s.hotwords.split(/\n|,|，/),
  }
}

export function llmConfig(app: App, s: MeetingLiveSettings): LlmConfig {
  return { baseUrl: s.llmBaseUrl, apiKey: secret(app, s.llmApiKeySecret), model: s.llmModel, temperature: s.llmTemperature, effort: s.llmEffort }
}
