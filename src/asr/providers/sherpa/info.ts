import type { LiveCapabilities } from "../types.ts"

export const SHERPA_ID = "sherpa-onnx"

/** Where `sherpa-onnx-online-websocket-server` listens by default. The server binds IPv4 only, so the address is not `localhost`, which may resolve to ::1 first. */
export const SHERPA_DEFAULT_ENDPOINT = "ws://127.0.0.1:6006"

/** The model is chosen when the server starts, so there is no language or hotword to send, and the server does not separate speakers. */
export const SHERPA_LIVE_CAPABILITIES: LiveCapabilities = { hotwords: false, endWindow: false, language: false, diarization: false }
