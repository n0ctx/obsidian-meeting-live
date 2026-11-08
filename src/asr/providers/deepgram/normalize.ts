// Turns Deepgram live messages into the neutral contract.
//   https://developers.deepgram.com/reference/speech-to-text/listen-streaming  (Results, Metadata, Error)
//   https://developers.deepgram.com/docs/understand-endpointing-interim-results  (interim and final results)
//   https://developers.deepgram.com/docs/audio-keep-alive  (word times follow the audio, not the wall clock)
//   https://developers.deepgram.com/docs/diarization  (a `speaker` integer on each word; `diarize=true` still works on streaming though deprecated for `diarize_model`)
import type { AsrUpdate, AsrUtterance } from "../../contract.ts"

/**
 * What one Deepgram message means to the connector.
 *  - results: text to hand to the streamer
 *  - end: the closing summary the server sends after CloseStream, so every final has been sent
 *  - error: an error message the server sent without closing the socket
 *  - ignore: anything that carries no text (SpeechStarted, UtteranceEnd, ConfigureSuccess, …)
 */
export type DeepgramEvent = { kind: "results"; update: AsrUpdate } | { kind: "end" } | { kind: "error"; variant: string; description: string } | { kind: "ignore" }

interface RawWord {
  word?: unknown
  punctuated_word?: unknown
  start?: unknown
  end?: unknown
  speaker?: unknown
}

const CJK = /[⺀-鿿豈-﫿＀-￯]/

/** Words are separated by spaces except between CJK characters, which Deepgram returns one by one. */
function joinWords(words: string[]): string {
  return words.reduce((text, word) => (text && !(CJK.test(text.slice(-1)) && CJK.test(word[0])) ? `${text} ${word}` : text + word), "")
}

/** A string or number as text; anything else (missing, an object) as empty. */
const scalar = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value) : "")

const ms = (seconds: unknown): number => Math.round(Number(seconds) * 1000)

/** Splits one result into runs of a single speaker, using the speaker number on each word (diarize=true). */
function speakerRuns(words: RawWord[], final: boolean): AsrUtterance[] {
  const runs: { speaker: number; words: string[]; start: number; end: number }[] = []
  for (const w of words) {
    const speaker = Number(w.speaker)
    const text = typeof w.punctuated_word === "string" ? w.punctuated_word : typeof w.word === "string" ? w.word : ""
    if (!text || !Number.isFinite(speaker)) continue
    const last = runs[runs.length - 1]
    if (last && last.speaker === speaker) {
      last.words.push(text)
      last.end = ms(w.end)
    } else runs.push({ speaker, words: [text], start: ms(w.start), end: ms(w.end) })
  }
  // Deepgram numbers speakers from 0; people read "speaker 1".
  return runs.map((r) => ({ text: joinWords(r.words), startMs: r.start, endMs: Math.max(r.start, r.end), final, speaker: String(r.speaker + 1) }))
}

/**
 * A Results message covers one stretch of audio since the previous final: an interim is a growing guess for that stretch
 * and replaces the previous interim, a final settles it and the next stretch starts where it ended. Both therefore map to
 * one utterance (or one per speaker), and a message without text leaves no interim behind.
 */
function results(message: Record<string, unknown>, diarize: boolean): AsrUpdate {
  const channel = message.channel as { alternatives?: { transcript?: unknown; words?: RawWord[] }[] } | undefined
  const alternative = channel?.alternatives?.[0]
  const text = typeof alternative?.transcript === "string" ? alternative.transcript.trim() : ""
  if (!text) return { utterances: [] }
  const final = message.is_final === true
  const startMs = ms(message.start)
  const endMs = ms(Number(message.start) + Number(message.duration))
  const runs = diarize && Array.isArray(alternative?.words) ? speakerRuns(alternative.words, final) : []
  if (runs.length === 1) return { utterances: [{ ...runs[0], text, startMs, endMs: Math.max(startMs, endMs) }] }
  if (runs.length > 1) return { utterances: runs }
  return { utterances: [{ text, startMs, endMs: Math.max(startMs, endMs), final }] }
}

export function parseDeepgramMessage(raw: string, diarize: boolean): DeepgramEvent {
  let message: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return { kind: "ignore" }
    message = parsed as Record<string, unknown>
  } catch {
    return { kind: "ignore" }
  }
  switch (message.type) {
    case "Results":
      return { kind: "results", update: results(message, diarize) }
    case "Metadata":
      return { kind: "end" }
    case "Error":
      return { kind: "error", variant: scalar(message.variant), description: scalar(message.description ?? message.message) }
    default:
      return { kind: "ignore" }
  }
}
