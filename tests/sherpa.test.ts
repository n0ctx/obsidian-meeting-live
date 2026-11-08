import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { after, test } from "node:test"
import { WebSocketServer, type WebSocket } from "ws"
import { closeCjkSpaces } from "../src/asr/cjk.ts"
import { AsrError, type AsrConnectionHandlers, type AsrUpdate } from "../src/asr/contract.ts"
import { floatFrame, sherpaConfigProblem, sherpaConnector } from "../src/asr/providers/sherpa/live.ts"
import { SherpaNormalizer } from "../src/asr/providers/sherpa/normalize.ts"
import { resolveLive } from "../src/asr/providers/registry.ts"
import { AsrStreamer } from "../src/asr/streamer.ts"
import { loadSettings, DEFAULT_SETTINGS } from "../src/settings.ts"
import type { Utterance } from "../src/meeting/types.ts"

// ---------------------------------------------------------------- the normalizer, on messages a real server sent
// (sherpa-onnx v2.0.1, sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8; the per-token arrays are shortened to what the adapter reads).

const reply = (text: string, segment: number, startTime: number | undefined, stamps: number[], flags: { final?: boolean; eof?: boolean } = {}) =>
  ({ text, segment, ...(startTime === undefined ? {} : { start_time: startTime }), timestamps: stamps, is_final: flags.final ?? false, is_eof: flags.eof ?? false })

const REAL = [
  reply("", 0, 0, []),
  reply("各位同事大家好， 今天我", 0, 0, [0.48, 0.6, 0.96, 1.12, 1.36, 1.6, 1.84, 2.12, 2.44, 2.64, 2.84]),
  reply("各位同事大家好， 今天我们讨论第三季度的预算", 0, 0, [0.48, 5.08]),
  reply("各位同事大家好， 今天我们讨论第三季度的预算", 0, 0, [0.48, 5.08], { final: true }),
  reply("", 1, 6.72, [0.04]),
  reply("收入同比增长百分之二十， 毛利率保持在四成左右", 1, 6.72, [0.04, 5.68], { final: true }),
  reply("", 3, 19.68, [], { final: true, eof: true }),
]

test("the server's start_time and token times place a segment on the connection's timeline, and a segment keeps one start while it grows", () => {
  const n = new SherpaNormalizer(() => 99_999)
  const out = REAL.map((m) => n.update(m)!)
  assert.deepEqual(out[0].update, { utterances: [] }, "an empty reply leaves no interim")
  assert.deepEqual(out[1].update.utterances, [{ text: "各位同事大家好，今天我", startMs: 0, endMs: 2840, final: false }])
  assert.deepEqual(out[2].update.utterances, [{ text: "各位同事大家好，今天我们讨论第三季度的预算", startMs: 0, endMs: 5080, final: false }])
  assert.deepEqual(out[3].update.utterances, [{ text: "各位同事大家好，今天我们讨论第三季度的预算", startMs: 0, endMs: 5080, final: true }])
  assert.deepEqual(out[5].update.utterances, [{ text: "收入同比增长百分之二十，毛利率保持在四成左右", startMs: 6720, endMs: 12_400, final: true }])
  assert.deepEqual(out.map((o) => o.last), [false, false, false, false, false, false, true])
  assert.equal(out[6].update.keepInterims, true)
  assert.deepEqual(out[6].update.utterances, [])
})

test("Chinese words lose the spaces the server puts between them; spaces next to other scripts stay", () => {
  assert.equal(closeCjkSpaces("各位同事大家好， 今天我们讨论"), "各位同事大家好，今天我们讨论")
  assert.equal(closeCjkSpaces("hello everyone, today we will review the budget"), "hello everyone, today we will review the budget")
  assert.equal(closeCjkSpaces("收入 up 20% 同比"), "收入 up 20% 同比")
})

test("without the server's times the position in the audio sent stands in: a segment starts when its text first arrives and a final ends it", () => {
  let sentMs = 0
  const n = new SherpaNormalizer(() => sentMs)
  sentMs = 1000
  assert.deepEqual(n.update(reply("", 0, undefined, []))!.update.utterances, [])
  sentMs = 1800
  assert.deepEqual(n.update(reply("你好", 0, undefined, [0.2]))!.update.utterances, [{ text: "你好", startMs: 1800, endMs: 2000, final: false }])
  sentMs = 2600
  assert.deepEqual(n.update(reply("你好世界", 0, undefined, [0.2, 0.6]))!.update.utterances, [{ text: "你好世界", startMs: 1800, endMs: 2400, final: false }])
  sentMs = 3400
  assert.deepEqual(n.update(reply("你好世界", 0, undefined, [0.2, 0.6], { final: true }))!.update.utterances, [{ text: "你好世界", startMs: 1800, endMs: 3400, final: true }])
  sentMs = 5000
  assert.equal(n.update(reply("再见", 1, undefined, [0.1]))!.update.utterances[0].startMs, 5000)
})

test("a message that is not a result is ignored", () => {
  const n = new SherpaNormalizer(() => 0)
  for (const junk of [null, 3, "Done!", {}, { text: 5 }]) assert.equal(n.update(junk), undefined)
})

// ---------------------------------------------------------------- the connector, against a stand-in server

const closers = new Set<() => void>()
after(() => closers.forEach((close) => close()))

/** A stand-in for sherpa-onnx-online-websocket-server: float32 binary frames in, "Done" ends the input, JSON out, "Done!" last, and no close. */
async function fakeSherpa(behave: (ws: WebSocket, seen: Seen) => void = () => undefined) {
  interface Frame { binary: boolean; text: string; samples: number[] }
  const seen: Seen = { frames: [] as Frame[] }
  const server = createServer()
  const wss = new WebSocketServer({ server })
  wss.on("connection", (ws) => {
    seen.socket = ws
    ws.on("message", (data, isBinary) => {
      const buffer = data as Buffer
      seen.frames.push({ binary: isBinary, text: isBinary ? "" : buffer.toString(), samples: isBinary ? [...new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length))] : [] })
      if (!isBinary && buffer.toString() === "Done") {
        ws.send(JSON.stringify(reply("再见", 0, 0, [0.1, 0.5], { final: true, eof: true })))
        ws.send("Done!")
      }
    })
    ws.on("error", () => undefined)
    behave(ws, seen)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const close = () => {
    for (const client of wss.clients) client.terminate()
    server.close()
    server.closeAllConnections()
  }
  closers.add(close)
  return { endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close }
}
interface Seen { frames: { binary: boolean; text: string; samples: number[] }[]; socket?: WebSocket }

function handlers() {
  const results: { update: AsrUpdate; last: boolean }[] = []
  const closes: AsrError[] = []
  const h: AsrConnectionHandlers = { onResult: (update, last) => results.push({ update, last }), onClose: (error) => closes.push(error) }
  return { h, results, closes }
}

async function waitFor(condition: () => boolean, ms = 2000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > ms) assert.fail("timed out waiting")
    await new Promise((r) => setTimeout(r, 5))
  }
}

test("audio goes up as float32 frames, the end of the input is the text Done, and never an empty frame", async () => {
  const server = await fakeSherpa()
  const { h, results } = handlers()
  const { connection } = await sherpaConnector({ endpoint: server.endpoint })(h)
  connection.sendAudio(Int16Array.from([16384, -16384, 0, 32767, -32768]), false)
  connection.sendAudio(new Int16Array(0), true)
  await waitFor(() => results.length > 0)
  assert.deepEqual(server.seen.frames.map((f) => [f.binary, f.text]), [[true, ""], [false, "Done"]])
  assert.deepEqual(server.seen.frames[0].samples, [0.5, -0.5, 0, 32767 / 32768, -1])
  assert.deepEqual([...new Float32Array(floatFrame(Int16Array.from([8192])).buffer.slice(0, 4))], [0.25])
  connection.close()
})

test("the closing reply ends the stream once, even though the server also says Done! and never closes the socket", async () => {
  const server = await fakeSherpa((ws) => ws.send(JSON.stringify(reply("你好", 0, 0, [0.2], {}))))
  const { h, results, closes } = handlers()
  const { connection } = await sherpaConnector({ endpoint: server.endpoint })(h)
  await waitFor(() => results.length === 1)
  assert.deepEqual(results[0], { update: { utterances: [{ text: "你好", startMs: 0, endMs: 200, final: false }] }, last: false })
  connection.sendAudio(new Int16Array(3200), false)
  connection.sendAudio(new Int16Array(0), true)
  await waitFor(() => results.some((r) => r.last))
  await new Promise((r) => setTimeout(r, 60))
  assert.deepEqual(results.filter((r) => r.last).map((r) => r.update.utterances.map((u) => [u.text, u.final])), [[["再见", true]]])
  assert.equal(results.filter((r) => r.last).length, 1)
  assert.equal(server.seen.socket!.readyState, 1, "the server is still connected: closing is the client's job")
  connection.close()
  await waitFor(() => server.seen.socket!.readyState === 3)
  assert.deepEqual(closes, [])
})

test("a server that drops mid-stream is a retryable close; one that is not running is a retryable refusal naming the address", async () => {
  const server = await fakeSherpa()
  const { h, closes } = handlers()
  await sherpaConnector({ endpoint: server.endpoint })(h)
  await waitFor(() => !!server.seen.socket)
  server.seen.socket!.terminate()
  await waitFor(() => closes.length === 1)
  assert.equal(closes[0].fatal, false)

  const dead = await fakeSherpa()
  dead.close()
  await assert.rejects(sherpaConnector({ endpoint: dead.endpoint })(handlers().h), (error: AsrError) => error.fatal === false && error.message.includes(dead.endpoint) && /本地识别服务/.test(error.message))
})

test("an address that is empty or not a WebSocket address is reported before connecting", () => {
  assert.match(sherpaConfigProblem({ endpoint: " " }) ?? "", /未填写/)
  assert.match(sherpaConfigProblem({ endpoint: "127.0.0.1:6006" }) ?? "", /格式不正确/)
  assert.match(sherpaConfigProblem({ endpoint: "http://127.0.0.1:6006" }) ?? "", /格式不正确/)
  assert.equal(sherpaConfigProblem({ endpoint: "ws://127.0.0.1:6006" }), undefined)
  assert.equal(sherpaConfigProblem({ endpoint: "wss://recognizer.lan:6006" }), undefined)
})

test("through the streamer: finals arrive in order on the meeting timeline, a drop resumes after the last final, and ending flushes the rest", async () => {
  const finals: Utterance[] = []
  const gaps: unknown[] = []
  const states: string[] = []
  // Every connection says its first sentence a second after the first audio, then drops after the second one.
  let connections = 0
  const server = await fakeSherpa((ws, seen) => {
    const n = ++connections
    ws.on("message", (_data, isBinary) => {
      if (!isBinary) return
      const binaryFrames = seen.frames.filter((f) => f.binary).length
      if (binaryFrames === 5) ws.send(JSON.stringify(reply(`第${n}句`, 0, 0.2, [0.1, 0.8], { final: true })))
      if (n === 1 && binaryFrames === 10) ws.terminate()
    })
  })
  const asr = new AsrStreamer({ onFinal: (u) => finals.push(u), onInterim: () => undefined, onGap: (g) => gaps.push(g), onState: (s) => states.push(s) }, { manualTicks: true, maxChunksPerTick: 1000, finalTimeoutMs: 1500 })
  asr.begin(0, sherpaConnector({ endpoint: server.endpoint }))
  await waitFor(() => asr.currentState === "live")
  for (let i = 0; i < 4; i++) {
    asr.push(new Int16Array(16000))
    asr.tick()
    await new Promise((r) => setTimeout(r, 20))
  }
  await waitFor(() => finals.length === 1)
  assert.equal(finals[0].text, "第1句")
  assert.equal(Math.round(finals[0].startMs), 200)
  asr.push(new Int16Array(16000 * 2))
  asr.tick()
  await waitFor(() => asr.currentState === "reconnecting")
  await waitFor(() => asr.currentState === "live", 6000)
  asr.tick()
  await asr.end()
  assert.ok(connections >= 2)
  assert.deepEqual(gaps, [], "nothing was lost to a gap")
  assert.ok(finals.length >= 2)
  for (let i = 1; i < finals.length; i++) assert.ok(finals[i].startMs > finals[i - 1].startMs)
})

// ---------------------------------------------------------------- settings and registration

test("settings without a local recognizer get the default address; a stored address is kept; nothing else changes for an existing user", () => {
  const fresh = loadSettings({ version: 2, liveProvider: "volc", providers: { volc: { endpoint: "wss://example/x" } } })
  assert.equal(fresh.settings.providers.sherpa.endpoint, "ws://127.0.0.1:6006")
  assert.equal(fresh.settings.liveProvider, "volc")
  const stored = loadSettings({ version: 2, providers: { sherpa: { endpoint: "ws://127.0.0.1:7000" } } })
  assert.equal(stored.settings.providers.sherpa.endpoint, "ws://127.0.0.1:7000")
  const legacy = loadSettings({ volcAppId: "a", volcAccessToken: "b" })
  assert.equal(legacy.settings.liveProvider, "volc")
  assert.equal(DEFAULT_SETTINGS.providers.sherpa.endpoint, "ws://127.0.0.1:6006")
})

test("the local recognizer resolves without any secret and reports a bad address as a problem", () => {
  const settings = loadSettings({ liveProvider: "sherpa-onnx" }).settings
  const ok = resolveLive({ secrets: { getSecret: () => null }, settings })
  assert.equal(typeof ok.connect, "function")
  assert.equal(ok.name, "本地识别（sherpa-onnx）")
  settings.providers.sherpa.endpoint = "nonsense"
  const bad = resolveLive({ secrets: { getSecret: () => null }, settings })
  assert.equal(bad.connect, null)
  assert.match(bad.problem ?? "", /格式不正确/)
})
