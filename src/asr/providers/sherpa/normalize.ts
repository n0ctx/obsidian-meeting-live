// Turns the JSON messages of sherpa-onnx's streaming WebSocket server into the neutral contract.
//   https://k2-fsa.github.io/sherpa/onnx/websocket/online-websocket.html  (server, client, audio and "Done")
//   https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/online-websocket-server-impl.cc  (binary frames are float32 samples; "Done" text ends the input; "Done!" is the last reply; is_final at an endpoint, is_eof after "Done")
//   https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/online-recognizer.cc  (the JSON fields of a result, in AsJsonString)
import type { AsrUpdate, AsrUtterance } from "../../contract.ts"
import { closeCjkSpaces } from "../../cjk.ts"

/**
 * One reply of the server. Every decoding step sends the whole text of the current segment so far:
 *  - text: the segment's text, with spaces between Chinese words
 *  - start_time: seconds from the first sample of the connection to where the segment starts (some older servers do not send it)
 *  - timestamps: seconds of each token, counted from the segment's start
 *  - is_final: the segment ended at an endpoint (silence) and the next reply starts a new one
 *  - is_eof: the last reply after the client said "Done"
 */
export interface SherpaResult {
  update: AsrUpdate
  /** The server has nothing more to say about the audio it was given. */
  last: boolean
}

const seconds = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

/**
 * Remembers where the current segment started, so it must not outlive its connection. `now` reads how much audio has been sent
 * (a `SentAudioClock`): it stands in for the server's times when they are missing, so a segment then starts when its first text
 * arrives and ends when the reply that closes it does, a little late by however long recognition takes.
 */
export class SherpaNormalizer {
  private segment: number | undefined
  private startedMs: number | undefined
  private readonly now: () => number

  constructor(now: () => number) {
    this.now = now
  }

  update(raw: unknown): SherpaResult | undefined {
    if (!raw || typeof raw !== "object") return undefined
    const message = raw as Record<string, unknown>
    if (typeof message.text !== "string") return undefined
    const text = closeCjkSpaces(message.text).trim()
    const final = message.is_final === true
    const last = message.is_eof === true
    const segment = seconds(message.segment)
    if (segment !== this.segment) {
      this.segment = segment
      this.startedMs = undefined
    }
    const update: AsrUpdate = { utterances: [] }
    if (text) {
      const startMs = this.startOf(message)
      const endMs = this.endOf(message, startMs, final)
      const utterance: AsrUtterance = { text, startMs, endMs, final }
      update.utterances.push(utterance)
    }
    // The closing reply settles what the last interim said; it is no reason to blank the line before the finals land.
    if (last && !text) update.keepInterims = true
    return { update, last }
  }

  private startOf(message: Record<string, unknown>): number {
    const given = seconds(message.start_time)
    if (given !== undefined) return Math.round(given * 1000)
    this.startedMs ??= this.now()
    return this.startedMs
  }

  private endOf(message: Record<string, unknown>, startMs: number, final: boolean): number {
    const stamps = Array.isArray(message.timestamps) ? message.timestamps.map(seconds).filter((s): s is number => s !== undefined) : []
    const given = seconds(message.start_time)
    if (given !== undefined) return Math.max(startMs, Math.round((given + (stamps.at(-1) ?? 0)) * 1000))
    return Math.max(startMs, final ? this.now() : startMs + Math.round((stamps.at(-1) ?? 0) * 1000))
  }
}
