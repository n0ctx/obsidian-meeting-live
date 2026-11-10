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
  /** Hotword table made in the console (自学习平台). Its words are joined to the inline hotwords before the server cuts the list. */
  boostingTableId: string
  /** Replacement table made in the console: the server swaps the recognized words it lists for their targets. */
  correctTableId: string
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
  boostingTableId: "",
  correctTableId: "",
}

/** Where each setting lived in the flat settings of 1.0.x. */
/** `speakers` and the table ids are newer than 1.0.x and have no flat key. */
const FLAT_KEYS: Record<Exclude<keyof VolcSettings, "speakers" | "boostingTableId" | "correctTableId">, string> = {
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

/** The stream's settings; `corpus` is request.corpus as buildCorpus makes it, absent when there is nothing to bias towards. */
export function volcConfig(secrets: SecretReader, volc: VolcSettings, corpus?: Record<string, unknown>): VolcConfig {
  return {
    endpoint: volc.endpoint,
    resourceId: volc.resourceId,
    apiKey: readSecret(secrets, volc.apiKeySecret),
    appId: volc.appId.trim(),
    accessToken: readSecret(secrets, volc.accessTokenSecret),
    endWindowMs: volc.endWindowMs,
    corpus,
    speakers: volc.speakers,
  }
}
