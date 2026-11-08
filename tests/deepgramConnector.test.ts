import assert from "node:assert/strict"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { after, test } from "node:test"
import { WebSocketServer, type WebSocket } from "ws"
import { AsrError, type AsrConnectionHandlers, type AsrUpdate } from "../src/asr/contract.ts"
import { deepgramConfigProblem, deepgramConnector, deepgramUrl, type DeepgramConfig } from "../src/asr/providers/deepgram/live.ts"
import { deepgramConfig } from "../src/asr/providers/deepgram/settings.ts"
import { resolveFile, resolveLive } from "../src/asr/providers/registry.ts"
import { destinations } from "../src/consent.ts"
import { loadSettings } from "../src/settings.ts"

const sockets = new Set<() => void>()
after(() => sockets.forEach((close) => close()))

interface Seen { frames: { binary: boolean; text: string; bytes: number }[]; url: string; headers: IncomingMessage["headers"]; socket?: WebSocket }

/** A stand-in for Deepgram's /v1/listen that records what it receives and lets each test script the replies. */
async function fakeDeepgram(behave: (ws: WebSocket, seen: Seen) => void = () => undefined, reject?: { status: number; body?: string }, responseHeaders: string[] = []) {
  const seen: Seen = { frames: [], url: "", headers: {} }
  const server = createServer()
  const wss = new WebSocketServer({ noServer: true })
  wss.on("headers", (headers) => headers.push(...responseHeaders))
  server.on("upgrade", (req, socket, head) => {
    seen.url = req.url ?? ""
    seen.headers = req.headers
    if (reject) {
      const body = reject.body ?? ""
      socket.end(`HTTP/1.1 ${reject.status} Rejected\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      seen.socket = ws
      ws.on("message", (data, isBinary) => seen.frames.push({ binary: isBinary, text: isBinary ? "" : data.toString(), bytes: (data as Buffer).length }))
      ws.on("error", () => undefined)
      behave(ws, seen)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const close = () => {
    for (const client of wss.clients) client.terminate()
    server.close()
    server.closeAllConnections()
  }
  sockets.add(close)
  const port = (server.address() as AddressInfo).port
  return { endpoint: `ws://127.0.0.1:${port}/v1/listen`, seen, close, port }
}

const config = (endpoint: string, patch: Partial<DeepgramConfig> = {}): DeepgramConfig => ({ endpoint, apiKey: "test-key", model: "nova-3", language: "zh", diarize: false, ...patch })

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

const finalResult = (text: string, start: number, duration: number) => JSON.stringify({ type: "Results", start, duration, is_final: true, channel: { alternatives: [{ transcript: text, words: [] }] } })
const pcm = (ms: number) => new Int16Array((16000 * ms) / 1000).fill(100)

test("the stream asks for raw 16 kHz mono PCM with interim results and endpointing, and authenticates with Token", async () => {
  const server = await fakeDeepgram()
  const { connection } = await deepgramConnector(config(server.endpoint))(handlers().h)
  await waitFor(() => !!server.seen.socket)
  const query = new URL(server.seen.url, "http://x").searchParams
  assert.deepEqual(Object.fromEntries(query), { model: "nova-3", language: "zh", encoding: "linear16", sample_rate: "16000", channels: "1", interim_results: "true", endpointing: "300", smart_format: "true" })
  assert.equal(server.seen.headers.authorization, "Token test-key")
  connection.close()

  const diarized = new URL(deepgramUrl(config(server.endpoint, { diarize: true }))).searchParams
  assert.equal(diarized.get("diarize_model"), "latest", "the documented parameter, which streaming accepts as v1 or latest")
  assert.equal(diarized.has("diarize"), false, "the deprecated boolean is not sent, and never together with diarize_model")
  assert.equal(new URL(deepgramUrl(config(server.endpoint))).searchParams.has("diarize_model"), false)
  assert.equal(new URL(deepgramUrl(config(server.endpoint, { language: "multi" }))).searchParams.get("language"), "multi")
  // A key is not sent when there is none (a local test server), and it is only demanded for remote hosts.
  const open = await fakeDeepgram()
  await deepgramConnector(config(open.endpoint, { apiKey: "" }))(handlers().h).then(({ connection: c }) => c.close())
  await waitFor(() => !!open.seen.socket)
  assert.equal(open.seen.headers.authorization, undefined)
  assert.equal(deepgramConfigProblem(config(open.endpoint, { apiKey: "" })), undefined)
  assert.match(deepgramConfigProblem(config("wss://api.deepgram.com/v1/listen", { apiKey: "" })) ?? "", /API Key/)
  assert.match(deepgramConfigProblem(config("", {})) ?? "", /WebSocket 地址/)
  assert.match(deepgramConfigProblem(config("wss://api.deepgram.com/v1/listen", { model: " " })) ?? "", /模型/)
})

test("auth, permission, payment and parameter rejections on connect are fatal; a busy or broken service is retried", async () => {
  for (const [status, fatal, message] of [[401, true, /鉴权失败/], [403, true, /无权/], [402, true, /余额/], [400, true, /参数/], [429, false, /HTTP 429/], [503, false, /HTTP 503/]] as const) {
    const server = await fakeDeepgram(undefined, { status, body: '{"err_code":"X","err_msg":"nope"}' })
    const error = await deepgramConnector(config(server.endpoint))(handlers().h).then(
      () => assert.fail("should not connect"),
      (e: unknown) => e as AsrError,
    )
    assert.ok(error instanceof AsrError)
    assert.equal(error.fatal, fatal, `HTTP ${status}`)
    assert.match(error.message, message)
    assert.match(error.message, /nope/, "the service's own words are kept")
  }
  // Nothing listening: a network error, which is worth retrying.
  const gone = await fakeDeepgram()
  gone.close()
  const error = (await deepgramConnector(config(gone.endpoint))(handlers().h).catch((e: unknown) => e)) as AsrError
  assert.equal(error.fatal, false)
  assert.match(error.message, /网络错误/)
})

test("after connecting, an undecodable-audio close (1008) and an Error message about our request are fatal; timeouts and drops are not", async () => {
  const cases: { close?: [number, string] | "drop"; send?: object; fatal: boolean; message: RegExp }[] = [
    { close: [1008, "DATA-0000"], fatal: true, message: /1008.*DATA-0000/ },
    { close: [1011, "NET-0001"], fatal: false, message: /1011.*NET-0001/ },
    { close: "drop", fatal: false, message: /1006/ },
    { send: { type: "Error", variant: "SchemaError", description: "Invalid parameter" }, fatal: true, message: /SchemaError.*Invalid parameter/ },
    { send: { type: "Error", variant: "Throttled", description: "slow down" }, fatal: false, message: /Throttled/ },
  ]
  for (const c of cases) {
    const server = await fakeDeepgram((ws) => setTimeout(() => (c.send ? ws.send(JSON.stringify(c.send)) : c.close === "drop" ? ws.terminate() : ws.close(c.close![0], c.close![1])), 20))
    const seen = handlers()
    await deepgramConnector(config(server.endpoint))(seen.h)
    await waitFor(() => seen.closes.length > 0)
    assert.equal(seen.closes.length, 1)
    assert.equal(seen.closes[0].fatal, c.fatal, JSON.stringify(c))
    assert.match(seen.closes[0].message, c.message)
  }
})

test("no KeepAlive goes out before the first audio frame, then one while no audio flows, none while audio does, and none after the connection is closed", async () => {
  const server = await fakeDeepgram()
  const { connection } = await deepgramConnector(config(server.endpoint), { keepAliveMs: 60 })(handlers().h)
  await waitFor(() => !!server.seen.socket)
  // Deepgram closes a socket that has never carried audio after 10 s whatever else it receives, so the timer holds its KeepAlive back.
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(server.seen.frames.length, 0, "nothing is sent before audio")

  connection.sendAudio(pcm(100), false)
  await waitFor(() => server.seen.frames.filter((f) => f.text === '{"type":"KeepAlive"}').length >= 3)
  assert.equal(server.seen.frames[0].binary, true, "the audio frame is the first thing the server sees")
  assert.equal(server.seen.frames[0].bytes, 3200)
  const keepAlives = server.seen.frames.filter((f) => !f.binary)
  assert.ok(keepAlives.every((f) => f.text === '{"type":"KeepAlive"}'), "KeepAlive is JSON text, never a binary frame")

  // While audio is sent more often than the interval, no KeepAlive is needed.
  const before = server.seen.frames.length
  for (let i = 0; i < 12; i++) {
    connection.sendAudio(pcm(100), false)
    await new Promise((r) => setTimeout(r, 15))
  }
  const during = server.seen.frames.slice(before)
  assert.equal(during.filter((f) => !f.binary).length, 0)
  assert.ok(during.every((f) => f.binary && f.bytes === 3200))

  connection.close()
  await new Promise((r) => setTimeout(r, 150))
  const after = server.seen.frames.length
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(server.seen.frames.length, after, "the timer stops with the connection")
})

test("ending the stream sends CloseStream, never an empty frame, and the streamer gets its last result once the finals are in", async () => {
  const server = await fakeDeepgram((ws, seen) => {
    ws.on("message", (_data, isBinary) => {
      if (isBinary) return
      if (seen.frames.at(-1)?.text !== '{"type":"CloseStream"}') return
      // What Deepgram documents: the remaining finals, a Metadata summary, then it closes.
      ws.send(finalResult("最后一句。", 1.2, 0.8))
      ws.send(JSON.stringify({ type: "Metadata", request_id: "r", duration: 2, channels: 1 }))
      ws.close(1000)
    })
  })
  const seen = handlers()
  const { connection } = await deepgramConnector(config(server.endpoint))(seen.h)
  connection.sendAudio(pcm(200), false)
  connection.sendAudio(new Int16Array(0), false)
  connection.sendAudio(pcm(100), false)
  connection.sendAudio(new Int16Array(0), true)
  await waitFor(() => seen.results.some((r) => r.last))
  await new Promise((r) => setTimeout(r, 50))

  assert.deepEqual(server.seen.frames.map((f) => (f.binary ? f.bytes : f.text)), [6400, 3200, '{"type":"CloseStream"}'])
  assert.equal(seen.results.filter((r) => r.last).length, 1, "last is announced once")
  assert.deepEqual(seen.results.map((r) => [r.update.utterances.map((u) => u.text), r.last]), [[["最后一句。"], false], [[], true]])
  assert.equal(seen.results[1].update.keepInterims, true, "the closing marker leaves unconfirmed text for the streamer to keep")
  assert.deepEqual(seen.closes, [], "a close after CloseStream is the normal end, not a drop")
})

test("a server that closes after CloseStream without a summary still ends the stream", async () => {
  const server = await fakeDeepgram((ws, seen) =>
    ws.on("message", () => {
      if (seen.frames.at(-1)?.text === '{"type":"CloseStream"}') ws.close(1000)
    }),
  )
  const seen = handlers()
  const { connection } = await deepgramConnector(config(server.endpoint))(seen.h)
  connection.sendAudio(new Int16Array(0), true)
  await waitFor(() => seen.results.some((r) => r.last))
  assert.deepEqual(seen.closes, [])
})

test("closing locally is silent, and sending after the socket is gone is an error the streamer can handle", async () => {
  const server = await fakeDeepgram()
  const seen = handlers()
  const { connection } = await deepgramConnector(config(server.endpoint))(seen.h)
  connection.close()
  await new Promise((r) => setTimeout(r, 50))
  assert.throws(() => connection.sendAudio(pcm(100), false), (error: Error) => error instanceof AsrError && !error.fatal)
  assert.deepEqual(seen.closes, [])
  assert.deepEqual(seen.results, [])
})

test("Deepgram does live and recorded files: settings resolve both, the host is the endpoint's, and it is not offered where it cannot work", () => {
  const { settings } = loadSettings(null)
  settings.liveProvider = "deepgram"
  settings.providers.deepgram.apiKeySecret = "dg"
  settings.asrLanguage = "zh"
  const secrets = (value: string | null) => ({ getSecret: () => value })
  assert.equal(resolveLive({ secrets: secrets(" k "), settings }).problem, undefined)
  assert.equal(typeof resolveLive({ secrets: secrets("k"), settings }).connect, "function")
  assert.match(resolveLive({ secrets: secrets(null), settings }).problem ?? "", /API Key/)
  assert.deepEqual(destinations(settings).find((d) => d.kind === "live"), { kind: "live", name: "Deepgram", host: "api.deepgram.com" })
  settings.fileProvider = "deepgram"
  const file = resolveFile({ secrets: secrets("k"), settings })
  assert.equal(file.problem, undefined)
  assert.equal(file.host, "api.deepgram.com")
  assert.match(resolveFile({ secrets: secrets(null), settings }).problem ?? "", /API Key/)
  assert.deepEqual(destinations(settings).find((d) => d.kind === "file"), { kind: "file", name: "Deepgram", host: "api.deepgram.com" })
  settings.providers.deepgram.endpoint = "ws://127.0.0.1:8790/v1/listen"
  assert.equal(destinations(settings).find((d) => d.kind === "file")?.host, "127.0.0.1:8790")
  settings.liveProvider = "openai-compat"
  assert.match(resolveLive({ secrets: secrets("k"), settings }).problem ?? "", /不支持实时识别/)
})

test("old settings gain Deepgram's defaults, its stored values are read back, and the language maps to its codes", () => {
  assert.deepEqual(loadSettings({ version: 2 }).settings.providers.deepgram, { endpoint: "wss://api.deepgram.com/v1/listen", model: "nova-3", apiKeySecret: "", diarize: false })
  assert.deepEqual(loadSettings({ version: 2, providers: { deepgram: { model: "nova-2", diarize: true, apiKeySecret: "k", endpoint: 7 } } }).settings.providers.deepgram, { endpoint: "wss://api.deepgram.com/v1/listen", model: "nova-2", apiKeySecret: "k", diarize: true })
  const { settings } = loadSettings(null)
  const secrets = { getSecret: () => "k" }
  const codes: [string, string][] = [["auto", "multi"], ["zh", "zh"], ["en", "en"], ["ja", "ja"]]
  for (const [language, code] of codes) {
    const config = deepgramConfig(secrets, settings.providers.deepgram, language as typeof settings.asrLanguage)
    assert.equal(config.language, code)
    assert.equal(new URL(deepgramUrl(config)).searchParams.get("language"), code)
  }
})

test("the log id is the dg-request-id response header, and absent when the response has none", async () => {
  const withHeader = await fakeDeepgram(undefined, undefined, ["dg-request-id: 3f1c9a52-0000-4000-8000-000000000001"])
  const first = await deepgramConnector(config(withHeader.endpoint))(handlers().h)
  assert.equal(first.logId, "3f1c9a52-0000-4000-8000-000000000001")
  first.connection.close()

  const without = await fakeDeepgram()
  const second = await deepgramConnector(config(without.endpoint))(handlers().h)
  assert.equal(second.logId, undefined)
  second.connection.close()
})
