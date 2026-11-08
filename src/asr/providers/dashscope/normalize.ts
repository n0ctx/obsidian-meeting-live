// Turns DashScope realtime recognition events into the neutral contract.
//   https://www.alibabacloud.com/help/en/model-studio/qwen-audio-asr-streaming-server-events  (result-generated: output.sentence, task-failed)
//   https://www.alibabacloud.com/help/en/model-studio/fun-asr-server-events  (same event shapes for Fun-ASR)
// begin_time and end_time are milliseconds. The pages do not say what they count from; their examples start near 0, so they are
// read as offsets from the first audio sample sent in the task (not confirmed). An open sentence has end_time null: its end is
// then the audio sent so far, taken from the connector's SentAudioClock.
import type { AsrUpdate } from "../../contract.ts"

/**
 *  - started: the server is ready for audio
 *  - result: text for the streamer
 *  - finished: every result has been sent after finish-task
 *  - failed: the task ended with an error
 *  - ignore: anything without content (heartbeats, unknown events)
 */
export type DashScopeEvent = { kind: "started" } | { kind: "result"; update: AsrUpdate } | { kind: "finished" } | { kind: "failed"; code: string; message: string } | { kind: "ignore" }

const scalar = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value) : "")

const ms = (value: unknown): number | undefined => {
  const n = Number(value)
  return value !== null && value !== undefined && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined
}

interface RawSentence {
  text?: unknown
  begin_time?: unknown
  end_time?: unknown
  sentence_end?: unknown
  heartbeat?: unknown
  words?: { end_time?: unknown }[]
}

function result(sentence: RawSentence | undefined, sentMs: number): AsrUpdate {
  if (!sentence) return { utterances: [], keepInterims: true }
  if (sentence.heartbeat === true) return { utterances: [], keepInterims: true }
  const text = typeof sentence.text === "string" ? sentence.text.trim() : ""
  if (!text) return { utterances: [] }
  const startMs = ms(sentence.begin_time) ?? 0
  const lastWord = Array.isArray(sentence.words) ? ms(sentence.words[sentence.words.length - 1]?.end_time) : undefined
  const endMs = Math.max(startMs, ms(sentence.end_time) ?? lastWord ?? sentMs)
  return { utterances: [{ text, startMs, endMs, final: sentence.sentence_end === true }] }
}

export function parseDashScopeMessage(raw: string, sentMs: number): DashScopeEvent {
  let message: { header?: Record<string, unknown>; payload?: { output?: { sentence?: RawSentence } } }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return { kind: "ignore" }
    message = parsed as typeof message
  } catch {
    return { kind: "ignore" }
  }
  switch (message.header?.event) {
    case "task-started":
      return { kind: "started" }
    case "result-generated":
      return { kind: "result", update: result(message.payload?.output?.sentence, sentMs) }
    case "task-finished":
      return { kind: "finished" }
    case "task-failed":
      return { kind: "failed", code: scalar(message.header.error_code), message: scalar(message.header.error_message) }
    default:
      return { kind: "ignore" }
  }
}
