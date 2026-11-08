import assert from "node:assert/strict"
import { test } from "node:test"
import type { FileAsrCall, FileAsrGet, FileAsrPost, FileAsrResponse } from "../src/asr/fileAsr.ts"
import { assertCoverage, renderInterviewRecord } from "../src/asr/fileAsr.ts"
import { assemblyAiFileProvider, parseTranscript, sentencesFromWords, submitBody } from "../src/asr/providers/assemblyai/file.ts"
import type { PreparedAudio } from "../src/audio/transcode.ts"

const audio = (n = 10): PreparedAudio => ({ data: new Uint8Array(n).fill(3), format: "ogg", transcoded: true, bytes: n })
const ok = (body: unknown): FileAsrResponse => ({ status: 200, headers: {}, text: JSON.stringify(body) })

interface Script {
  upload?: FileAsrResponse
  submit?: FileAsrResponse
  polls?: FileAsrResponse[]
}

/** The three calls of the flow, recording what was sent. */
function flow(script: Script) {
  const sent: { method: string; url: string; headers: Record<string, string>; body?: string | ArrayBuffer }[] = []
  const polls = [...(script.polls ?? [])]
  const post: FileAsrPost = async (url, headers, body) => {
    sent.push({ method: "POST", url, headers, body })
    return url.endsWith("/v2/upload") ? (script.upload ?? ok({ upload_url: "https://cdn.assemblyai.com/upload/abc" })) : (script.submit ?? ok({ id: "tr-1", status: "queued" }))
  }
  const get: FileAsrGet = async (url, headers) => {
    sent.push({ method: "GET", url, headers })
    return polls.shift() ?? ok({ status: "processing" })
  }
  const call = (patch: Partial<FileAsrCall> = {}): FileAsrCall => ({ speakers: false, post, get, sleep: async () => undefined, ...patch })
  return { sent, call }
}

const provider = (language?: string) => assemblyAiFileProvider({ baseUrl: "https://api.assemblyai.com", apiKey: "key-1", language })
const completed = (extra: object = {}) => ok({ id: "tr-1", status: "completed", text: "你好。再见。", audio_duration: 12, words: [{ text: "你好。", start: 100, end: 900 }, { text: "再见。", start: 1000, end: 1800 }], ...extra })

test("the flow uploads the raw bytes, submits the job with the language, and polls until it completes", async () => {
  const stages: string[] = []
  const { sent, call } = flow({ polls: [ok({ status: "queued" }), ok({ status: "processing" }), completed()] })
  const result = await provider("zh").transcribe(audio(), call({ onStage: (s) => stages.push(s.stage) }))

  const [upload, submit, ...polls] = sent
  assert.equal(upload.url, "https://api.assemblyai.com/v2/upload")
  assert.deepEqual(upload.headers, { authorization: "key-1", "Content-Type": "application/octet-stream" })
  assert.equal((upload.body as ArrayBuffer).byteLength, 10, "the file goes up as raw bytes")
  assert.equal(submit.url, "https://api.assemblyai.com/v2/transcript")
  assert.equal(submit.headers.authorization, "key-1")
  assert.deepEqual(JSON.parse(submit.body as string), { audio_url: "https://cdn.assemblyai.com/upload/abc", language_code: "zh" })
  assert.deepEqual(polls.map((p) => [p.method, p.url, p.headers]), Array(3).fill(["GET", "https://api.assemblyai.com/v2/transcript/tr-1", { authorization: "key-1" }]))
  assert.equal(stages[0], "uploading")
  assert.ok(stages.includes("recognizing"))

  assert.equal(result.durationMs, 12_000)
  assert.deepEqual(result.utterances, [{ text: "你好。", startMs: 100, endMs: 900 }, { text: "再见。", startMs: 1000, endMs: 1800 }])
})

test("automatic language and speaker labels: no language is sent, labels are asked for on request and come back as speakers", async () => {
  assert.deepEqual(submitBody("u", { baseUrl: "b", apiKey: "k", language: undefined }, false), { audio_url: "u" })
  assert.deepEqual(submitBody("u", { baseUrl: "b", apiKey: "k", language: undefined }, true), { audio_url: "u", speaker_labels: true })
  const { sent, call } = flow({ polls: [completed({ utterances: [{ speaker: "A", text: "你好。", start: 100, end: 900 }, { speaker: "B", text: "再见。", start: 1000, end: 1800 }] })] })
  const result = await provider().transcribe(audio(), call({ speakers: true }))
  assert.equal(JSON.parse(sent[1].body as string).speaker_labels, true)
  assert.deepEqual(result.utterances.map((u) => u.speaker), ["A", "B"])
  // Without the request the labels are not shown even if the reply carries utterances.
  const plain = parseTranscript({ text: "x", utterances: [{ speaker: "A", text: "x", start: 0, end: 1 }], words: [{ text: "x.", start: 0, end: 1 }] }, false)
  assert.equal(plain.utterances[0].speaker, undefined)
})

test("words become sentences at terminal punctuation, and a long run without any is cut", () => {
  const sentences = sentencesFromWords([{ text: "Hello", start: 0, end: 200 }, { text: "there.", start: 250, end: 600 }, { text: "How", start: 900, end: 1000 }, { text: "are", start: 1000, end: 1100 }, { text: "you?", start: 1100, end: 1400 }, { text: "", start: 1, end: 2 }])
  assert.deepEqual(sentences, [{ text: "Hello there.", startMs: 0, endMs: 600 }, { text: "How are you?", startMs: 900, endMs: 1400 }])
  const long = sentencesFromWords(Array.from({ length: 100 }, (_, i) => ({ text: `w${i}`, start: i * 10, end: i * 10 + 9 })))
  assert.deepEqual(long.map((s) => s.text.split(" ").length), [40, 40, 20])
  // Chinese words are joined without spaces.
  assert.equal(sentencesFromWords([{ text: "你好，", start: 0, end: 1 }, { text: "世界。", start: 1, end: 2 }])[0].text, "你好，世界。")
  assert.deepEqual(parseTranscript({ text: "only text" }, false).utterances, [{ text: "only text", startMs: 0, endMs: 0 }])
})

test("errors say what to fix: a bad key, an empty account, a failed job and a rejected upload", async () => {
  const run = (script: Script) => provider().transcribe(audio(), flow(script).call())
  const status = (code: number, error: string): FileAsrResponse => ({ status: code, headers: {}, text: JSON.stringify({ error }) })
  await assert.rejects(run({ upload: status(401, "Authentication error, API token missing/invalid") }), /鉴权失败.*Authentication error/)
  await assert.rejects(run({ upload: status(402, "Insufficient funds") }), /余额不足.*Insufficient funds/)
  await assert.rejects(run({ upload: status(429, "slow down") }), /429.*slow down/)
  await assert.rejects(run({ upload: status(503, "overloaded") }), /HTTP 503.*overloaded/)
  await assert.rejects(run({ submit: status(400, "audio_url is invalid") }), /HTTP 400.*audio_url is invalid/)
  await assert.rejects(run({ polls: [ok({ status: "error", error: "Transcoding failed. File type text/plain" })] }), /识别失败.*Transcoding failed/)
  await assert.rejects(run({ upload: ok({}) }), /没有返回上传后的文件地址/)
  await assert.rejects(run({ submit: ok({ status: "queued" }) }), /没有返回识别任务编号/)
  await assert.rejects(run({ upload: { status: 200, headers: {}, text: "<html>" } }), /不是 JSON/)
  await assert.rejects(provider().transcribe(audio(), { speakers: false, post: async () => ok({}) }), /不能向 AssemblyAI 查询/)
})

test("polling can be cancelled and gives up after the wait limit", async () => {
  const controller = new AbortController()
  const { call } = flow({})
  const pending = provider().transcribe(audio(), call({ signal: controller.signal, sleep: async () => controller.abort() }))
  await assert.rejects(pending, /已取消/)
  let slept = 0
  await assert.rejects(provider().transcribe(audio(), flow({}).call({ sleep: async (ms) => void (slept += ms) })), /识别超时/)
  assert.ok(slept >= 30 * 60_000)
})

test("a completed transcript passes the same coverage check as every file service, and the note names the provider", async () => {
  const { call } = flow({ polls: [completed({ audio_duration: 300 })] })
  const result = await provider().transcribe(audio(), call())
  assert.throws(() => assertCoverage(result), /识别结果不完整/)
  const note = renderInterviewRecord(await provider().transcribe(audio(), flow({ polls: [completed()] }).call({ speakers: true })), { title: "t", source: "s", transcribedAt: "now", provider: "AssemblyAI", model: provider().model }, false)
  assert.match(note, /AssemblyAI/)
})

test("declared capabilities: language, speakers, the upload limit and the formats taken as they are", () => {
  const p = provider()
  assert.deepEqual(p.capabilities, { language: true, diarization: true, fileSizeLimit: Math.floor(2.2 * 1024 ** 3) })
  assert.equal(p.directFormats.mp3, "mp3")
  assert.equal(p.directFormats.ogg, "ogg")
  assert.equal(p.host, "api.assemblyai.com")
})
