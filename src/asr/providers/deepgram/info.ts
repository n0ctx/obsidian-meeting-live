import type { LiveCapabilities } from "../types.ts"

export const DEEPGRAM_ID = "deepgram"

/** Deepgram takes the language per request, and can label speakers while streaming (diarize), but has no hotword or end-window setting here. */
export const DEEPGRAM_LIVE_CAPABILITIES: LiveCapabilities = { hotwords: false, endWindow: false, language: true, diarization: true }
