import type { LivePacing } from "../../contract.ts"
import type { LiveCapabilities } from "../types.ts"

export const SHERPA_ID = "sherpa-onnx"

/** Where `sherpa-onnx-online-websocket-server` listens by default. The server binds IPv4 only, so the address is not `localhost`, which may resolve to ::1 first. */
export const SHERPA_DEFAULT_ENDPOINT = "ws://127.0.0.1:6006"

/**
 * The server is the user's own and documents no limit. Its reference clients send 8000 samples (0.5 s) per message and wait 0.2 s per message by default,
 * 2.5x real time (0.1 s in the examples, 5x), so 2.5x is what the server is shown to take:
 *   https://k2-fsa.github.io/sherpa/onnx/websocket/online-websocket.html
 */
export const SHERPA_LIVE_PACING: LivePacing = { maxRate: 2.5 }

/** The model is chosen when the server starts, so there is no language or hotword to send, and the server does not separate speakers. */
export const SHERPA_LIVE_CAPABILITIES: LiveCapabilities = { hotwords: false, endWindow: false, language: false, diarization: false }
