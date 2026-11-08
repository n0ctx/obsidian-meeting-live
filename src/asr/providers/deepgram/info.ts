import type { LivePacing } from "../../contract.ts"
import type { FileCapabilities, LiveCapabilities } from "../types.ts"

export const DEEPGRAM_ID = "deepgram"

/** Deepgram takes the language per request, and can label speakers while streaming (diarize), but has no hotword or end-window setting here. */
export const DEEPGRAM_LIVE_CAPABILITIES: LiveCapabilities = { hotwords: false, endWindow: false, language: true, diarization: true }

/**
 * "Deepgram allows audio to be streamed at a maximum of 1.25x realtime", so a buffer sent after a disconnect "may wind up being significantly delayed":
 *   https://developers.deepgram.com/docs/recovering-from-connection-errors-and-timeouts-when-live-streaming-audio
 */
export const DEEPGRAM_LIVE_PACING: LivePacing = { maxRate: 1.25 }

/** Recorded files: the language is given or detected, speakers are separated on request, and a file may be up to 2 GB (https://developers.deepgram.com/docs/pre-recorded-audio). */
export const DEEPGRAM_FILE_CAPABILITIES: FileCapabilities = { language: true, diarization: true, fileSizeLimit: 2 * 1024 * 1024 * 1024 }
