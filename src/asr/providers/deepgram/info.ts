import type { FileCapabilities, LiveCapabilities } from "../types.ts"

export const DEEPGRAM_ID = "deepgram"

/** Deepgram takes the language per request, and can label speakers while streaming (diarize), but has no hotword or end-window setting here. */
export const DEEPGRAM_LIVE_CAPABILITIES: LiveCapabilities = { hotwords: false, endWindow: false, language: true, diarization: true }

/** Recorded files: the language is given or detected, speakers are separated on request, and a file may be up to 2 GB (https://developers.deepgram.com/docs/pre-recorded-audio). */
export const DEEPGRAM_FILE_CAPABILITIES: FileCapabilities = { language: true, diarization: true, fileSizeLimit: 2 * 1024 * 1024 * 1024 }
