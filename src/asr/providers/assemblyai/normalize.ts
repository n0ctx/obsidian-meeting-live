// Turns AssemblyAI Universal-Streaming (v3) messages into the neutral contract.
//   https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api  (Begin, Turn, Termination, word times in ms)
// A Turn carries the text of one turn so far; `end_of_turn` settles it. Word times are milliseconds and, as the quickstart's first
// word starting at 0 suggests, count from the start of the session (not stated). A turn with no words takes its span from the audio sent.
import type { AsrUpdate } from "../../contract.ts"

/**
 *  - begin: the session is open and takes audio
 *  - results: text for the streamer
 *  - end: the closing message after Terminate, so every final has been sent
 *  - error: an error frame the server sends before it closes the socket
 *  - ignore: anything without text (SpeechStarted, SpeakerRevision, Heartbeat, ...)
 */
export type AssemblyAiEvent = { kind: "begin" } | { kind: "results"; update: AsrUpdate } | { kind: "end" } | { kind: "error"; code: string; message: string } | { kind: "ignore" }

export interface TurnContext {
  /** Audio sent so far, in ms. */
  sentMs: number
  /** Where the previous turn ended, for a turn that comes without word times. */
  afterMs: number
  /** The session asked for `format_turns`, so only the formatted copy of a finished turn is final. */
  formatTurns: boolean
}

const scalar = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value) : "")
const ms = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined)

function turn(message: Record<string, unknown>, ctx: TurnContext): AsrUpdate {
  const text = typeof message.transcript === "string" ? message.transcript.trim() : ""
  if (!text) return { utterances: [] }
  const words = Array.isArray(message.words) ? (message.words as { start?: unknown; end?: unknown }[]) : []
  const startMs = ms(words[0]?.start) ?? ctx.afterMs
  const endMs = Math.max(startMs, ms(words[words.length - 1]?.end) ?? ctx.sentMs)
  const final = message.end_of_turn === true && (!ctx.formatTurns || message.turn_is_formatted === true)
  const speaker = scalar(message.speaker_label).trim()
  return { utterances: [{ text, startMs, endMs, final, ...(speaker ? { speaker } : {}) }] }
}

export function parseAssemblyAiMessage(raw: string, ctx: TurnContext): AssemblyAiEvent {
  let message: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return { kind: "ignore" }
    message = parsed as Record<string, unknown>
  } catch {
    return { kind: "ignore" }
  }
  switch (message.type) {
    case "Begin":
      return { kind: "begin" }
    case "Turn":
      return { kind: "results", update: turn(message, ctx) }
    case "Termination":
      return { kind: "end" }
    case "Error":
      return { kind: "error", code: scalar(message.error_code), message: scalar(message.error ?? message.message) }
    default:
      return "error_code" in message ? { kind: "error", code: scalar(message.error_code), message: scalar(message.error ?? message.message) } : { kind: "ignore" }
  }
}
