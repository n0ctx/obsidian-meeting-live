import { readSecret, type SecretReader } from "../../../secrets.ts"
import type { VolcConfig } from "./live.ts"

export interface VolcSettings {
  endpoint: string
  resourceId: string
  appId: string
  /** SecretStorage ids; the secrets themselves never touch data.json. */
  apiKeySecret: string
  accessTokenSecret: string
  endWindowMs: number
  /** Resource that recognizes recorded files. */
  fileResourceId: string
  /** Ask the live stream to label speakers (enable_speaker_info). Off unless chosen: it adds delay at the end of the stream. */
  speakers: boolean
}

export const DEFAULT_VOLC: VolcSettings = {
  endpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
  resourceId: "volc.seedasr.sauc.duration",
  appId: "",
  apiKeySecret: "",
  accessTokenSecret: "",
  endWindowMs: 800,
  fileResourceId: "volc.seedasr.auc",
  speakers: false,
}

/** Where each setting lived in the flat settings of 1.0.x. */
/** `speakers` is newer than 1.0.x and has no flat key. */
const FLAT_KEYS: Record<Exclude<keyof VolcSettings, "speakers">, string> = {
  endpoint: "volcEndpoint",
  resourceId: "volcResourceId",
  appId: "volcAppId",
  apiKeySecret: "volcApiKeySecret",
  accessTokenSecret: "volcAccessTokenSecret",
  endWindowMs: "volcEndWindowMs",
  fileResourceId: "fileAsrResourceId",
}

/** The flat keys of 1.0.x, which stay in data.json untouched so that version can still read them. */
export const VOLC_FLAT_KEYS: string[] = Object.values(FLAT_KEYS)

/** Reads stored Volcengine settings, from the nested v2 shape or from the flat keys of 1.0.x. Anything missing or mistyped falls back to the default. */
export function readVolcSettings(source: unknown, flat: boolean): VolcSettings {
  const stored = source && typeof source === "object" ? (source as Record<string, unknown>) : {}
  const result = { ...DEFAULT_VOLC }
  for (const key of Object.keys(DEFAULT_VOLC) as (keyof VolcSettings)[]) {
    const name = flat ? FLAT_KEYS[key as keyof typeof FLAT_KEYS] : key
    if (!name) continue
    const value = stored[name]
    if (typeof value === typeof DEFAULT_VOLC[key]) (result as Record<string, unknown>)[key] = value
  }
  return result
}

export function volcConfig(secrets: SecretReader, volc: VolcSettings, hotwords: string): VolcConfig {
  return {
    endpoint: volc.endpoint,
    resourceId: volc.resourceId,
    apiKey: readSecret(secrets, volc.apiKeySecret),
    appId: volc.appId.trim(),
    accessToken: readSecret(secrets, volc.accessTokenSecret),
    endWindowMs: volc.endWindowMs,
    hotwords: hotwords.split(/\n|,|，/),
    speakers: volc.speakers,
  }
}
