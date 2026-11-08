import assert from "node:assert/strict"
import { test } from "node:test"
import { assertCoverage, renderInterviewRecord, transcribeFile, type FileAsrPost } from "../src/asr/fileAsr.ts"
import { resolveFile } from "../src/asr/providers/registry.ts"
import { OPENAI_FILE_LIMIT } from "../src/asr/providers/openaiCompat/info.ts"
import { asrProvider } from "../src/asr/providers/registry.ts"
import { buildMultipart, errorOf, parseTranscription, responseFormatFor, transcriptionsUrl, type OpenAiFileConfig, openAiFileProvider } from "../src/asr/providers/openaiCompat/file.ts"
import { loadSettings, type MeetingLiveSettings } from "../src/settings.ts"
import { isLocalHost } from "../src/url.ts"

const audio = { data: new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 255, 10, 13]), format: "ogg", transcoded: true, bytes: 8 }
const config = (patch: Partial<OpenAiFileConfig> = {}): OpenAiFileConfig => ({ baseUrl: "http://127.0.0.1:9/v1", model: "whisper-1", apiKey: "k", language: undefined, fileSizeLimit: OPENAI_FILE_LIMIT, ...patch })

/** A fake service: records each request and answers with the next reply. */
function service(...replies: { status?: number; body: unknown }[]) {
  const requests: { url: string; headers: Record<string, string>; body: ArrayBuffer }[] = []
  const post: FileAsrPost = async (url, headers, body) => {
    assert.ok(body instanceof ArrayBuffer, "multipart goes up as bytes")
    requests.push({ url, headers, body })
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)]
    return { status: reply.status ?? 200, headers: {}, text: typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body) }
  }
  return { post, requests }
}

/** The text fields of a multipart body and the bytes of its file part. */
function readForm(request: { headers: Record<string, string>; body: ArrayBuffer }) {
  const boundary = /boundary=(.+)$/.exec(request.headers["Content-Type"])![1]
  const bytes = Buffer.from(request.body)
  const delimiter = Buffer.from(`--${boundary}`)
  const fields: Record<string, string[]> = {}
  let file: { name: string; mime: string; data: Buffer } | undefined
  let at = bytes.indexOf(delimiter)
  while (at >= 0) {
    const next = bytes.indexOf(delimiter, at + delimiter.length)
    if (next < 0) break
    const part = bytes.subarray(at + delimiter.length + 2, next - 2)
    const split = part.indexOf("\r\n\r\n")
    const head = part.subarray(0, split).toString("utf8")
    const content = part.subarray(split + 4)
    const name = /name="([^"]+)"/.exec(head)![1]
    if (name === "file") file = { name: /filename="([^"]+)"/.exec(head)![1], mime: /Content-Type: (.+)/.exec(head)![1], data: Buffer.from(content) }
    else (fields[name] ??= []).push(content.toString("utf8"))
    at = next
  }
  assert.equal(bytes.subarray(bytes.length - boundary.length - 8).toString(), `\r\n--${boundary}--\r\n`)
  return { fields, file: file! }
}

test("the multipart body is built by hand: text fields, then the file's exact bytes, closed by the final boundary", () => {
  const form = buildMultipart([["model", "whisper-1"], ["timestamp_granularities[]", "segment"]], { name: "audio.ogg", mime: "audio/ogg", data: audio.data }, "XBOUND")
  assert.equal(form.contentType, "multipart/form-data; boundary=XBOUND")
  const text = Buffer.from(form.body).toString("latin1")
  assert.ok(text.startsWith('--XBOUND\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--XBOUND\r\nContent-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\nsegment\r\n'))
  assert.ok(text.endsWith(`Content-Disposition: form-data; name="file"; filename="audio.ogg"\r\nContent-Type: audio/ogg\r\n\r\n${Buffer.from(audio.data).toString("latin1")}\r\n--XBOUND--\r\n`))
  // The body is exactly its own bytes, not a window onto a larger buffer.
  assert.equal(form.body.byteLength, Buffer.from(form.body).length)
})

test("a whisper-style model is asked for timed segments, and the reply becomes timed utterances", async () => {
  const { post, requests } = service({ body: { text: "你好。再见。", duration: 12.5, language: "chinese", segments: [{ id: 0, start: 0, end: 4.2, text: " 你好。" }, { id: 1, start: 4.2, end: 12.4, text: " 再见。" }, { id: 2, start: 12.4, end: 12.5, text: "  " }] } })
  const provider = openAiFileProvider(config({ language: "zh" }))
  const result = await transcribeFile(provider, audio, { speakers: true, post })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, "http://127.0.0.1:9/v1/audio/transcriptions")
  assert.equal(requests[0].headers.Authorization, "Bearer k")
  const { fields, file } = readForm(requests[0])
  assert.deepEqual(fields, { model: ["whisper-1"], response_format: ["verbose_json"], "timestamp_granularities[]": ["segment"], language: ["zh"] })
  assert.deepEqual([file.name, file.mime, [...file.data]], ["audio.ogg", "audio/ogg", [...audio.data]])
  assert.deepEqual(result.utterances, [
    { text: "你好。", startMs: 0, endMs: 4200, speaker: undefined },
    { text: "再见。", startMs: 4200, endMs: 12_400, speaker: undefined },
  ])
  assert.equal(result.durationMs, 12_500)
})

test("a model that returns only text becomes one block, skips the coverage ratio and is still rejected when empty", async () => {
  const textOnly = openAiFileProvider(config({ model: "gpt-4o-transcribe" }))
  assert.equal(responseFormatFor("gpt-4o-mini-transcribe"), "json")
  const ok = service({ body: { text: "  全部的文字。 " } })
  const result = await transcribeFile(textOnly, audio, { speakers: true, post: ok.post })
  const { fields } = readForm(ok.requests[0])
  assert.deepEqual(fields, { model: ["gpt-4o-transcribe"], response_format: ["json"] }, "no timestamp_granularities for a model that does not take them")
  assert.deepEqual(result.utterances, [{ text: "全部的文字。", startMs: 0, endMs: 0 }])
  assert.equal(result.durationMs, 0)
  assert.doesNotThrow(() => assertCoverage(result))
  // The record renders as a single block with no duration.
  const md = renderInterviewRecord(result, { title: "t", source: "a.mp3", transcribedAt: "x", provider: "OpenAI 兼容接口", model: "gpt-4o-transcribe" }, false)
  assert.match(md, /`00:00:00`\n全部的文字。/)
  assert.doesNotMatch(md, /时长/)

  await assert.rejects(transcribeFile(textOnly, audio, { speakers: true, post: service({ body: { text: "   " } }).post }), /识别结果为空/)
  // A bare text body, as some local servers send, is read as the text.
  assert.equal((await transcribeFile(textOnly, audio, { speakers: false, post: service({ body: "纯文本回复" }).post })).utterances[0].text, "纯文本回复")
})

test("the diarizing model asks for speaker segments and the labels reach the result only when speakers were asked for", async () => {
  const body = { text: "a b", segments: [{ type: "transcript.text.segment", id: "s1", speaker: "A", start: 0, end: 2, text: "你好" }, { id: "s2", speaker: "B", start: 2, end: 5, text: "您好" }] }
  const provider = openAiFileProvider(config({ model: "gpt-4o-transcribe-diarize", language: "zh" }))
  assert.equal(provider.capabilities.diarization, true)
  const asked = service({ body })
  const labelled = await provider.transcribe(audio, { speakers: true, post: asked.post })
  assert.deepEqual(readForm(asked.requests[0]).fields, { model: ["gpt-4o-transcribe-diarize"], response_format: ["diarized_json"], chunking_strategy: ["auto"] })
  assert.deepEqual(labelled.utterances.map((u) => u.speaker), ["A", "B"])
  const plain = await provider.transcribe(audio, { speakers: false, post: service({ body }).post })
  assert.deepEqual(plain.utterances.map((u) => u.speaker), [undefined, undefined])
  assert.equal(openAiFileProvider(config()).capabilities.diarization, false)
})

test("gpt-transcribe gets no language hint, since it takes a languages array instead and the two must not be mixed", async () => {
  for (const [model, expected] of [["gpt-transcribe", false], ["GPT-Transcribe", false], ["gpt-4o-transcribe", true], ["whisper-1", true]] as const) {
    const sent = service({ body: { text: "文字" } })
    await openAiFileProvider(config({ model, language: "zh" })).transcribe(audio, { speakers: false, post: sent.post })
    const fields = readForm(sent.requests[0]).fields
    assert.equal("language" in fields, expected, model)
    assert.equal("languages" in fields, false, model)
  }
})

test("a server that refuses verbose_json is asked again for plain JSON, and other errors are not retried", async () => {
  const retry = service({ status: 400, body: { error: { message: "response_format verbose_json is not compatible with model" } } }, { body: { text: "文字" } })
  const result = await openAiFileProvider(config()).transcribe(audio, { speakers: false, post: retry.post })
  assert.deepEqual(retry.requests.map((r) => readForm(r).fields.response_format), [["verbose_json"], ["json"]])
  assert.equal(result.utterances[0].text, "文字")
  const boom = service({ status: 500, body: "oops" })
  await assert.rejects(openAiFileProvider(config()).transcribe(audio, { speakers: false, post: boom.post }), /HTTP 500/)
  assert.equal(boom.requests.length, 1)
  const stillBad = service({ status: 400, body: { error: { message: "bad file" } } })
  await assert.rejects(openAiFileProvider(config()).transcribe(audio, { speakers: false, post: stillBad.post }), /HTTP 400.*bad file/)
  assert.equal(stillBad.requests.length, 2)
})

test("errors say what to fix", () => {
  const err = (status: number, body: unknown = "") => errorOf({ status, headers: {}, text: typeof body === "string" ? body : JSON.stringify(body) }).message
  assert.match(err(401, { error: { message: "Incorrect API key provided" } }), /鉴权失败（HTTP 401）.*Incorrect API key provided/)
  assert.match(err(403), /鉴权失败/)
  assert.match(err(404, { error: { message: "model not found" } }), /接口不存在.*\/v1.*model not found/)
  assert.match(err(413), /文件大小上限/)
  assert.match(err(429, { error: "quota exceeded" }), /HTTP 429.*quota exceeded/)
  assert.match(err(502, "bad gateway"), /识别服务出错（HTTP 502）：bad gateway/)
  assert.match(err(400, { error: { message: "Unrecognized file format" } }), /识别请求被拒绝（HTTP 400）：Unrecognized file format/)
})

test("the transcription URL accepts a base with or without the path, and replies are parsed whatever their shape", () => {
  assert.equal(transcriptionsUrl("https://api.groq.com/openai/v1/"), "https://api.groq.com/openai/v1/audio/transcriptions")
  assert.equal(transcriptionsUrl("http://localhost:8000/v1/audio/transcriptions"), "http://localhost:8000/v1/audio/transcriptions")
  assert.deepEqual(parseTranscription('{"text":"x","segments":"nope"}', false).utterances, [{ text: "x", startMs: 0, endMs: 0 }])
  assert.equal(parseTranscription('{"text":"x","duration":"abc"}', false).durationMs, 0)
  assert.deepEqual(parseTranscription("[]", false).utterances, [])
  assert.equal(isLocalHost("localhost:11434"), true)
  assert.equal(isLocalHost("192.168.1.9:8000"), true)
  assert.equal(isLocalHost("api.openai.com"), false)
})

const secrets = (values: Record<string, string>) => ({ getSecret: (id: string) => values[id] ?? null })
const settings = (patch: (s: MeetingLiveSettings) => void) => {
  const { settings } = loadSettings(null)
  settings.fileProvider = "openai-compat"
  patch(settings)
  return settings
}

test("the provider resolves from settings: host, model, the user's size limit, language and what is missing", () => {
  const registered = asrProvider("openai-compat")!
  assert.equal(registered.live, undefined)
  const s = settings((x) => {
    x.providers.openaiCompat.baseUrl = " https://api.groq.com/openai/v1 "
    x.providers.openaiCompat.model = "whisper-large-v3-turbo"
    x.providers.openaiCompat.apiKeySecret = "groq-key"
    x.asrLanguage = "zh"
  })
  const file = resolveFile({ secrets: secrets({ "groq-key": " gk " }), settings: s })
  assert.equal(file.host, "api.groq.com")
  assert.equal(file.model, "whisper-large-v3-turbo")
  assert.equal(file.problem, undefined)
  assert.equal(file.capabilities.fileSizeLimit, 25 * 1024 * 1024)
  assert.equal(registered.file!.host(s), "api.groq.com")
  assert.deepEqual(registered.file!.capabilities(s), { language: true, diarization: false, fileSizeLimit: 25 * 1024 * 1024 })

  s.providers.openaiCompat.fileSizeLimitMb = 100
  assert.equal(resolveFile({ secrets: secrets({ "groq-key": "gk" }), settings: s }).capabilities.fileSizeLimit, 100 * 1024 * 1024)
  assert.equal(registered.file!.capabilities(s).fileSizeLimit, 100 * 1024 * 1024)

  assert.match(resolveFile({ secrets: secrets({}), settings: s }).problem ?? "", /API Key/)
  const local = settings((x) => {
    x.providers.openaiCompat.baseUrl = "http://localhost:8000/v1"
    x.providers.openaiCompat.model = "large-v3"
  })
  assert.equal(resolveFile({ secrets: secrets({}), settings: local }).problem, undefined)
  assert.match(resolveFile({ secrets: secrets({}), settings: settings((x) => (x.providers.openaiCompat.model = " ")) }).problem ?? "", /模型/)
  assert.match(resolveFile({ secrets: secrets({}), settings: settings((x) => (x.providers.openaiCompat.baseUrl = "")) }).problem ?? "", /API 地址/)
})

test("the generic language reaches the request, and auto sends none", async () => {
  const s = settings((x) => {
    x.providers.openaiCompat.baseUrl = "http://127.0.0.1:9/v1"
    x.asrLanguage = "en"
  })
  const sent = service({ body: { text: "hello", duration: 1, segments: [{ start: 0, end: 1, text: "hello" }] } })
  await transcribeFile(resolveFile({ secrets: secrets({}), settings: s }), audio, { speakers: false, post: sent.post })
  assert.deepEqual(readForm(sent.requests[0]).fields.language, ["en"])
  s.asrLanguage = "auto"
  const auto = service({ body: { text: "hello", duration: 1, segments: [{ start: 0, end: 1, text: "hello" }] } })
  await transcribeFile(resolveFile({ secrets: secrets({}), settings: s }), audio, { speakers: false, post: auto.post })
  assert.equal("language" in readForm(auto.requests[0]).fields, false)
})

test("old settings gain the new provider's defaults, and its stored values are read back", () => {
  assert.deepEqual(loadSettings({ version: 2, providers: { volc: {} } }).settings.providers.openaiCompat, { baseUrl: "https://api.openai.com/v1", model: "whisper-1", apiKeySecret: "", fileSizeLimitMb: 0 })
  const stored = loadSettings({ version: 2, providers: { openaiCompat: { baseUrl: "http://localhost:8000/v1", model: "large-v3", fileSizeLimitMb: 200, apiKeySecret: 5 } } }).settings.providers.openaiCompat
  assert.deepEqual(stored, { baseUrl: "http://localhost:8000/v1", model: "large-v3", apiKeySecret: "", fileSizeLimitMb: 200 })
})
