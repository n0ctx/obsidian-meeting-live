import type { LiveCapabilities } from "../types.ts"

export const DEEPGRAM_ID = "deepgram"
export const DEEPGRAM_NAME = "Deepgram"

/** Deepgram takes the language per request, and can label speakers while streaming (diarize), but has no hotword or end-window setting here. */
export const DEEPGRAM_LIVE_CAPABILITIES: LiveCapabilities = { hotwords: false, endWindow: false, language: true, diarization: true }
