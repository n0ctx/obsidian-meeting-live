import assert from "node:assert/strict"
import { test } from "node:test"
import { decodeClientFrame, decodeServerFrame, encodeAudio, encodeFullRequest, encodeServerError, encodeServerResult } from "../src/asr/volcProtocol.ts"
import { audioLine, gapLine, parseTranscript, transcriptHeader, utteranceLine } from "../src/meeting/transcriptFormat.ts"
import { formatClock, parseClock } from "../src/meeting/types.ts"

test("client and server frames round-trip", () => {
  const full = decodeClientFrame(encodeFullRequest({ a: 1 }))
  assert.equal(full.type, 1)
  assert.deepEqual(JSON.parse(full.payload.toString()), { a: 1 })
  const audio = decodeClientFrame(encodeAudio(Buffer.from([1, 2, 3, 4]), true))
  assert.equal(audio.last, true)
  assert.deepEqual([...audio.payload], [1, 2, 3, 4])
  const result = decodeServerFrame(encodeServerResult(3, { result: { text: "你好" } }, true))
  assert.deepEqual(result, { kind: "result", last: true, data: { result: { text: "你好" } } })
  const error = decodeServerFrame(encodeServerError(45000081, "timeout"))
  assert.deepEqual(error, { kind: "error", code: 45000081, message: "timeout" })
})

test("transcript markdown round-trips and ignores other lines", () => {
  const md =
    transcriptHeader({ id: "m-1", notePath: "Interview/a.md", createdAt: "2026-10-27T14:30:00+08:00" }) +
    audioLine("Meetings/a/audio/a 录音 01.ogg") +
    utteranceLine({ startMs: 3200, endMs: 5600, text: "公司去年收入 3 亿，\n毛利 40%" }) +
    gapLine({ startMs: 6000, endMs: 9000, reason: "网络中断" }) +
    utteranceLine({ startMs: 9100, endMs: 9900, text: "[注意] ^ 符号" }) +
    utteranceLine({ startMs: 3200, endMs: 5600, text: "重复" }) +
    "[00:00:0"
  const parsed = parseTranscript(md)
  assert.deepEqual(parsed, [
    { startMs: 3200, endMs: 5600, text: "公司去年收入 3 亿， 毛利 40%" },
    { startMs: 9100, endMs: 9900, text: "[注意] ^ 符号" },
  ])
})

test("clock formatting", () => {
  assert.equal(formatClock(65_000), "01:05")
  assert.equal(formatClock(3_725_000), "01:02:05")
  assert.equal(formatClock(5_000, true), "00:00:05")
  assert.equal(parseClock("01:02:05"), 3_725_000)
  assert.equal(parseClock("12:30"), 750_000)
  assert.equal(parseClock("x"), undefined)
})
