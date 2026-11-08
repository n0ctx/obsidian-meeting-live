import assert from "node:assert/strict"
import { test } from "node:test"
import type { FileAsrPost, FileAsrResponse } from "../src/asr/fileAsr.ts"
import { deepgramFileProvider, deepgramFileUrl, parseDeepgramFile, type DeepgramFileConfig } from "../src/asr/providers/deepgram/file.ts"
import { deepgramFileConfig } from "../src/asr/providers/deepgram/settings.ts"
import { loadSettings } from "../src/settings.ts"
import type { PreparedAudio } from "../src/audio/transcode.ts"

const config = (patch: Partial<DeepgramFileConfig> = {}): DeepgramFileConfig => ({ url: "https://api.deepgram.com/v1/listen", apiKey: "dg-key", model: "nova-3", language: "zh", ...patch })
const audio = (format = "ogg", n = 12): PreparedAudio => ({ data: new Uint8Array(n).fill(5), format, transcoded: true, bytes: n })
const reply = (body: unknown, status = 200): FileAsrResponse => ({ status, headers: {}, text: JSON.stringify(body) })

const answer = {
  metadata: { duration: 9.5 },
  results: {
    channels: [{ alternatives: [{ transcript: "你好。再见。" }] }],
    utterances: [{ start: 0.2, end: 1.4, transcript: "你好。", speaker: 0 }, { start: 2, end: 3.1, transcript: "再见。", speaker: 1 }, { start: 4, end: 4.5, transcript: "  ", speaker: 0 }],
  },
}

test("the request is the raw bytes with a matching content type, a Token key, utterances, and the language or detection", async () => {
  const seen: { url: string; headers: Record<string, string>; body: string | ArrayBuffer }[] = []
  const post: FileAsrPost = async (url, headers, body) => (seen.push({ url, headers, body }), reply(answer))
  const stages: string[] = []
  await deepgramFileProvider(config()).transcribe(audio("ogg"), { speakers: false, post, onStage: (s) => stages.push(s.stage) })
  assert.equal(seen[0].headers["Content-Type"], "audio/ogg")
  assert.equal(seen[0].headers.Authorization, "Token dg-key")
  assert.equal((seen[0].body as ArrayBuffer).byteLength, 12)
  assert.deepEqual(Object.fromEntries(new URL(seen[0].url).searchParams), { model: "nova-3", smart_format: "true", utterances: "true", language: "zh" })
  assert.deepEqual(stages, ["uploading", "recognizing"])

  const params = (c: DeepgramFileConfig, speakers: boolean) => new URL(deepgramFileUrl(c, speakers)).searchParams
  assert.equal(params(config({ language: undefined }), false).get("detect_language"), "true")
  assert.equal(params(config({ language: undefined }), false).has("language"), false)
  assert.equal(params(config(), true).get("diarize"), "true")
  assert.equal(params(config(), false).has("diarize"), false)
  // A view into a larger buffer sends only its own bytes, and a local server needs no key.
  const view = { ...audio("mp3"), data: new Uint8Array(new ArrayBuffer(100), 10, 20) }
  await deepgramFileProvider(config({ apiKey: "", url: "http://127.0.0.1:1/v1/listen" })).transcribe(view, { speakers: false, post })
  assert.equal((seen[1].body as ArrayBuffer).byteLength, 20)
  assert.equal("Authorization" in seen[1].headers, false)
  assert.equal(seen[1].headers["Content-Type"], "audio/mpeg")
})

test("utterances become timed sentences, with speakers numbered from 1 only when asked for", () => {
  const withSpeakers = parseDeepgramFile(JSON.stringify(answer), true)
  assert.equal(withSpeakers.durationMs, 9500)
  assert.deepEqual(withSpeakers.utterances, [{ text: "你好。", startMs: 200, endMs: 1400, speaker: "1" }, { text: "再见。", startMs: 2000, endMs: 3100, speaker: "2" }])
  assert.deepEqual(parseDeepgramFile(JSON.stringify(answer), false).utterances.map((u) => u.speaker), [undefined, undefined])
  const noUtterances = parseDeepgramFile(JSON.stringify({ metadata: { duration: 3 }, results: { channels: [{ alternatives: [{ transcript: "只有文字" }] }] } }), false)
  assert.deepEqual(noUtterances.utterances, [{ text: "只有文字", startMs: 0, endMs: 0 }])
  assert.throws(() => parseDeepgramFile("<html>", false), /不是 JSON/)
})

test("errors say what to fix: key, balance, access, size, rate, the 10-minute processing limit and the rest", async () => {
  const fail = (status: number, err_msg = "x") => deepgramFileProvider(config()).transcribe(audio(), { speakers: false, post: async () => reply({ err_code: "E", err_msg }, status) })
  await assert.rejects(fail(401, "Invalid credentials."), /鉴权失败.*Invalid credentials/)
  await assert.rejects(fail(402), /余额不足/)
  await assert.rejects(fail(403), /拒绝访问/)
  await assert.rejects(fail(413), /超过大小上限/)
  await assert.rejects(fail(429, "too many"), /429.*too many/)
  await assert.rejects(fail(504), /504.*10 分钟/)
  await assert.rejects(fail(503, "down"), /HTTP 503.*down/)
  await assert.rejects(fail(400, "corrupt data"), /HTTP 400.*corrupt data/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(deepgramFileProvider(config()).transcribe(audio(), { speakers: false, post: async () => reply(answer), signal: controller.signal }), /已取消/)
})

test("declared capabilities and configuration problems", () => {
  const p = deepgramFileProvider(config())
  assert.deepEqual(p.capabilities, { language: true, diarization: true, fileSizeLimit: 2 * 1024 ** 3 })
  assert.equal(p.host, "api.deepgram.com")
  assert.equal(p.directFormats.wav, "wav")
  assert.equal(p.problem, undefined)
  assert.match(deepgramFileProvider(config({ apiKey: "" })).problem ?? "", /API Key/)
  assert.equal(deepgramFileProvider(config({ apiKey: "", url: "http://localhost:8080/v1/listen" })).problem, undefined)
  assert.match(deepgramFileProvider(config({ url: "" })).problem ?? "", /地址/)
  assert.match(deepgramFileProvider(config({ model: "" })).problem ?? "", /模型/)
  const { settings } = loadSettings(null)
  settings.providers.deepgram.apiKeySecret = "dg"
  assert.deepEqual(deepgramFileConfig({ getSecret: () => " k " }, settings.providers.deepgram, "auto"), { url: "https://api.deepgram.com/v1/listen", apiKey: "k", model: "nova-3", language: undefined })
})
