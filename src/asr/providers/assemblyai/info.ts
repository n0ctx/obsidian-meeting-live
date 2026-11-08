import type { LivePacing } from "../../contract.ts"
import type { FileCapabilities, LiveCapabilities } from "../types.ts"

export const ASSEMBLYAI_ID = "assemblyai"

/** `default` is AssemblyAI's own routing (the US for uploads, the nearest region for streaming); `eu` keeps audio and transcripts in the EU. */
export type AssemblyAiRegion = "default" | "eu"

export const isAssemblyAiRegion = (value: unknown): value is AssemblyAiRegion => value === "default" || value === "eu"

/**
 *   https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api  (wss://streaming.assemblyai.com/v3/ws, streaming.eu.assemblyai.com)
 *   https://www.assemblyai.com/docs/pre-recorded-audio/select-the-region  (api.assemblyai.com, api.eu.assemblyai.com)
 * Whether a key works in both regions is not stated in what was read; it is assumed that one account key does.
 */
export const ASSEMBLYAI_ENDPOINTS: Record<AssemblyAiRegion, { live: string; api: string }> = {
  default: { live: "wss://streaming.assemblyai.com/v3/ws", api: "https://api.assemblyai.com" },
  eu: { live: "wss://streaming.eu.assemblyai.com/v3/ws", api: "https://api.eu.assemblyai.com" },
}

/**
 * The streaming model whose language list names Mandarin and Japanese besides English and the European languages
 * (https://www.assemblyai.com/docs/faq/language-support-for-real-time-transcription). The newer universal-3-6-pro is the server's
 * default; it is described as covering everything 3.5 does, but only by a secondary source, so 3.5 is pinned.
 */
export const ASSEMBLYAI_LIVE_MODEL = "universal-3-5-pro"

/** The Universal-Streaming models need `format_turns` to get punctuated finals; the Pro models do not take it. */
export const needsFormatTurns = (model: string): boolean => /^universal-streaming/i.test(model.trim())

/**
 * Language is chosen by the model and detected per turn, so there is no language setting. Keyterms go in a JSON message
 * after the session begins (up to 100). `speaker_labels` labels speakers while streaming.
 */
export const ASSEMBLYAI_LIVE_CAPABILITIES: LiveCapabilities = { hotwords: true, endWindow: false, language: false, diarization: true }

/**
 * Audio may be sent faster than real time, but "throughput is throttled at ~1.25x real time"; the server closes the session with error 3007
 * once more than five minutes of audio are buffered ahead of processing, and advises pacing at about real time to keep Turn messages consistent:
 *   https://www.assemblyai.com/docs/streaming/message-sequence
 *   https://www.assemblyai.com/docs/streaming/guides/stream_prerecorded_file_realtime
 */
export const ASSEMBLYAI_LIVE_PACING: LivePacing = { maxRate: 1.25 }

/** `/v2/upload` takes files up to 2.2 GB (https://www.assemblyai.com/docs/getting-started/transcribe-an-audio-file). */
export const ASSEMBLYAI_FILE_LIMIT = Math.floor(2.2 * 1024 * 1024 * 1024)

/** The language is the user's recognition language when set, and detected otherwise; speakers are separated on request. */
export const ASSEMBLYAI_FILE_CAPABILITIES: FileCapabilities = { language: true, diarization: true, fileSizeLimit: ASSEMBLYAI_FILE_LIMIT }

/**
 * Formats taken as they are. The service transcodes what it is given, but no list of accepted formats was read, so only the common
 * ones are named (not confirmed); the recompressed upload is Ogg Opus.
 */
export const ASSEMBLYAI_DIRECT_FORMATS: Record<string, string> = { mp3: "mp3", m4a: "m4a", mp4: "mp4", wav: "wav", ogg: "ogg", opus: "ogg", flac: "flac", webm: "webm", aac: "aac" }
