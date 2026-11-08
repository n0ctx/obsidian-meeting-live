import assert from "node:assert/strict"
import { test } from "node:test"
import { AsrError, type AsrConnectionHandlers } from "../src/asr/contract.ts"
import { parseDeepgramMessage } from "../src/asr/providers/deepgram/normalize.ts"
import { AsrStreamer } from "../src/asr/streamer.ts"
import type { Utterance } from "../src/meeting/types.ts"

interface Word { word: string; punctuated_word?: string; start: number; end: number; speaker?: number }
const results = (transcript: string, start: number, duration: number, options: { final?: boolean; speechFinal?: boolean; words?: Word[] } = {}) =>
  JSON.stringify({
    type: "Results",
    channel_index: [0, 1],
    duration,
    start,
    is_final: options.final ?? false,
    speech_final: options.speechFinal ?? false,
    channel: { alternatives: [{ transcript, confidence: 0.9, words: options.words ?? [] }] },
    metadata: { request_id: "r" },
  })

/** Streams raw Deepgram messages through the parser into a real AsrStreamer, as the connector does. */
function harness(diarize = false, base = 0) {
  const finals: Utterance[] = []
  let interims: Utterance[] = []
  const connections: { handlers: AsrConnectionHandlers; sent: number }[] = []
  const asr = new AsrStreamer({ onFinal: (u) => finals.push(u), onInterim: (list) => (interims = list), onGap: () => undefined, onState: () => undefined }, { manualTicks: true, finalTimeoutMs: 50, maxChunksPerTick: 100 })
  const connect = async (handlers: AsrConnectionHandlers) => {
    const record = { handlers, sent: 0 }
    connections.push(record)
    return { connection: { sendAudio: (pcm: Int16Array) => void (record.sent += pcm.length), close: () => undefined } }
  }
  const feed = (raw: string, last = false) => {
    const event = parseDeepgramMessage(raw, diarize)
    if (event.kind === "results") connections[connections.length - 1].handlers.onResult(event.update, last)
    return event
  }
  asr.begin(base, connect)
  return { asr, finals, interims: () => interims, feed, connections }
}
const flush = () => new Promise((r) => setImmediate(r))

test("interims replace one another for the same stretch and a final settles it", async () => {
  const h = harness()
  await flush()
  h.feed(results("你", 0, 0.6))
  assert.deepEqual(h.interims().map((u) => [u.text, u.startMs, u.endMs]), [["你", 0, 600]])
  h.feed(results("你好今年", 0, 1.9))
  assert.deepEqual(h.interims().map((u) => [u.text, u.startMs, u.endMs]), [["你好今年", 0, 1900]], "the later interim replaces the earlier one")
  h.feed(results("你好，今年收入三亿。", 0, 3.26, { final: true }))
  assert.deepEqual(h.finals.map((u) => [u.text, u.startMs, u.endMs]), [["你好，今年收入三亿。", 0, 3260]])
  assert.deepEqual(h.interims(), [], "a final leaves no interim behind")
  // The next stretch starts where the final ended.
  h.feed(results("毛利", 3.26, 1.1))
  assert.deepEqual(h.interims().map((u) => [u.text, u.startMs]), [["毛利", 3260]])
  h.feed(results("毛利四成。", 3.26, 2.24, { final: true }))
  assert.deepEqual(h.finals.map((u) => [u.text, u.startMs, u.endMs]), [["你好，今年收入三亿。", 0, 3260], ["毛利四成。", 3260, 5500]])
  h.asr.dispose()
})

test("a repeated final is accepted once, and speech_final on the same message adds nothing", async () => {
  const h = harness()
  await flush()
  h.feed(results("第一句。", 0, 2, { final: true, speechFinal: true }))
  h.feed(results("第一句。", 0, 2, { final: true, speechFinal: true }))
  assert.deepEqual(h.finals.map((u) => u.text), ["第一句。"])
  // Several finals in a row before an endpoint belong to one utterance of speech; each stays its own line.
  h.feed(results("第二句前半", 2, 1.5, { final: true }))
  h.feed(results("第二句后半。", 3.5, 1.5, { final: true, speechFinal: true }))
  assert.deepEqual(h.finals.map((u) => [u.text, u.startMs]), [["第一句。", 0], ["第二句前半", 2000], ["第二句后半。", 3500]])
  h.asr.dispose()
})

test("a message with no text clears the interim and a final with no text adds nothing", async () => {
  const h = harness()
  await flush()
  h.feed(results("还没说完", 0, 1))
  assert.equal(h.interims().length, 1)
  h.feed(results("", 0, 1))
  assert.deepEqual(h.interims(), [])
  h.feed(results("   ", 1, 2, { final: true }))
  assert.deepEqual(h.finals, [])
  h.asr.dispose()
})

test("messages that carry no text are ignored, and the closing summary and errors are recognized", () => {
  for (const type of ["SpeechStarted", "UtteranceEnd", "ConfigureSuccess"]) assert.deepEqual(parseDeepgramMessage(JSON.stringify({ type, timestamp: 1, last_word_end: 2 }), false), { kind: "ignore" })
  assert.deepEqual(parseDeepgramMessage("not json", false), { kind: "ignore" })
  assert.deepEqual(parseDeepgramMessage("[1]", false), { kind: "ignore" })
  assert.deepEqual(parseDeepgramMessage(JSON.stringify({ type: "Metadata", request_id: "r", duration: 3.2 }), false), { kind: "end" })
  assert.deepEqual(parseDeepgramMessage(JSON.stringify({ type: "Error", variant: "SchemaError", description: "bad" }), false), { kind: "error", variant: "SchemaError", description: "bad" })
})

test("times count from the first sample sent on the connection, so a reconnect lands them on the meeting timeline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const h = harness(false, 60_000)
  await flush()
  h.asr.push(new Int16Array(16000 * 4))
  h.asr.tick()
  h.feed(results("第一句。", 0, 1.5, { final: true }))
  h.feed(results("第二句还没", 1.5, 1.2))
  h.connections[0].handlers.onClose(new AsrError("断开", false))
  t.mock.timers.tick(1000)
  await flush()
  h.asr.tick()
  // The second connection begins at 61.5 s, where the first final ended, and is sent the audio from there on (whole 200 ms chunks: 2.4 of the 2.5 s).
  assert.equal(h.connections[1].sent, 16000 * 2.4)
  h.feed(results("第二句还没说完。", 0, 1.9, { final: true }))
  assert.deepEqual(h.finals.map((u) => [u.text, u.startMs, u.endMs]), [["第一句。", 60_000, 61_500], ["第二句还没说完。", 61_500, 63_400]])
  h.asr.dispose()
})

test("with diarization a result is split where the speaker changes, numbered from 1, and a single speaker keeps the formatted text", async () => {
  const h = harness(true)
  await flush()
  const words: Word[] = [
    { word: "hello", punctuated_word: "Hello", start: 0, end: 0.4, speaker: 0 },
    { word: "there", punctuated_word: "there.", start: 0.4, end: 0.9, speaker: 0 },
    { word: "hi", punctuated_word: "Hi", start: 1.2, end: 1.5, speaker: 1 },
    { word: "again", punctuated_word: "again.", start: 1.5, end: 2, speaker: 1 },
  ]
  h.feed(results("Hello there. Hi again.", 0, 2.2, { final: true, words }))
  assert.deepEqual(h.finals.map((u) => [u.text, u.startMs, u.endMs, u.speaker]), [["Hello there.", 0, 900, "1"], ["Hi again.", 1200, 2000, "2"]])
  h.feed(results("Fine, thanks.", 2.2, 1, { final: true, words: [{ word: "fine", start: 2.2, end: 2.6, speaker: 1 }, { word: "thanks", start: 2.6, end: 3.1, speaker: 1 }] }))
  assert.deepEqual(h.finals[2], { text: "Fine, thanks.", startMs: 2200, endMs: 3200, speaker: "2" })
  // Chinese words come back one by one and are joined without spaces.
  const zh = parseDeepgramMessage(results("你好 世界", 4, 1, { final: true, words: [{ word: "你好", start: 4, end: 4.4, speaker: 0 }, { word: "世界", start: 4.4, end: 5, speaker: 1 }] }), true)
  assert.equal(zh.kind === "results" && zh.update.utterances.map((u) => u.text).join("|"), "你好|世界")
  const joined = parseDeepgramMessage(results("", 0, 1, { final: true, words: [{ word: "你", start: 0, end: 0.2, speaker: 0 }, { word: "好", start: 0.2, end: 0.4, speaker: 0 }] }), true)
  assert.deepEqual(joined.kind === "results" && joined.update.utterances, [], "no transcript text means nothing to emit, whatever the words say")
  // Without diarization the speaker field is never read.
  const plain = parseDeepgramMessage(results("Hello there. Hi again.", 0, 2.2, { final: true, words }), false)
  assert.equal(plain.kind === "results" && plain.update.utterances.length, 1)
  assert.equal(plain.kind === "results" && plain.update.utterances[0].speaker, undefined)
  h.asr.dispose()
})
