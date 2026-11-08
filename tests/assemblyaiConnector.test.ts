import assert from "node:assert/strict"
import { test } from "node:test"
import { AsrError } from "../src/asr/contract.ts"
import { assemblyAiConfigProblem, assemblyAiConnector, assemblyAiUrl, closeError, keytermsMessage, type AssemblyAiConfig } from "../src/asr/providers/assemblyai/live.ts"
import { assemblyAiConfig, assemblyAiFileConfig } from "../src/asr/providers/assemblyai/settings.ts"
import { resolveFile, resolveLive } from "../src/asr/providers/registry.ts"
import { destinations } from "../src/consent.ts"
import { assemblyAiSettingsOf } from "../src/asr/providers/assemblyai/index.ts"
import { SETTINGS_VERSION, loadSettings } from "../src/settings.ts"
import { withOne } from "./support/accounts.ts"
import { collect, fakeWs, pcm, waitFor } from "./support/fakeWs.ts"

const config = (endpoint: string, patch: Partial<AssemblyAiConfig> = {}): AssemblyAiConfig => ({ endpoint, apiKey: "key-1", model: "universal-3-5-pro", diarize: false, keyterms: [], ...patch })
const begin = JSON.stringify({ type: "Begin", id: "s", expires_at: 1 })
type Ws = import("ws").WebSocket
const beginning = (after?: (ws: Ws) => void) => (ws: Ws) => {
  ws.send(begin)
  after?.(ws)
}

test("the stream asks for 16 kHz PCM and the model, with speaker labels on request, and authenticates with the bare key", async () => {
  const server = await fakeWs(beginning())
  const { connection } = await assemblyAiConnector(config(server.url + "/v3/ws"))(collect().handlers)
  assert.deepEqual(Object.fromEntries(new URL(server.seen.url, "http://x").searchParams), { sample_rate: "16000", encoding: "pcm_s16le", speech_model: "universal-3-5-pro" })
  assert.equal(server.seen.headers.authorization, "key-1")
  connection.close()
  const url = (c: AssemblyAiConfig) => new URL(assemblyAiUrl(c)).searchParams
  assert.equal(url(config("wss://x/v3/ws", { diarize: true })).get("speaker_labels"), "true")
  assert.equal(url(config("wss://x/v3/ws")).has("format_turns"), false)
  assert.equal(url(config("wss://x/v3/ws", { model: "universal-streaming-multilingual" })).get("format_turns"), "true")
})

test("the connection is ready only after Begin, and keyterms follow as an UpdateConfiguration message of at most 100 terms", async () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  const server = await fakeWs((ws) => void gate.then(() => ws.send(begin)))
  let ready = false
  const terms = Array.from({ length: 130 }, (_, i) => ` 词${i} `)
  const pending = assemblyAiConnector(config(server.url, { keyterms: [...terms, ""] }))(collect().handlers).then((c) => ((ready = true), c))
  await waitFor(() => !!server.seen.socket)
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(ready, false)
  release()
  const { connection } = await pending
  await waitFor(() => server.seen.frames.length === 1)
  const sent = JSON.parse(server.seen.frames[0].text) as { type: string; keyterms_prompt: string[] }
  assert.equal(sent.type, "UpdateConfiguration")
  assert.equal(sent.keyterms_prompt.length, 100)
  assert.equal(sent.keyterms_prompt[0], "词0")
  assert.equal(keytermsMessage([" ", ""]), undefined)
  connection.close()
})

test("turns reach the streamer; an open turn without words ends where the audio sent so far ends", async () => {
  const server = await fakeWs(beginning((ws) => ws.on("message", (_d, isBinary) => isBinary && ws.send(JSON.stringify({ type: "Turn", turn_order: 0, turn_is_formatted: true, end_of_turn: false, transcript: "你好", words: [] })))))
  const seen = collect()
  const { connection } = await assemblyAiConnector(config(server.url))(seen.handlers)
  connection.sendAudio(pcm(400), false)
  await waitFor(() => seen.results.length >= 1)
  connection.sendAudio(new Int16Array(0), false)
  connection.sendAudio(pcm(200), false)
  await waitFor(() => seen.results.length >= 2)
  assert.deepEqual(seen.results.map((r) => r.update.utterances[0].endMs), [400, 600])
  assert.deepEqual(server.seen.frames.filter((f) => f.binary).map((f) => f.bytes), [12800, 6400], "no empty frame is sent")
  connection.close()
})

test("ending the stream sends Terminate and announces the last result once Termination arrives", async () => {
  const server = await fakeWs(
    beginning((ws) =>
      ws.on("message", (data, isBinary) => {
        if (isBinary || JSON.parse(data.toString()).type !== "Terminate") return
        ws.send(JSON.stringify({ type: "Turn", turn_order: 0, turn_is_formatted: true, end_of_turn: true, transcript: "最后一句。", words: [{ text: "最后一句。", start: 0, end: 700 }] }))
        ws.send(JSON.stringify({ type: "Termination", audio_duration_seconds: 1, session_duration_seconds: 1 }))
        ws.close(1000)
      }),
    ),
  )
  const seen = collect()
  const { connection } = await assemblyAiConnector(config(server.url))(seen.handlers)
  connection.sendAudio(pcm(700), false)
  connection.sendAudio(new Int16Array(0), true)
  await waitFor(() => seen.results.some((r) => r.last))
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(seen.results.map((r) => [r.update.utterances.map((u) => [u.text, u.final]), r.last]), [[[["最后一句。", true]], false], [[], true]])
  assert.equal(seen.results[1].update.keepInterims, true)
  assert.deepEqual(seen.closes, [])
  assert.deepEqual(server.seen.frames.filter((f) => !f.binary).map((f) => JSON.parse(f.text).type), ["Terminate"])
})

test("a close after Terminate without Termination still ends the stream", async () => {
  const server = await fakeWs(beginning((ws) => ws.on("message", (data, isBinary) => !isBinary && JSON.parse(data.toString()).type === "Terminate" && ws.close(1000))))
  const seen = collect()
  const { connection } = await assemblyAiConnector(config(server.url))(seen.handlers)
  connection.sendAudio(new Int16Array(0), true)
  await waitFor(() => seen.results.some((r) => r.last))
  assert.deepEqual(seen.closes, [])
})

test("close codes: 1008 (key or funds) is fatal, expiry, overload, server errors and drops are retried", async () => {
  assert.equal(closeError(1008, "Unauthorized Connection: Insufficient funds").fatal, true)
  for (const code of [3005, 3008, 3009, 1006, 1011, 1012]) assert.equal(closeError(code, "").fatal, false, String(code))
  assert.match(closeError(3008, "Session Expired: Maximum session duration exceeded").message, /3008.*Session Expired/)

  const cases: { act: (ws: Ws) => void; fatal: boolean; message: RegExp }[] = [
    { act: (ws) => ws.close(1008, "Unauthorized Connection: Invalid API key"), fatal: true, message: /Invalid API key/ },
    { act: (ws) => ws.close(3008, "Session Expired"), fatal: false, message: /3008/ },
    { act: (ws) => ws.terminate(), fatal: false, message: /1006/ },
    { act: (ws) => ws.send(JSON.stringify({ error_code: 1008, error: "Unauthorized Connection: Insufficient funds" })), fatal: true, message: /Insufficient funds/ },
    { act: (ws) => ws.send(JSON.stringify({ type: "Error", error_code: 3005, error: "Session Cancelled" })), fatal: false, message: /3005/ },
  ]
  for (const c of cases) {
    const server = await fakeWs(beginning((ws) => setTimeout(() => c.act(ws), 20)))
    const seen = collect()
    await assemblyAiConnector(config(server.url))(seen.handlers)
    await waitFor(() => seen.closes.length > 0)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(seen.closes.length, 1, "one failure is reported once")
    assert.equal(seen.closes[0].fatal, c.fatal)
    assert.match(seen.closes[0].message, c.message)
  }
})

test("handshake rejections: a bad key or funds are fatal, throttling and outages are retried", async () => {
  for (const [status, fatal] of [[401, true], [402, true], [403, true], [400, true], [429, false], [503, false]] as const) {
    const server = await fakeWs(undefined, { status, body: '{"error":"nope"}' })
    const error = (await assemblyAiConnector(config(server.url))(collect().handlers).catch((e: unknown) => e)) as AsrError
    assert.equal(error.fatal, fatal, `HTTP ${status}`)
    assert.match(error.message, /nope/)
  }
})

test("closing locally is silent and sending afterwards is an error the streamer can handle", async () => {
  const server = await fakeWs(beginning())
  const seen = collect()
  const { connection } = await assemblyAiConnector(config(server.url))(seen.handlers)
  connection.close()
  await new Promise((r) => setTimeout(r, 50))
  assert.throws(() => connection.sendAudio(pcm(100), false), (error: Error) => error instanceof AsrError && !error.fatal)
  assert.deepEqual(seen.closes, [])
})

test("settings: the key is all that is needed, the region picks the hosts for both roles, old data gains defaults", () => {
  const defaults = withOne("assemblyai").account
  assert.deepEqual(assemblyAiSettingsOf(defaults), { region: "default", apiKeySecret: "", diarize: false, model: "universal-3-5-pro" })
  const stored = (options: Record<string, unknown>) => loadSettings({ version: SETTINGS_VERSION, accounts: [{ id: "a", service: "assemblyai", apiKeySecret: "k", options }] }).settings.accounts[0]
  assert.deepEqual(assemblyAiSettingsOf(stored({})), { ...assemblyAiSettingsOf(defaults), apiKeySecret: "k" })
  assert.equal(assemblyAiSettingsOf(stored({ region: "mars" })).region, "default")
  assert.deepEqual(assemblyAiSettingsOf(stored({ region: "eu", diarize: true })), { region: "eu", apiKeySecret: "k", diarize: true, model: "universal-3-5-pro" })

  const { settings, account } = withOne("assemblyai", { key: "as" })
  settings.asrLanguage = "zh"
  const secrets = (value: string | null) => ({ getSecret: () => value })
  assert.match(resolveLive({ secrets: secrets(null), settings }).problem ?? "", /API Key/)
  assert.equal(resolveLive({ secrets: secrets(" k "), settings }).problem, undefined)
  assert.match(resolveFile({ secrets: secrets(null), settings }).problem ?? "", /API Key/)
  const file = resolveFile({ secrets: secrets(" k "), settings })
  assert.equal(file.problem, undefined)
  assert.equal(file.host, "api.assemblyai.com")
  assert.deepEqual(destinations(settings).filter((d) => d.kind !== "llm").map((d) => [d.kind, d.host]), [["live", "streaming.assemblyai.com"], ["file", "api.assemblyai.com"]])
  account.options.region = "eu"
  assert.deepEqual(destinations(settings).filter((d) => d.kind !== "llm").map((d) => [d.kind, d.host]), [["live", "streaming.eu.assemblyai.com"], ["file", "api.eu.assemblyai.com"]])
  assert.equal(assemblyAiConfig(secrets("k"), assemblyAiSettingsOf(account), "科创板，某某").endpoint, "wss://streaming.eu.assemblyai.com/v3/ws")
  assert.deepEqual(assemblyAiConfig(secrets("k"), assemblyAiSettingsOf(account), "科创板，某某").keyterms, ["科创板", "某某"])
  assert.deepEqual(assemblyAiFileConfig(secrets("k"), assemblyAiSettingsOf(account), "zh"), { baseUrl: "https://api.eu.assemblyai.com", apiKey: "k", language: "zh" })
  assert.match(assemblyAiConfigProblem({ ...config("wss://x"), model: " " }) ?? "", /模型/)
})
