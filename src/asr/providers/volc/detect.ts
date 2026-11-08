// Which streaming resource an account may use. Volcengine sells the same recognizer under two ids, a 1.0 and a 2.0 one, and an account
// is granted one or both; a key for one gets HTTP 403 on the other. Rather than ask which, the settings try them.
import type { HandshakeResult, VolcConfig } from "./live.ts"

/** The streaming resources on the hourly plan, newest first (https://docs.volcengine.com/docs/doubao-voice/large-model-streaming-automatic-speech-recognition-api-1?lang=zh). */
export const VOLC_LIVE_RESOURCES = ["volc.seedasr.sauc.duration", "volc.bigasr.sauc.duration"] as const

export type VolcDetection =
  /** `resourceId` is the one that works: the account's own if it does, else the first of the known ones that does. */
  | { state: "ok"; resourceId: string; changed: boolean }
  /** Every resource was refused. `status` is the first refusal's, `body` its text. */
  | { state: "refused"; status: number; body: string }
  /** The server could not be reached. */
  | { state: "unreachable"; message: string }

/**
 * Tries the resource the account has, then the known ones, with a bare handshake each, and reports the first that is accepted.
 * A resource the account already has is kept if it works, so a user on 1.0 is not moved to 2.0 behind their back.
 */
export async function detectVolcResource(config: VolcConfig, handshake: (config: VolcConfig) => Promise<HandshakeResult>): Promise<VolcDetection> {
  const own = config.resourceId.trim()
  const candidates = [...new Set([own, ...VOLC_LIVE_RESOURCES].filter(Boolean))]
  let first: Extract<HandshakeResult, { ok: false }> | undefined
  for (const resourceId of candidates) {
    const result = await handshake({ ...config, resourceId })
    if (result.ok) return { state: "ok", resourceId, changed: resourceId !== own }
    if (result.status === 0) return { state: "unreachable", message: result.body }
    first ??= result
  }
  return { state: "refused", status: first?.status ?? 0, body: first?.body ?? "" }
}

/**
 * The file resource that goes with a streaming resource, for an account whose file resource is still the default: an account granted only the
 * 1.0 streaming resource is a 1.0 account, and 1.0 files are `volc.bigasr.auc`. This is an inference from the paired naming
 * (https://docs.volcengine.com/docs/doubao-voice/large-model-recording-file-recognition-standard-version-api?lang=zh); no free call checks a
 * file resource, so it cannot be confirmed without submitting audio.
 */
export function fileResourceFor(liveResourceId: string, currentFileResourceId: string, defaultFileResourceId: string): string {
  if (currentFileResourceId.trim() !== defaultFileResourceId) return currentFileResourceId
  return liveResourceId.startsWith("volc.bigasr.") ? "volc.bigasr.auc" : defaultFileResourceId
}
