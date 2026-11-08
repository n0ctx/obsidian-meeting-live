import assert from "node:assert/strict"
import { test } from "node:test"
import { parseAssemblyAiMessage, type TurnContext } from "../src/asr/providers/assemblyai/normalize.ts"

const ctx = (patch: Partial<TurnContext> = {}): TurnContext => ({ sentMs: 6000, afterMs: 2500, formatTurns: false, ...patch })
const turn = (patch: object) => JSON.stringify({ type: "Turn", turn_order: 0, turn_is_formatted: true, end_of_turn: false, end_of_turn_confidence: 0.1, transcript: "你好，今天", words: [{ text: "你好，", start: 120, end: 640, confidence: 0.9, word_is_final: true }, { text: "今天", start: 700, end: 1100, confidence: 0.9, word_is_final: false }], ...patch })

test("a turn in progress is an interim spanning its words, and a finished one is final", () => {
  assert.deepEqual(parseAssemblyAiMessage(turn({}), ctx()), { kind: "results", update: { utterances: [{ text: "你好，今天", startMs: 120, endMs: 1100, final: false }] } })
  const final = parseAssemblyAiMessage(turn({ end_of_turn: true, transcript: " 你好，今天天气不错。 " }), ctx())
  assert.deepEqual(final.kind === "results" && final.update.utterances[0], { text: "你好，今天天气不错。", startMs: 120, endMs: 1100, final: true })
})

test("with format_turns only the formatted copy of a finished turn is final; the unformatted one stays an interim", () => {
  const unformatted = parseAssemblyAiMessage(turn({ end_of_turn: true, turn_is_formatted: false }), ctx({ formatTurns: true }))
  assert.equal(unformatted.kind === "results" && unformatted.update.utterances[0].final, false)
  const formatted = parseAssemblyAiMessage(turn({ end_of_turn: true, turn_is_formatted: true }), ctx({ formatTurns: true }))
  assert.equal(formatted.kind === "results" && formatted.update.utterances[0].final, true)
})

test("a turn without word times spans from where the last one ended to the audio sent so far", () => {
  const event = parseAssemblyAiMessage(turn({ words: [], end_of_turn: true }), ctx())
  assert.deepEqual(event.kind === "results" && event.update.utterances[0], { text: "你好，今天", startMs: 2500, endMs: 6000, final: true })
})

test("an empty turn clears the interim", () => {
  assert.deepEqual(parseAssemblyAiMessage(turn({ transcript: "  ", words: [] }), ctx()), { kind: "results", update: { utterances: [] } })
})

test("the speaker label of a turn becomes the utterance's speaker, only when there is one", () => {
  const labelled = parseAssemblyAiMessage(turn({ end_of_turn: true, speaker_label: "B" }), ctx())
  assert.equal(labelled.kind === "results" && labelled.update.utterances[0].speaker, "B")
  const plain = parseAssemblyAiMessage(turn({ end_of_turn: true }), ctx())
  assert.equal(plain.kind === "results" && "speaker" in plain.update.utterances[0], false)
})

test("session messages map to what the connector needs, and anything else is ignored", () => {
  assert.deepEqual(parseAssemblyAiMessage(JSON.stringify({ type: "Begin", id: "x", expires_at: 1 }), ctx()), { kind: "begin" })
  assert.deepEqual(parseAssemblyAiMessage(JSON.stringify({ type: "Termination", audio_duration_seconds: 3, session_duration_seconds: 4 }), ctx()), { kind: "end" })
  assert.deepEqual(parseAssemblyAiMessage(JSON.stringify({ error_code: 1008, error: "Unauthorized Connection: Invalid API key" }), ctx()), { kind: "error", code: "1008", message: "Unauthorized Connection: Invalid API key" })
  assert.deepEqual(parseAssemblyAiMessage(JSON.stringify({ type: "Error", error_code: 3005, error: "boom" }), ctx()), { kind: "error", code: "3005", message: "boom" })
  for (const raw of [JSON.stringify({ type: "SpeechStarted", timestamp: 1, confidence: 0.5 }), JSON.stringify({ type: "SpeakerRevision", revisions: [] }), "not json", "null", "7"]) assert.deepEqual(parseAssemblyAiMessage(raw, ctx()), { kind: "ignore" })
})
