import type { LivePacing } from "../../contract.ts"
import type { FileCapabilities, LiveCapabilities } from "../types.ts"

export const VOLC_ID = "volc"

/** Above this the base64 request body (×4/3) risks HTTP 413; such files are compressed first. */
export const VOLC_FILE_LIMIT = 60 * 1024 * 1024

/**
 * No send rate limit is documented. The streaming page recommends packets of 100-200 ms sent every 100-200 ms ("单包音频大小建议在100~200ms左右，
 * 发包间隔建议100～200ms，不能过大或者过小，否则均会影响性能") and gives no numbers beyond that:
 *   https://docs.volcengine.com/docs/6561/1354869
 * 6x is what the plugin has always sent (three 200 ms chunks per 100 ms tick) and what runs in production, so it is kept as it was.
 */
export const VOLC_LIVE_PACING: LivePacing = { maxRate: 6 }

/** Volcengine detects the language by itself, so the generic language setting does not apply. */
export const VOLC_LIVE_CAPABILITIES: LiveCapabilities = { hotwords: true, endWindow: true, language: false, diarization: false, context: true }

/** Speakers are labelled while streaming only when the user turned them on, so that is what the provider reports. */
export const volcLiveCapabilities = (speakers: boolean): LiveCapabilities => ({ ...VOLC_LIVE_CAPABILITIES, diarization: speakers })
export const VOLC_FILE_CAPABILITIES: FileCapabilities = { language: false, diarization: true, fileSizeLimit: VOLC_FILE_LIMIT, context: true }
