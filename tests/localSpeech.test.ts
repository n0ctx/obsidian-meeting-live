// A local OpenAI-compatible speech account: file and pause-then-text, against a fake server.
// The fixture names no machine, no home directory and no real key. The model name and port are not this computer's.
import assert from "node:assert/strict"
import { test } from "node:test"
import { freeCheck } from "../src/accounts/check.ts"
import { serviceDef } from "../src/accounts/services.ts"
import type { AsrConnectionHandlers } from "../src/asr/contract.ts"
import type { FileAsrPost } from "../src/asr/fileAsr.ts"
import { resolveFile, resolveLive } from "../src/asr/providers/registry.ts"
import { checkLocalSpeech, speechModelIds } from "../src/asr/providers/localSpeech/check.ts"
import { localSpeechConnector } from "../src/asr/providers/localSpeech/live.ts"
import { PauseCutter } from "../src/asr/providers/localSpeech/segment.ts"
import { asrChipLabel } from "../src/ui/asrChip.ts"
import { t } from "../src/i18n/index.ts"
import { loadSettings } from "../src/settings.ts"
import { withOne } from "./support/accounts.ts"

const RATE = 16000
const MODEL = "speech-small"
const BASE = "http://127.0.0.1:9400/v1"
const audio = { data: new Uint8Array([1, 2, 3, 4]), format: "wav", transcoded: true, bytes: 4 }

const loud = (ms: number) => {
  const pcm = new Int16Array((ms / 1000) * RATE)
  for (let i = 0; i < pcm.length; i++) pcm[i] = i % 2 ? 8000 : -8000
  return pcm
}
const quiet = (ms: number) => new Int16Array((ms / 1000) * RATE)

/** The text fields of a multipart body. */
function fieldsOf(headers: Record<string, string>, body: ArrayBuffer): Record<string, string> {
  const boundary = /boundary=(.+)$/.exec(headers["Content-Type"])![1]
  const bytes = Buffer.from(body)
  const delimiter = Buffer.from(`--${boundary}`)
  const fields: Record<string, string> = {}
  let at = bytes.indexOf(delimiter)
  while (at >= 0) {
    const next = bytes.indexOf(delimiter, at + delimiter.length)
    if (next < 0) break
    const part = bytes.subarray(at + delimiter.length + 2, next - 2)
    const split = part.indexOf("\r\n\r\n")
    const head = part.subarray(0, split).toString("utf8")
    const name = /name="([^"]+)"/.exec(head)?.[1]
    if (name && name !== "file") fields[name] = part.subarray(split + 4).toString("utf8")
    at = next
  }
  return fields
}

const verbose = {
  text: "你好。",
  duration: 1.2,
  segments: [{ start: 0.1, end: 1.1, text: "你好。", speaker: "A" }],
}

test("a pause ends an utterance, a short click does not, and the chunk sits where the speech was", () => {
  const cutter = new PauseCutter(800, 15_000)
  assert.equal(cutter.push(quiet(1000)).length, 0)
  assert.equal(cutter.push(loud(200)).length, 0, "a click is not a sentence")
  assert.equal(cutter.push(quiet(800)).length, 0)
  const ready = cutter.push(loud(1000))
  assert.equal(ready.length, 0)
  const cut = cutter.push(quiet(800))
  assert.equal(cut.length, 1)
  assert.ok(cut[0].startSample >= RATE, "the leading silence is not part of the utterance")
  assert.ok(cut[0].pcm.length >= RATE, "the second of speech is in the chunk")
})

test("a local address with no key is not configured, and a listed model is used without being typed", () => {
  const { settings } = withOne("local-speech", { options: { baseUrl: BASE, model: MODEL } })
  assert.match(resolveFile({ secrets: { getSecret: () => null }, settings }).problem ?? "", /API Key/)
  assert.equal(resolveLive({ secrets: { getSecret: () => null }, settings }).connect, null)
  settings.accounts[0].apiKeySecret = "speech-key"
  const file = resolveFile({ secrets: { getSecret: () => "secret" }, settings })
  assert.equal(file.problem, undefined)
  assert.equal(file.model, MODEL)
  assert.equal(file.capabilities.diarization, false)
  assert.equal(file.host, "127.0.0.1:9400")
  assert.ok(file.capabilities.fileSizeLimit > 25 * 1024 * 1024)
  assert.equal(resolveLive({ secrets: { getSecret: () => "secret" }, settings }).afterPause, true)
  assert.equal(serviceDef("local-speech")?.presets, undefined, "this account is not a language model")
  assert.match(serviceDef("local-speech")?.summary?.() ?? "", /停顿后出字/)
  assert.equal(asrChipLabel(true, "live", undefined), "card.asr.afterPause")
  assert.equal(asrChipLabel(true, "live", "recognizing"), "card.asr.recognizing")
  assert.equal(t("card.asr.afterPause"), "停顿后出字")
  assert.equal(t("card.asr.recognizing"), "还在识别")
})

test("the file request is the plugin's multipart, timed, and does not keep a speaker the server sent", async () => {
  const { settings } = withOne("local-speech", { key: "speech-key", options: { baseUrl: BASE, model: MODEL } })
  settings.asrLanguage = "zh"
  settings.hotwords = "蓝箭"
  const requests: { url: string; headers: Record<string, string>; body: ArrayBuffer }[] = []
  const post: FileAsrPost = async (url, headers, body) => {
    requests.push({ url, headers, body: body as ArrayBuffer })
    return { status: 200, headers: {}, text: JSON.stringify(verbose) }
  }
  const result = await resolveFile({ secrets: { getSecret: () => "secret" }, settings, context: () => ({ hotwords: ["蓝箭"], scene: "融资" }) }).transcribe(audio, { speakers: true, post })
  assert.equal(requests[0].url, `${BASE}/audio/transcriptions`)
  assert.equal(requests[0].headers.Authorization, "Bearer secret")
  const fields = fieldsOf(requests[0].headers, requests[0].body)
  assert.equal(fields.model, MODEL)
  assert.equal(fields.response_format, "verbose_json")
  assert.equal(fields["timestamp_granularities[]"], "segment")
  assert.match(fields.prompt, /蓝箭/)
  assert.match(fields.prompt, /融资/)
  assert.deepEqual(result.utterances, [{ text: "你好。", startMs: 100, endMs: 1100, speaker: undefined }])
  assert.doesNotMatch(MODEL, /qwen/i)
  assert.doesNotMatch(BASE, /8765/)
})

test("a prompt the server rejects is dropped and tried again; verbose_json still falls back to json", async () => {
  const { settings } = withOne("local-speech", { key: "speech-key", options: { baseUrl: BASE, model: MODEL } })
  const formats: string[][] = []
  const prompts: boolean[] = []
  const post: FileAsrPost = async (_url, headers, body) => {
    const fields = fieldsOf(headers, body as ArrayBuffer)
    formats.push([fields.response_format])
    prompts.push("prompt" in fields)
    const refused = prompts.length === 1 || (prompts.length === 2 && fields.response_format === "verbose_json")
    return refused ? { status: 400, headers: {}, text: JSON.stringify({ error: { message: "unknown field" } }) } : { status: 200, headers: {}, text: JSON.stringify({ text: "文字" }) }
  }
  const result = await resolveFile({ secrets: { getSecret: () => "secret" }, settings, context: () => ({ hotwords: ["词"] }) }).transcribe(audio, { speakers: false, post })
  assert.deepEqual(prompts, [true, false, false])
  assert.deepEqual(formats, [["verbose_json"], ["verbose_json"], ["json"]])
  assert.equal(result.utterances[0].text, "文字")
})

test("a live utterance is posted once the pause arrives, times land on the meeting audio, and the next waits", async () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  const requests: { headers: Record<string, string>; fields: Record<string, string> }[] = []
  const updates: { activity?: string; text?: string; startMs?: number; speaker?: string; last?: boolean }[] = []
  const post: FileAsrPost = async (_url, headers, body) => {
    requests.push({ headers, fields: fieldsOf(headers, body as ArrayBuffer) })
    if (requests.length === 1) await gate
    return { status: 200, headers: {}, text: JSON.stringify(verbose) }
  }
  const handlers: AsrConnectionHandlers = {
    onResult: (update, last) => {
      updates.push({ activity: update.activity, text: update.utterances[0]?.text, startMs: update.utterances[0]?.startMs, speaker: update.utterances[0]?.speaker, last })
    },
    onClose: (error) => updates.push({ text: error.message }),
  }
  const { connection } = await localSpeechConnector({ baseUrl: BASE, model: MODEL, apiKey: "secret", language: "zh", fileSizeLimit: 1, responseFormat: "verbose_json" }, 800, 15_000, post)(handlers)
  connection.sendAudio(loud(1000), false)
  connection.sendAudio(quiet(800), false)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].headers.Authorization, "Bearer secret")
  assert.equal(requests[0].fields.model, MODEL)
  assert.equal(requests[0].fields.response_format, "verbose_json")
  assert.equal(updates.some((u) => u.activity === "recognizing"), true)
  connection.sendAudio(loud(1000), false)
  connection.sendAudio(quiet(800), false)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(requests.length, 1, "the next utterance waits for the one already posted")
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const finals = updates.filter((u) => u.text === "你好。")
  assert.equal(finals.length, 2)
  assert.ok((finals[0].startMs ?? 0) >= 0)
  assert.equal(finals[0].speaker, undefined)
  assert.equal(requests.length, 2)
})

test("a missing key is refused as a key, and a dead service is not a stack", async () => {
  let called = 0
  const empty = await checkLocalSpeech(BASE, "", async () => {
    called++
    return { status: 200, text: "{\"data\":[{\"id\":\"speech-small\"}]}" }
  })
  assert.equal(called, 0, "an empty key is not sent, and a keyless 200 must not count as configured")
  assert.equal(empty.state === "failed" && empty.message, "密钥不对")
  const refused = await checkLocalSpeech(BASE, "nope", async () => ({ status: 401, text: "Error: secret leaked\n    at Server.listen" }))
  assert.equal(refused.state === "failed" && refused.message, "密钥不对")
  assert.doesNotMatch(refused.state === "failed" ? refused.message : "", /secret|at Server/)
  const down = await checkLocalSpeech(BASE, "secret", async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:9400\n    at TCPConnectWrap")
  })
  assert.equal(down.state === "failed" && down.message, "服务没开")
  assert.doesNotMatch(down.state === "failed" ? down.message : "", /ECONNREFUSED|TCPConnectWrap/)
  const missing = await checkLocalSpeech(BASE, "secret", async () => ({ status: 404, text: "stack\n    at listen" }))
  assert.equal(missing.state === "failed" && missing.message, "服务器返回了 HTTP 404，暂时无法确认密钥。")
  assert.doesNotMatch(missing.state === "failed" ? missing.message : "", /stack|listen/)
  const { settings, account } = withOne("local-speech", { options: { baseUrl: BASE } })
  const ok = await freeCheck(account, "secret", { get: async () => ({ status: 200, text: JSON.stringify({ data: [{ id: MODEL, owned_by: "fixture" }] }) }), post: async () => ({ status: 500, text: "" }), volcHandshake: async () => ({ ok: false, status: 0, body: "" }), liveTest: async () => ({ ok: false }), secrets: { getSecret: () => null } })
  assert.deepEqual(ok, { state: "ok", models: [MODEL], options: { model: MODEL } })
  assert.equal(speechModelIds({ data: [{ id: "nope" }, { id: MODEL }] })?.[0], "nope")
  assert.equal(settings.accounts[0].service, "local-speech")
  const old = loadSettings({ version: 2, liveProvider: "volc", fileProvider: "volc" }).settings
  assert.equal(old.accounts.some((a) => a.service === "local-speech"), false)
})
