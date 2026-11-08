// AssemblyAI as documented: Universal-Streaming v3 over WebSocket (Begin, Turn, Terminate, Termination, UpdateConfiguration) and the
// pre-recorded REST flow (upload, submit, poll). Keys travel in `authorization` without a prefix; the key "bad" is refused.
//   https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api
//   https://www.assemblyai.com/docs/getting-started/transcribe-an-audio-file
import type { IncomingMessage, ServerResponse } from "node:http"
import type { WebSocket } from "ws"
import { SENTENCES, SENTENCE_MS, readBody, reply, stats } from "./shared.ts"

export const ASSEMBLYAI_WS_PATH = "/v3/ws"

export function assemblyaiSession(ws: WebSocket, req: IncomingMessage): void {
  stats.assemblyaiConnections++
  if (req.headers.authorization === "bad") {
    ws.close(1008, "Unauthorized Connection: Invalid API key")
    return
  }
  const query = new URL(req.url ?? "", "http://x").searchParams
  const speakers = query.get("speaker_labels") === "true"
  const formatTurns = query.get("format_turns") === "true"
  let receivedMs = 0
  let turnOrder = 0
  let turnStart = 0
  let index = Math.floor(Math.random() * SENTENCES.length)
  ws.send(JSON.stringify({ type: "Begin", id: "mock-session", expires_at: Math.floor(Date.now() / 1000) + 3600 }))
  const turn = (text: string, start: number, end: number, final: boolean) => {
    const pieces = text.split(/(?<=，)/)
    const each = (end - start) / pieces.length
    const words = pieces.map((piece, i) => ({ text: piece, start: Math.round(start + i * each), end: Math.round(start + (i + 1) * each), confidence: 0.9, word_is_final: final }))
    const send = (formatted: boolean) =>
      ws.send(JSON.stringify({ type: "Turn", turn_order: turnOrder, turn_is_formatted: formatted, end_of_turn: final, end_of_turn_confidence: final ? 1 : 0.1, transcript: text, words, ...(speakers ? { speaker_label: turnOrder % 2 ? "B" : "A" } : {}) }))
    // With format_turns the server sends the finished turn twice: unformatted first, then the formatted copy.
    if (final && formatTurns) send(false)
    send(final || !formatTurns)
  }
  const partial = () => {
    const sentence = SENTENCES[index % SENTENCES.length]
    return sentence.slice(0, Math.max(1, Math.floor((sentence.length * (receivedMs - turnStart)) / SENTENCE_MS)))
  }
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      const message = JSON.parse(data.toString()) as { type?: string }
      if (message.type === "UpdateConfiguration") stats.assemblyaiConfigUpdates++
      if (message.type === "Terminate") {
        stats.assemblyaiTerminates++
        if (receivedMs > turnStart) turn(partial(), turnStart, receivedMs, true)
        ws.send(JSON.stringify({ type: "Termination", audio_duration_seconds: Math.round(receivedMs / 1000), session_duration_seconds: Math.round(receivedMs / 1000) }))
        ws.close(1000)
      }
      return
    }
    receivedMs += (data.length / 2 / 16000) * 1000
    if (receivedMs - turnStart >= SENTENCE_MS) {
      turn(SENTENCES[index % SENTENCES.length], turnStart, receivedMs, true)
      index++
      turnOrder++
      turnStart = receivedMs
    } else turn(partial(), turnStart, receivedMs, false)
  })
  ws.on("error", () => undefined)
}

interface Job {
  bytes: number
  speakers: boolean
  language: string | undefined
  polls: number
}

const uploads = new Map<string, number>()
const jobs = new Map<string, Job>()

/** The REST half: returns true when the request was one of AssemblyAI's. `origin` is where this server can be reached. */
export async function assemblyaiRest(req: IncomingMessage, res: ServerResponse, origin: string): Promise<boolean> {
  const path = req.url ?? ""
  if (!path.startsWith("/v2/")) return false
  const body = await readBody(req)
  if (req.headers.authorization === "bad") return reply(res, 401, { error: "Authentication error, API token missing/invalid" }), true
  if (req.method === "POST" && path === "/v2/upload") {
    if (req.headers["content-type"] !== "application/octet-stream") return reply(res, 200, { upload_url: `${origin}/files/not-audio` }), true
    stats.assemblyaiUploads++
    const id = `u${uploads.size + 1}`
    uploads.set(id, body.length)
    return reply(res, 200, { upload_url: `${origin}/files/${id}` }), true
  }
  if (req.method === "POST" && path === "/v2/transcript") {
    const request = JSON.parse(body.toString() || "{}") as { audio_url?: string; speaker_labels?: boolean; language_code?: string }
    const bytes = uploads.get(request.audio_url?.split("/files/")[1] ?? "")
    if (bytes === undefined) return reply(res, 400, { error: "audio_url: The file could not be fetched (Transcoding failed. File type text/plain)" }), true
    const id = `t${jobs.size + 1}`
    jobs.set(id, { bytes, speakers: request.speaker_labels === true, language: request.language_code, polls: 0 })
    return reply(res, 200, { id, status: "queued" }), true
  }
  const polled = /^\/v2\/transcript\/(\w+)$/.exec(path)
  if (req.method === "GET" && polled) {
    const job = jobs.get(polled[1])
    if (!job) return reply(res, 404, { error: "Transcript not found" }), true
    if (++job.polls < 2) return reply(res, 200, { id: polled[1], status: job.polls === 1 ? "queued" : "processing" }), true
    if (job.bytes === 0) return reply(res, 200, { id: polled[1], status: "error", error: "Transcoding failed. The file is empty" }), true
    return reply(res, 200, transcript(polled[1], job)), true
  }
  return false
}

/** A finished transcript of the mock sentences, spread over a duration guessed from the upload size (about 32 kbit/s). */
function transcript(id: string, job: Job) {
  const duration = Math.max(8, Math.round(job.bytes / 4000))
  const sentences = Array.from({ length: Math.ceil((duration * 1000) / SENTENCE_MS) }, (_, i) => ({ text: SENTENCES[i % SENTENCES.length], start: i * SENTENCE_MS, end: Math.min(duration * 1000, (i + 1) * SENTENCE_MS), speaker: i % 2 ? "B" : "A" }))
  const words = sentences.flatMap((s) => {
    const pieces = s.text.split(/(?<=，)/)
    const each = (s.end - s.start) / pieces.length
    return pieces.map((text, i) => ({ text, start: Math.round(s.start + i * each), end: Math.round(s.start + (i + 1) * each), confidence: 0.9, speaker: s.speaker }))
  })
  return {
    id,
    status: "completed",
    text: sentences.map((s) => s.text).join(""),
    language_code: job.language ?? "zh",
    audio_duration: duration,
    words,
    ...(job.speakers ? { utterances: sentences.map((s) => ({ speaker: s.speaker, text: s.text, start: s.start, end: s.end, confidence: 0.9, words: [] })) } : {}),
  }
}
