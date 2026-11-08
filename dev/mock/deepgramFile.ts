// Deepgram pre-recorded transcription as documented: POST /v1/listen with the raw audio as the body and a matching Content-Type,
// `Authorization: Token <key>` (the key "bad" gets a 401), utterances with a speaker number when diarize=true.
//   https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded
import type { IncomingMessage, ServerResponse } from "node:http"
import { SENTENCES, SENTENCE_MS, readBody, reply } from "./shared.ts"

/** True when the request was a pre-recorded one (a plain POST, not the live WebSocket upgrade). */
export async function deepgramPrerecorded(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "POST" || !req.url?.startsWith("/v1/listen")) return false
  const body = await readBody(req)
  if (req.headers.authorization === "Token bad") return reply(res, 401, { err_code: "INVALID_AUTH", err_msg: "Invalid credentials.", request_id: "mock" }), true
  if (!/^audio\//.test(req.headers["content-type"] ?? "")) return reply(res, 400, { err_code: "Bad Request", err_msg: "Bad Request: failed to process audio: corrupt or unsupported data", request_id: "mock" }), true
  if (body.length === 0) return reply(res, 400, { err_code: "Bad Request", err_msg: "Bad Request: failed to process audio: audio is empty", request_id: "mock" }), true
  const query = new URL(req.url, "http://x").searchParams
  const diarize = query.get("diarize") === "true"
  const duration = Math.max(8, Math.round(body.length / 4000))
  const sentences = Array.from({ length: Math.ceil((duration * 1000) / SENTENCE_MS) }, (_, i) => ({
    transcript: SENTENCES[i % SENTENCES.length],
    start: (i * SENTENCE_MS) / 1000,
    end: Math.min(duration, ((i + 1) * SENTENCE_MS) / 1000),
    channel: 0,
    ...(diarize ? { speaker: i % 2 } : {}),
  }))
  const text = sentences.map((s) => s.transcript).join("")
  const channels = [{ alternatives: [{ transcript: text, confidence: 0.9, words: [] }], ...(query.get("detect_language") === "true" ? { detected_language: "zh" } : {}) }]
  return reply(res, 200, { metadata: { request_id: "mock", duration, channels: 1, model_info: {} }, results: { channels, ...(query.get("utterances") === "true" ? { utterances: sentences } : {}) } }), true
}
