import assert from "node:assert/strict"
import { test } from "node:test"
import { transcribeChunks } from "../src/asr/chunked.ts"
import { renderInterviewRecord, speakerUtterances, type FileAsrProvider, type FileAsrResult } from "../src/asr/fileAsr.ts"
import { cutPoints } from "../src/audio/chunking.ts"
import type { AudioChunk } from "../src/audio/transcode.ts"
import { buildMinutesMessages } from "../src/llm/minutes.ts"

const RATE = 16000

/** Noise of amplitude 0.5 with silences at the given seconds (each 0.5 s long). */
function signal(seconds: number, quietAt: number[] = []): Float32Array {
  const samples = new Float32Array(seconds * RATE)
  for (let i = 0; i < samples.length; i++) samples[i] = (i % 7) % 2 ? 0.5 : -0.5
  for (const at of quietAt) samples.fill(0, at * RATE, (at + 0.5) * RATE)
  return samples
}

test("cuts keep every piece under the size, cover the whole recording and land in a pause when there is one", () => {
  const total = 100
  const samples = signal(total, [38.2, 71.0])
  const cuts = cutPoints(samples, 40 * RATE, 10 * RATE, RATE)
  assert.equal(cuts[0], 0)
  assert.equal(cuts.at(-1), samples.length)
  for (let i = 0; i + 1 < cuts.length; i++) {
    assert.ok(cuts[i + 1] > cuts[i])
    assert.ok(cuts[i + 1] - cuts[i] <= 40 * RATE, `piece ${i} is too long`)
  }
  // The nominal cuts at 40 s and 80 s move back into the silences at 38.2-38.7 s and 71.0-71.5 s.
  assert.equal(cuts.length, 4)
  assert.ok(cuts[1] >= 38.2 * RATE && cuts[1] <= 38.7 * RATE, `first cut at ${cuts[1] / RATE}`)
  assert.ok(cuts[2] >= 71.0 * RATE && cuts[2] <= 71.5 * RATE + RATE * 0.1, `second cut at ${cuts[2] / RATE}`)
})

test("a recording that fits is one piece, and without a pause the cut falls within reach of the even split", () => {
  const short = signal(10)
  assert.deepEqual(cutPoints(short, 40 * RATE, 5 * RATE, RATE), [0, short.length])
  const noise = signal(60)
  const cuts = cutPoints(noise, 25 * RATE, 3 * RATE, RATE)
  assert.ok(cuts[1] >= 22 * RATE && cuts[1] <= 25 * RATE)
})

const chunk = (offsetMs: number, durationMs: number): AudioChunk => ({ data: new Uint8Array([1, 2, 3]), format: "ogg", transcoded: true, bytes: 3, offsetMs, durationMs })

function provider(replies: (index: number) => FileAsrResult | Error): FileAsrProvider & { calls: number } {
  const p = {
    calls: 0,
    id: "fake",
    name: "示例",
    host: "h",
    model: "m",
    capabilities: { language: false, diarization: true, fileSizeLimit: 10 },
    directFormats: {},
    transcribe: async () => {
      const reply = replies(p.calls++)
      if (reply instanceof Error) throw reply
      return reply
    },
  }
  return p
}

const call = { speakers: true, post: async () => ({ status: 200, headers: {}, text: "" }) }
const part = (durationMs: number, speaker?: string): FileAsrResult => ({
  durationMs,
  text: "文本",
  utterances: [
    { text: "开头。", startMs: 0, endMs: 2000, speaker },
    { text: "结尾。", startMs: durationMs - 3000, endMs: durationMs - 500, speaker },
  ],
})

test("pieces are recognized in order and each one's times move by where it starts in the recording", async () => {
  const chunks = [chunk(0, 60_000), chunk(60_000, 60_000), chunk(120_000, 30_000)]
  const seen: [number, number][] = []
  const merged = await transcribeChunks(provider((i) => part([60_000, 60_000, 30_000][i], i === 1 ? "2" : "1")), chunks, { ...call, onPart: (i, n) => seen.push([i, n]) })
  assert.deepEqual(seen, [[0, 3], [1, 3], [2, 3]])
  assert.deepEqual(merged.utterances.map((u) => [u.startMs, u.endMs, u.speaker]), [
    [0, 2000, "1"], [57_000, 59_500, "1"],
    [60_000, 62_000, "2"], [117_000, 119_500, "2"],
    [120_000, 122_000, "1"], [147_000, 149_500, "1"],
  ])
  assert.equal(merged.durationMs, 150_000)
  assert.equal(merged.chunks, 3)
})

test("a single piece comes back as it is, without a piece count", async () => {
  const only = part(30_000)
  const merged = await transcribeChunks(provider(() => only), [chunk(0, 30_000)], call)
  assert.equal(merged, only)
  assert.equal(merged.chunks, undefined)
})

test("pieces that report no timing stay one block each at their own start, and the coverage check is skipped but emptiness is not", async () => {
  const textOnly = (text: string): FileAsrResult => ({ durationMs: 0, text, utterances: [{ text, startMs: 0, endMs: 0 }] })
  const merged = await transcribeChunks(provider((i) => textOnly(`第${i}段文字`)), [chunk(0, 600_000), chunk(600_000, 600_000), chunk(1_200_000, 600_000)], call)
  assert.deepEqual(merged.utterances.map((u) => [u.startMs, u.text]), [[0, "第0段文字"], [600_000, "第1段文字"], [1_200_000, "第2段文字"]])
  assert.equal(merged.durationMs, 0)
  await assert.rejects(transcribeChunks(provider(() => ({ durationMs: 0, text: "", utterances: [] })), [chunk(0, 1000), chunk(1000, 1000)], call), /第 1\/2 段：识别结果为空/)
})

test("a piece that comes back truncated or fails stops the job and names the piece", async () => {
  const truncated: FileAsrResult = { durationMs: 600_000, text: "x", utterances: [{ text: "x", startMs: 0, endMs: 60_000 }] }
  await assert.rejects(transcribeChunks(provider((i) => (i === 1 ? truncated : part(600_000))), [chunk(0, 600_000), chunk(600_000, 600_000)], call), /第 2\/2 段：识别结果不完整/)
  await assert.rejects(transcribeChunks(provider(() => new Error("HTTP 429")), [chunk(0, 1000), chunk(1000, 1000)], call), /第 1\/2 段：HTTP 429/)
  // A recording that was never cut reports the plain message.
  await assert.rejects(transcribeChunks(provider(() => new Error("HTTP 429")), [chunk(0, 1000)], call), (error: Error) => error.message === "HTTP 429")
})

test("a retry keeps what was recognized and continues with the first piece that failed", async () => {
  const chunks = [chunk(0, 60_000), chunk(60_000, 60_000), chunk(120_000, 60_000)]
  const done: FileAsrResult[] = []
  const flaky = provider((i) => (i === 1 ? new Error("网络中断") : part(60_000)))
  await assert.rejects(transcribeChunks(flaky, chunks, call, done), /第 2\/3 段：网络中断/)
  assert.equal(done.length, 1)
  assert.equal(flaky.calls, 2)

  const second = provider(() => part(60_000))
  const merged = await transcribeChunks(second, chunks, call, done)
  assert.equal(second.calls, 2, "only the two missing pieces are recognized again")
  assert.equal(merged.utterances.length, 6)
  assert.equal(merged.durationMs, 180_000)
})

test("labels may not match across pieces, and the transcript and the model are told so; no duration is shown when none is known", () => {
  const labelled: FileAsrResult = { durationMs: 120_000, text: "t", chunks: 2, utterances: [{ text: "甲。", startMs: 0, endMs: 1000, speaker: "1" }, { text: "乙。", startMs: 70_000, endMs: 71_000, speaker: "2" }] }
  const meta = { title: "x", source: "a.mp3", transcribedAt: "t", provider: "示例", model: "m" }
  assert.match(renderInterviewRecord(labelled, meta, false), /> 录音较长，分 2 段分别识别，说话人编号在各段之间不一定对应同一个人。/)
  assert.doesNotMatch(renderInterviewRecord({ ...labelled, chunks: undefined }, meta, false), /分 2 段/)
  assert.doesNotMatch(renderInterviewRecord({ ...labelled, utterances: labelled.utterances.map((u) => ({ ...u, speaker: undefined })) }, meta, false), /分 2 段/)
  const unknownLength = renderInterviewRecord({ ...labelled, durationMs: 0 }, meta, false)
  assert.doesNotMatch(unknownLength, /时长/)
  assert.match(unknownLength, /> 2 位说话人 · 2 句/)

  const [, user] = buildMinutesMessages("", { title: "访谈", date: "d", utterances: speakerUtterances(labelled), summaries: [], notes: [], speakerNote: "Note: speaker numbers may not match across parts." })
  assert.match(user.content, /## Transcript\nNote: speaker numbers may not match across parts\.\n\[00:00:00\] 说话人1：甲。/)
})
