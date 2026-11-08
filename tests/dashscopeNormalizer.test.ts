import assert from "node:assert/strict"
import { test } from "node:test"
import { parseDashScopeMessage } from "../src/asr/providers/dashscope/normalize.ts"

const result = (sentence: object | null) => JSON.stringify({ header: { task_id: "t", event: "result-generated", attributes: {} }, payload: { output: { sentence } } })

test("an open sentence is an interim that ends where the audio sent so far ends", () => {
  const event = parseDashScopeMessage(result({ sentence_id: 1, begin_time: 170, end_time: null, text: " 你好，", sentence_begin: false, sentence_end: false, heartbeat: false }), 3400)
  assert.deepEqual(event, { kind: "result", update: { utterances: [{ text: "你好，", startMs: 170, endMs: 3400, final: false }] } })
})

test("a finished sentence is final with its own times, falling back to the last word when the end is missing", () => {
  const withEnd = parseDashScopeMessage(result({ begin_time: 170, end_time: 920, text: "好的。", sentence_end: true }), 5000)
  assert.deepEqual(withEnd, { kind: "result", update: { utterances: [{ text: "好的。", startMs: 170, endMs: 920, final: true }] } })
  // The documentation's own final example shows end_time null.
  const wordEnd = parseDashScopeMessage(result({ begin_time: 170, end_time: null, text: "好的。", sentence_end: true, words: [{ begin_time: 170, end_time: 600 }, { begin_time: 600, end_time: 880 }] }), 5000)
  assert.deepEqual(wordEnd.kind === "result" && wordEnd.update.utterances[0].endMs, 880)
  // Neither end nor words: the audio sent so far, and never before the start.
  const bare = parseDashScopeMessage(result({ begin_time: 9000, end_time: null, text: "x", sentence_end: true }), 4000)
  assert.deepEqual(bare.kind === "result" && bare.update.utterances[0], { text: "x", startMs: 9000, endMs: 9000, final: true })
})

test("the start of a sentence without text clears the interim; a heartbeat leaves it alone", () => {
  assert.deepEqual(parseDashScopeMessage(result({ sentence_id: 2, begin_time: 1640, end_time: null, text: "", sentence_begin: true, sentence_end: false }), 1700), { kind: "result", update: { utterances: [] } })
  assert.deepEqual(parseDashScopeMessage(result({ sentence_id: 0, begin_time: 0, text: "", heartbeat: true }), 1700), { kind: "result", update: { utterances: [], keepInterims: true } })
  assert.deepEqual(parseDashScopeMessage(result(null), 0), { kind: "result", update: { utterances: [], keepInterims: true } })
})

test("task events map to what the connector needs, and anything else is ignored", () => {
  const event = (name: string, header: object = {}) => JSON.stringify({ header: { task_id: "t", event: name, ...header }, payload: {} })
  assert.deepEqual(parseDashScopeMessage(event("task-started"), 0), { kind: "started" })
  assert.deepEqual(parseDashScopeMessage(event("task-finished"), 0), { kind: "finished" })
  assert.deepEqual(parseDashScopeMessage(event("task-failed", { error_code: "CLIENT_ERROR", error_message: "request timeout after 23 seconds." }), 0), { kind: "failed", code: "CLIENT_ERROR", message: "request timeout after 23 seconds." })
  assert.deepEqual(parseDashScopeMessage(event("task-failed"), 0), { kind: "failed", code: "", message: "" })
  for (const raw of [event("something-new"), "not json", "null", "42", "{}"]) assert.deepEqual(parseDashScopeMessage(raw, 0), { kind: "ignore" })
})
