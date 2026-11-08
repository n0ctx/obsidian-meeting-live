import type { FileCapabilities, LiveCapabilities } from "../types.ts"

export const VOLC_ID = "volc"

/** Above this the base64 request body (×4/3) risks HTTP 413; such files are compressed first. */
export const VOLC_FILE_LIMIT = 60 * 1024 * 1024

/** Volcengine detects the language by itself, so the generic language setting does not apply. */
export const VOLC_LIVE_CAPABILITIES: LiveCapabilities = { hotwords: true, endWindow: true, language: false, diarization: false }

/** Speakers are labelled while streaming only when the user turned them on, so that is what the provider reports. */
export const volcLiveCapabilities = (speakers: boolean): LiveCapabilities => ({ ...VOLC_LIVE_CAPABILITIES, diarization: speakers })
export const VOLC_FILE_CAPABILITIES: FileCapabilities = { language: false, diarization: true, fileSizeLimit: VOLC_FILE_LIMIT }
