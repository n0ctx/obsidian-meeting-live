// The adapters against dev/mock-server.ts: a real process speaking Deepgram's, OpenAI's, Volcengine's and an LLM's wire shapes
// on 127.0.0.1, so nothing here can reach a paid service or needs a key.
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { after, before, test } from "node:test"
import { transcribeChunks } from "../src/asr/chunked.ts"
import type { AsrError } from "../src/asr/contract.ts"
import type { FileAsrPost } from "../src/asr/fileAsr.ts"
import { deepgramConnector } from "../src/asr/providers/deepgram/live.ts"
import { openAiFileProvider } from "../src/asr/providers/openaiCompat/file.ts"
import { volcConnector } from "../src/asr/providers/volc/live.ts"
import { runLiveTest } from "../src/asr/providers/liveTest.ts"
import { AsrStreamer, type AsrState } from "../src/asr/streamer.ts"
import type { AudioChunk } from "../src/audio/transcode.ts"
import { chat } from "../src/llm/client.ts"
import { presetById } from "../src/llm/presets.ts"
import type { TranscriptGap, Utterance } from "../src/meeting/types.ts"

let server: ChildProcess
let base = ""

before(async () => {
  server = spawn(process.execPath, ["--import", "./tests/support/register.mjs", "dev/mock-server.ts", "0"], { stdio: ["ignore", "pipe", "inherit"] })
  base = await new Promise<string>((resolve, reject) => {
    server.stdout!.on("data", (chunk: Buffer) => {
      const match = /mock server on (http:\/\/127\.0\.0\.1:\d+)/.exec(chunk.toString())
      if (match) resolve(match[1])
    })
    server.on("exit", (code) => reject(new Error(`mock server exited with ${code}`)))
  })
})
after(() => server.kill())

const stats = async () => (await (await fetch(`${base}/stats`)).json()) as { deepgramConnections: number; keepAlives: number; binaryFrames: number; emptyFrames: number; closeStreams: number }
const wsBase = () => base.replace("http", "ws")
const flush = () => new Promise((r) => setTimeout(r, 5))
async function waitFor(condition: () => boolean, ms = 8000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > ms) assert.fail("timed out waiting")
    await new Promise((r) => setTimeout(r, 10))
  }
}

const deepgram = (apiKey = "k") => deepgramConnector({ endpoint: `${wsBase()}/v1/listen`, apiKey, model: "nova-3", language: "zh", diarize: false })

function recorder() {
  const finals: Utterance[] = []
  const gaps: TranscriptGap[] = []
  const states: AsrState[] = []
  let interims: Utterance[] = []
  const events = { onFinal: (u: Utterance) => finals.push(u), onInterim: (list: Utterance[]) => (interims = list), onGap: (g: TranscriptGap) => gaps.push(g), onState: (s: AsrState) => states.push(s) }
  return { events, finals, gaps, states, interims: () => interims }
}

test("Deepgram through the streamer: a forced drop mid-meeting recovers with no duplicate and no lost final", async () => {
  const before = await stats()
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true, maxChunksPerTick: 1000, finalTimeoutMs: 3000 })
  asr.begin(0, deepgram())
  await waitFor(() => asr.currentState === "live")

  const TOTAL_S = 14
  const feed = async (from: number, to: number) => {
    for (let s = from; s < to; s++) {
      asr.push(new Int16Array(16000).fill(200))
      asr.tick()
      await flush()
    }
  }
  await feed(0, 7)
  await waitFor(() => rec.finals.length >= 1)
  const finalsBeforeDrop = rec.finals.length

  assert.equal((await fetch(`${base}/drop`, { method: "POST" })).status, 200)
  await waitFor(() => asr.currentState === "reconnecting")
  // Audio keeps arriving while the connection is down; it waits in the buffer and goes out once it is back.
  await feed(7, 10)
  await waitFor(() => asr.currentState === "live", 10_000)
  asr.tick()
  await feed(10, TOTAL_S)
  await asr.end()

  assert.ok(finalsBeforeDrop >= 1, "the drop came after the first final")
  assert.deepEqual(rec.gaps, [], "nothing was lost to a gap")
  assert.ok(rec.states.includes("reconnecting") && rec.states.at(-1) === "idle")
  assert.deepEqual(rec.interims(), [])
  assert.ok((await stats()).deepgramConnections - before.deepgramConnections >= 2, "the drop forced a second connection")

  // No duplicates: each final starts after the previous ended, and no start repeats.
  const starts = rec.finals.map((u) => Math.round(u.startMs))
  assert.equal(new Set(starts).size, starts.length)
  // No lost speech: the finals tile the audio from the first sample to the last, across the reconnect as well.
  assert.ok(Math.abs(rec.finals[0].startMs) <= 1)
  for (let i = 1; i < rec.finals.length; i++) assert.ok(Math.abs(rec.finals[i].startMs - rec.finals[i - 1].endMs) <= 2, `final ${i} starts at ${rec.finals[i].startMs}, the one before ended at ${rec.finals[i - 1].endMs}`)
  assert.ok(Math.abs(rec.finals.at(-1)!.endMs - TOTAL_S * 1000) <= 2, `last final ends at ${rec.finals.at(-1)!.endMs}`)
  for (const u of rec.finals) assert.ok(u.text.length > 0)
})

test("Deepgram end of stream: CloseStream makes the server send the last final and close, and no empty frame is sent", async () => {
  const before = await stats()
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true, maxChunksPerTick: 1000, finalTimeoutMs: 3000 })
  asr.begin(0, deepgram())
  await waitFor(() => asr.currentState === "live")
  asr.push(new Int16Array(16000 * 2).fill(100))
  asr.tick()
  await flush()
  await asr.end()
  const after = await stats()
  assert.equal(after.closeStreams - before.closeStreams, 1)
  assert.equal(after.emptyFrames - before.emptyFrames, 0, "the end of the audio is never an empty frame")
  assert.equal(rec.finals.length, 1, "the stretch still in progress is settled by the server on CloseStream")
  assert.ok(Math.abs(rec.finals[0].endMs - 2000) <= 2)
  assert.equal(asr.currentState, "idle")
})

test("Deepgram connection errors come back as the fatal kind the streamer stops on", async () => {
  const error = (await deepgram("bad")({ onResult: () => undefined, onClose: () => undefined }).catch((e: unknown) => e)) as AsrError
  assert.equal(error.fatal, true)
  assert.match(error.message, /鉴权失败/)

  const failing = new AsrStreamer(recorder().events, { manualTicks: true })
  failing.begin(0, deepgram("bad"))
  await waitFor(() => failing.currentState === "failed")
  failing.dispose()
})

test("the test button's connection check passes against the mock and reports a refused key", async () => {
  assert.deepEqual(await runLiveTest(deepgram()), { ok: true, logId: undefined })
  const refused = await runLiveTest(deepgram("bad"))
  assert.equal(refused.ok, false)
  assert.match(refused.message ?? "", /鉴权失败/)
})

/** A requestUrl stand-in over fetch, so the adapter's bytes cross a real socket. */
const post: FileAsrPost = async (url, headers, body) => {
  const response = await fetch(url, { method: "POST", headers, body })
  return { status: response.status, headers: Object.fromEntries(response.headers), text: await response.text() }
}
const upload = (seconds: number, offsetMs = 0): AudioChunk => ({ data: new Uint8Array(seconds * 4000).fill(7), format: "ogg", transcoded: true, bytes: seconds * 4000, offsetMs, durationMs: seconds * 1000 })

test("the OpenAI-compatible adapter against the mock: timed segments, text-only models, diarized segments and error mapping", async () => {
  const file = (model: string, apiKey = "k") => openAiFileProvider({ baseUrl: `${base}/v1`, model, apiKey, language: "zh", fileSizeLimit: 25 * 1024 * 1024 })
  const timed = await file("whisper-1").transcribe(upload(30), { speakers: false, post })
  assert.equal(timed.durationMs, 30_000)
  assert.ok(timed.utterances.length >= 7)
  assert.equal(timed.utterances[0].startMs, 0)
  assert.equal(timed.utterances[1].startMs, 4200)

  // gpt-*-transcribe: the mock refuses verbose_json for it, so the adapter asks for plain JSON from the start and gets one block.
  const textOnly = await file("gpt-4o-transcribe").transcribe(upload(30), { speakers: false, post })
  assert.equal(textOnly.utterances.length, 1)
  assert.equal(textOnly.durationMs, 0)

  const diarized = await file("gpt-4o-transcribe-diarize").transcribe(upload(30), { speakers: true, post })
  assert.deepEqual(diarized.utterances.slice(0, 3).map((u) => u.speaker), ["A", "B", "A"])

  await assert.rejects(file("whisper-1", "bad").transcribe(upload(5), { speakers: false, post }), /鉴权失败（HTTP 401）.*Incorrect API key provided/)
  const tooBig = { ...upload(1), data: new Uint8Array(26 * 1024 * 1024), bytes: 26 * 1024 * 1024 }
  await assert.rejects(file("whisper-1").transcribe(tooBig, { speakers: false, post }), /HTTP 413|文件大小上限/)
})

test("pieces of a long recording go up in order and come back on one timeline", async () => {
  const provider = openAiFileProvider({ baseUrl: `${base}/v1`, model: "whisper-1", apiKey: "k", language: undefined, fileSizeLimit: 25 * 1024 * 1024 })
  const pieces = [upload(40, 0), upload(40, 40_000), upload(20, 80_000)]
  const seen: number[] = []
  const merged = await transcribeChunks(provider, pieces, { speakers: true, post, onPart: (i) => seen.push(i) })
  assert.deepEqual(seen, [0, 1, 2])
  assert.equal(merged.chunks, 3)
  assert.equal(merged.durationMs, 100_000)
  const starts = merged.utterances.map((u) => u.startMs)
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b))
  assert.ok(starts.includes(40_000) && starts.includes(80_000), "each piece's first line sits at its offset")
  assert.ok(merged.utterances.at(-1)!.endMs <= 100_000)
})

test("the Volcengine and LLM routes still answer", async () => {
  const connected = await volcConnector({ endpoint: `${wsBase()}/asr`, resourceId: "r", apiKey: "k", appId: "", accessToken: "", endWindowMs: 800, hotwords: [] })({ onResult: () => undefined, onClose: () => undefined })
  connected.connection.close()
  const refused = (await volcConnector({ endpoint: `${wsBase()}/asr`, resourceId: "r", apiKey: "bad", appId: "", accessToken: "", endWindowMs: 800, hotwords: [] })({ onResult: () => undefined, onClose: () => undefined }).catch((e: unknown) => e)) as AsrError
  assert.equal(refused.fatal, true)

  const text = await chat(
    { preset: presetById("custom"), baseUrl: `${base}/v1`, apiKey: "k", model: "m", temperature: 0.2, effort: "off", headers: {}, inputLimit: 1000 },
    [{ role: "user", content: "你好" }],
    async (url, headers, body) => {
      const response = await fetch(url, { method: "POST", headers, body })
      return { status: response.status, text: await response.text() }
    },
  )
  assert.ok(text.length > 0)
})
