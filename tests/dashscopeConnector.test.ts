import assert from "node:assert/strict"
import { test } from "node:test"
import { AsrError } from "../src/asr/contract.ts"
import { dashScopeConfigProblem, dashScopeConnector, finishTaskMessage, runTaskMessage, taskFailedError, type DashScopeConfig } from "../src/asr/providers/dashscope/live.ts"
import { dashScopeConfig } from "../src/asr/providers/dashscope/settings.ts"
import { resolveLive } from "../src/asr/providers/registry.ts"
import { destinations } from "../src/consent.ts"
import { loadSettings } from "../src/settings.ts"
import { collect, fakeWs, pcm, waitFor } from "./support/fakeWs.ts"

const config = (endpoint: string, patch: Partial<DashScopeConfig> = {}): DashScopeConfig => ({ endpoint, apiKey: "sk-test", model: "qwen-audio-3.1-asr-flash-streaming", language: undefined, hotwords: [], ...patch })

const event = (name: string, taskId: string, header: object = {}, payload: object = {}) => JSON.stringify({ header: { task_id: taskId, event: name, attributes: {}, ...header }, payload })
const taskIdOf = (text: string) => (JSON.parse(text) as { header: { task_id: string } }).header.task_id

/** Answers run-task with task-started, as the service does. */
const accepting = (after?: (ws: import("ws").WebSocket, taskId: string) => void) => (ws: import("ws").WebSocket) =>
  ws.on("message", (data, isBinary) => {
    if (isBinary) return
    const message = JSON.parse(data.toString()) as { header: { action: string; task_id: string } }
    if (message.header.action === "run-task") {
      ws.send(event("task-started", message.header.task_id))
      after?.(ws, message.header.task_id)
    }
  })

test("run-task asks for 16 kHz PCM with the language hint, and inline hotwords only for the models that take them", () => {
  const plain = runTaskMessage(config("wss://x"), "id-1") as { header: object; payload: { model: string; parameters: Record<string, unknown>; input: object; task_group: string; task: string; function: string } }
  assert.deepEqual(plain.header, { action: "run-task", task_id: "id-1", streaming: "duplex" })
  assert.deepEqual([plain.payload.task_group, plain.payload.task, plain.payload.function, plain.payload.input], ["audio", "asr", "recognition", {}])
  assert.deepEqual(plain.payload.parameters, { format: "pcm", sample_rate: 16000, heartbeat: true })

  const rich = runTaskMessage(config("wss://x", { language: "zh", hotwords: [" 科创板 ", "", "某某资本"] }), "id-2") as typeof plain
  assert.deepEqual(rich.payload.parameters.language_hints, ["zh"])
  assert.deepEqual(rich.payload.parameters.vocabulary, { 科创板: 4, 某某资本: 4 })
  const fun = runTaskMessage(config("wss://x", { model: "fun-asr-realtime", hotwords: ["科创板"], language: "en" }), "id-3") as typeof plain
  assert.equal("vocabulary" in fun.payload.parameters, false)
  assert.deepEqual(fun.payload.parameters.language_hints, ["en"])
  assert.deepEqual(finishTaskMessage("id-1"), { header: { action: "finish-task", task_id: "id-1", streaming: "duplex" }, payload: { input: {} } })
})

test("the connection is ready only after task-started, authenticates with Bearer, and the first frame is run-task", async () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  const server = await fakeWs((ws) =>
    ws.on("message", async (data, isBinary) => {
      if (isBinary) return
      await gate
      ws.send(event("task-started", taskIdOf(data.toString())))
    }),
  )
  let ready = false
  const pending = dashScopeConnector(config(server.url))(collect().handlers).then((c) => ((ready = true), c))
  await waitFor(() => server.seen.frames.length === 1)
  assert.equal(server.seen.headers.authorization, "Bearer sk-test")
  assert.equal(JSON.parse(server.seen.frames[0].text).header.action, "run-task")
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(ready, false, "no audio may be sent before task-started")
  release()
  const { connection } = await pending
  connection.close()
})

test("results reach the streamer, with an open sentence ending where the audio sent so far ends", async () => {
  const server = await fakeWs(accepting((ws, id) => ws.on("message", (_d, isBinary) => isBinary && ws.send(event("result-generated", id, {}, { output: { sentence: { sentence_id: 1, begin_time: 0, end_time: null, text: "你好", sentence_end: false } } })))))
  const seen = collect()
  const { connection } = await dashScopeConnector(config(server.url))(seen.handlers)
  connection.sendAudio(pcm(500), false)
  await waitFor(() => seen.results.length >= 1)
  connection.sendAudio(new Int16Array(0), false)
  connection.sendAudio(pcm(250), false)
  await waitFor(() => seen.results.length >= 2)
  assert.deepEqual(seen.results.map((r) => r.update.utterances[0].endMs), [500, 750])
  assert.deepEqual(server.seen.frames.filter((f) => f.binary).map((f) => f.bytes), [16000, 8000], "an empty frame is never sent")
  connection.close()
})

test("ending the stream sends finish-task and announces the last result once task-finished arrives", async () => {
  const server = await fakeWs(
    accepting((ws, id) =>
      ws.on("message", (data, isBinary) => {
        if (isBinary || JSON.parse(data.toString()).header.action !== "finish-task") return
        ws.send(event("result-generated", id, {}, { output: { sentence: { sentence_id: 1, begin_time: 0, end_time: 700, text: "最后一句。", sentence_end: true } } }))
        ws.send(event("task-finished", id))
        ws.close(1000)
      }),
    ),
  )
  const seen = collect()
  const { connection } = await dashScopeConnector(config(server.url))(seen.handlers)
  connection.sendAudio(pcm(700), false)
  connection.sendAudio(new Int16Array(0), true)
  await waitFor(() => seen.results.some((r) => r.last))
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(seen.results.map((r) => [r.update.utterances.map((u) => u.text), r.last]), [[["最后一句。"], false], [[], true]])
  assert.equal(seen.results[1].update.keepInterims, true)
  assert.deepEqual(seen.closes, [], "the close after task-finished is the normal end")
  assert.deepEqual(server.seen.frames.filter((f) => !f.binary).map((f) => JSON.parse(f.text).header.action), ["run-task", "finish-task"])
})

test("a close after finish-task without task-finished still ends the stream", async () => {
  const server = await fakeWs(accepting((ws) => ws.on("message", (data, isBinary) => !isBinary && JSON.parse(data.toString()).header.action === "finish-task" && ws.close(1000))))
  const seen = collect()
  const { connection } = await dashScopeConnector(config(server.url))(seen.handlers)
  connection.sendAudio(new Int16Array(0), true)
  await waitFor(() => seen.results.some((r) => r.last))
  assert.deepEqual(seen.closes, [])
})

test("task-failed is fatal for key, balance, access, model and parameter errors, and retryable for timeouts and overload", () => {
  for (const code of ["InvalidApiKey", "Arrearage", "AccessDenied", "Model.AccessDenied", "ModelNotFound", "InvalidParameter", "AccessDenied.Unpurchased"]) assert.equal(taskFailedError(code, "x").fatal, true, code)
  for (const code of ["CLIENT_ERROR", "SERVER_ERROR", "Throttling.RateQuota", "InternalError", ""]) assert.equal(taskFailedError(code, "request timeout after 23 seconds.").fatal, false, code)
  assert.match(taskFailedError("CLIENT_ERROR", "request timeout after 23 seconds.").message, /CLIENT_ERROR.*request timeout after 23 seconds/)
})

test("after connecting, a task-failed event and an unexpected close come back as the right kind of drop", async () => {
  const cases: { act: (ws: import("ws").WebSocket, id: string) => void; fatal: boolean; message: RegExp }[] = [
    { act: (ws, id) => ws.send(event("task-failed", id, { error_code: "Arrearage", error_message: "Access denied, please make sure your account is in good standing." })), fatal: true, message: /Arrearage/ },
    { act: (ws, id) => ws.send(event("task-failed", id, { error_code: "CLIENT_ERROR", error_message: "request timeout after 23 seconds." })), fatal: false, message: /23 seconds|23 秒|CLIENT_ERROR/ },
    { act: (ws) => ws.terminate(), fatal: false, message: /1006/ },
    { act: (ws) => ws.close(1011, "boom"), fatal: false, message: /1011/ },
  ]
  for (const c of cases) {
    const server = await fakeWs(accepting((ws, id) => setTimeout(() => c.act(ws, id), 20)))
    const seen = collect()
    await dashScopeConnector(config(server.url))(seen.handlers)
    await waitFor(() => seen.closes.length > 0)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(seen.closes.length, 1, "one failure is reported once")
    assert.equal(seen.closes[0].fatal, c.fatal)
    assert.match(seen.closes[0].message, c.message)
  }
})

test("a task that fails before it starts rejects the connect with the service's error", async () => {
  const server = await fakeWs((ws) => ws.on("message", (data, isBinary) => !isBinary && ws.send(event("task-failed", taskIdOf(data.toString()), { error_code: "InvalidParameter", error_message: "bad model" }))))
  const error = (await dashScopeConnector(config(server.url))(collect().handlers).catch((e: unknown) => e)) as AsrError
  assert.ok(error instanceof AsrError)
  assert.equal(error.fatal, true)
  assert.match(error.message, /InvalidParameter.*bad model/)
})

test("handshake rejections: credentials and requests are fatal, throttling and outages are retried, a dead network is retried", async () => {
  for (const [status, fatal] of [[401, true], [403, true], [400, true], [404, true], [429, false], [503, false]] as const) {
    const server = await fakeWs(undefined, { status, body: '{"code":"InvalidApiKey","message":"Invalid API-key provided."}' })
    const error = (await dashScopeConnector(config(server.url))(collect().handlers).catch((e: unknown) => e)) as AsrError
    assert.equal(error.fatal, fatal, `HTTP ${status}`)
    assert.match(error.message, /Invalid API-key provided/, "the service's own words are kept")
  }
  const gone = await fakeWs()
  gone.close()
  const error = (await dashScopeConnector(config(gone.url))(collect().handlers).catch((e: unknown) => e)) as AsrError
  assert.equal(error.fatal, false)
})

test("closing locally is silent and sending afterwards is an error the streamer can handle", async () => {
  const server = await fakeWs(accepting())
  const seen = collect()
  const { connection } = await dashScopeConnector(config(server.url))(seen.handlers)
  connection.close()
  await new Promise((r) => setTimeout(r, 50))
  assert.throws(() => connection.sendAudio(pcm(100), false), (error: Error) => error instanceof AsrError && !error.fatal)
  assert.deepEqual(seen.closes, [])
})

test("settings: a key is all that is needed, the region picks the host, and old data gains the defaults", () => {
  const defaults = loadSettings(null).settings
  assert.deepEqual(defaults.providers.dashscope, { region: "cn", apiKeySecret: "", model: "qwen-audio-3.1-asr-flash-streaming" })
  assert.deepEqual(loadSettings({ version: 2, providers: { volc: {} } }).settings.providers.dashscope, defaults.providers.dashscope)
  assert.equal(loadSettings({ version: 2, providers: { dashscope: { region: "mars", model: 4, apiKeySecret: "k" } } }).settings.providers.dashscope.region, "cn")
  assert.deepEqual(loadSettings({ version: 2, providers: { dashscope: { region: "intl", apiKeySecret: "k", model: "fun-asr-realtime" } } }).settings.providers.dashscope, { region: "intl", apiKeySecret: "k", model: "fun-asr-realtime" })

  const { settings } = loadSettings(null)
  settings.liveProvider = "dashscope"
  settings.providers.dashscope.apiKeySecret = "ds"
  settings.asrLanguage = "zh"
  settings.hotwords = "科创板\n某某资本"
  const secrets = (value: string | null) => ({ getSecret: () => value })
  assert.match(resolveLive({ secrets: secrets(null), settings }).problem ?? "", /API Key/)
  const live = resolveLive({ secrets: secrets(" sk-1 "), settings })
  assert.equal(live.problem, undefined)
  assert.equal(typeof live.connect, "function")
  assert.deepEqual([live.id, live.name], ["dashscope", "阿里云百炼"])
  assert.deepEqual(destinations(settings).find((d) => d.kind === "live"), { kind: "live", name: "阿里云百炼", host: "dashscope.aliyuncs.com" })
  settings.providers.dashscope.region = "intl"
  assert.equal(destinations(settings).find((d) => d.kind === "live")?.host, "dashscope-intl.aliyuncs.com")

  const built = dashScopeConfig(secrets("sk-1"), settings.providers.dashscope, "zh", settings.hotwords)
  assert.deepEqual([built.endpoint, built.apiKey, built.language, built.hotwords], ["wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference", "sk-1", "zh", ["科创板", "某某资本"]])
  assert.equal(dashScopeConfig(secrets("sk-1"), settings.providers.dashscope, "auto", "").language, undefined)
  assert.match(dashScopeConfigProblem({ ...built, model: " " }) ?? "", /模型/)
})
