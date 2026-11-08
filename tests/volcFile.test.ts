import assert from "node:assert/strict"
import { test } from "node:test"
import { transcribeFile, type FileAsrPost, type FileAsrResponse } from "../src/asr/fileAsr.ts"
import { parseFileResult, statusOf, volcFileProvider } from "../src/asr/providers/volc/file.ts"
import type { PreparedAudio } from "../src/audio/transcode.ts"

const auth = { apiKey: "k", appId: "", accessToken: "", resourceId: "volc.seedasr.auc" }
const ok = (body: unknown = {}, code = "20000000"): FileAsrResponse => ({ status: 200, headers: { "x-api-status-code": code, "x-api-message": "OK" }, text: body === "" ? "" : JSON.stringify(body) })
const audio = (bytes: number[], format = "mp3"): PreparedAudio => ({ data: new Uint8Array(bytes), format, transcoded: false, bytes: bytes.length })

const payload = {
  audio_info: { duration: 20_000 },
  result: {
    text: "全文",
    utterances: [
      { text: "您好，先介绍一下公司。", start_time: 0, end_time: 3000, additions: { speaker: "1" } },
      { text: "我们成立于2019年。", start_time: 3200, end_time: 6000, additions: { speaker: "2" } },
      { text: "去年收入2亿。", start_time: 6100, end_time: 9000, additions: { speaker: "2" } },
      { text: "毛利多少？", start_time: 9500, end_time: 11000, additions: { speaker: "1" } },
      { text: "四成左右。", start_time: 30_000, end_time: 32_000, speaker: "2" },
    ],
  },
}

test("status comes from the header, or the body header when missing; auth and 413 are explicit", () => {
  assert.equal(statusOf(ok({}, "20000001")).code, "20000001")
  assert.deepEqual(statusOf({ status: 400, headers: {}, text: '{"header":{"code":45000001,"message":"bad audio"}}' }).code, "45000001")
  assert.throws(() => statusOf({ status: 403, headers: {}, text: "requested resource not granted" }), /鉴权失败（HTTP 403）/)
  assert.throws(() => statusOf({ status: 413, headers: {}, text: "<html>too large</html>" }), /HTTP 413/)
})

test("submit then polls until done, reading speakers from additions", async () => {
  const calls: { url: string; headers: Record<string, string>; body: string | ArrayBuffer }[] = []
  const replies = [ok(""), ok({}, "20000001"), ok({}, "20000002"), ok(payload)]
  const stages: string[] = []
  const post: FileAsrPost = async (url, headers, body) => {
    calls.push({ url, headers, body })
    return replies.shift()!
  }
  const result = await volcFileProvider(auth).transcribe(audio([65, 66, 67]), { speakers: true, post, onStage: (s) => stages.push(s.stage), sleep: async () => undefined })
  assert.match(calls[0].url, /\/api\/v3\/auc\/bigmodel\/submit$/)
  const submitted = JSON.parse(calls[0].body as string)
  assert.deepEqual(submitted.audio, { data: "QUJD", format: "mp3" })
  assert.equal(submitted.request.enable_speaker_info, true)
  assert.equal(submitted.request.corpus, undefined)
  assert.equal(calls[0].headers["X-Api-Key"], "k")
  assert.equal(calls[1].headers["X-Api-Request-Id"], calls[0].headers["X-Api-Request-Id"])
  assert.equal(calls.length, 4)
  assert.deepEqual(stages, ["uploading", "recognizing", "recognizing", "recognizing"])
  assert.deepEqual(result.utterances.map((u) => u.speaker), ["1", "2", "2", "1", "2"])
})

test("the upload is the bytes of the view, not of the whole buffer behind it", async () => {
  const backing = new Uint8Array([0, 0, 65, 66, 67, 0, 0])
  const view = backing.subarray(2, 5)
  assert.notEqual(view.buffer.byteLength, view.byteLength)
  const bodies: string[] = []
  const replies = [ok(""), ok(payload)]
  await volcFileProvider(auth).transcribe({ data: view, format: "mp3", transcoded: false, bytes: 3 }, { speakers: false, post: async (_u, _h, b) => (bodies.push(b as string), replies.shift()!), sleep: async () => undefined })
  assert.equal(JSON.parse(bodies[0]).audio.data, "QUJD")
})

test("failed recognition status surfaces the service message", async () => {
  const replies = [ok(""), { status: 200, headers: {}, text: '{"header":{"code":55000001,"message":"internal"}}' }]
  await assert.rejects(volcFileProvider(auth).transcribe(audio([]), { speakers: false, post: async () => replies.shift()!, sleep: async () => undefined }), /55000001 internal/)
})

test("missing credentials are reported as a problem, and the provider says what it takes and where it sends audio", () => {
  const provider = volcFileProvider({ ...auth, apiKey: "" })
  assert.match(provider.problem ?? "", /未配置火山引擎凭证/)
  assert.equal(volcFileProvider({ ...auth, apiKey: "", appId: "a", accessToken: "t" }).problem, undefined)
  assert.equal(provider.host, "openspeech.bytedance.com")
  assert.equal(provider.model, "volc.seedasr.auc")
  assert.equal(provider.directFormats.m4a, "mp4")
  assert.equal(provider.capabilities.fileSizeLimit, 60 * 1024 * 1024)
})

test("the generic path still rejects a silently truncated Volcengine result", async () => {
  const truncated = { audio_info: { duration: 7_200_000 }, result: { text: "x", utterances: [{ text: "x", start_time: 0, end_time: 600_000 }] } }
  const replies = [ok(""), ok(truncated)]
  await assert.rejects(transcribeFile(volcFileProvider(auth), audio([1]), { speakers: false, post: async () => replies.shift()!, sleep: async () => undefined }), /静默截断/)
})

test("results map to utterances with speaker and trimmed text", () => {
  const result = parseFileResult(payload)
  assert.equal(result.durationMs, 20_000)
  assert.equal(result.utterances.length, 5)
  assert.equal(result.utterances[1].speaker, "2")
})
