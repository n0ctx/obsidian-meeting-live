import assert from "node:assert/strict"
import { test } from "node:test"
import type { FileAsrPost } from "../src/asr/fileAsr.ts"
import { resolveFile } from "../src/asr/providers/registry.ts"
import { WHISPER_LOCAL_FILE_LIMIT } from "../src/asr/providers/whisperLocal/info.ts"
import { destinations } from "../src/consent.ts"
import { loadSettings } from "../src/settings.ts"

const noSecrets = { getSecret: () => null }
const audio = { data: new Uint8Array([1, 2, 3]), format: "ogg", transcoded: false, bytes: 3 }

test("picking Local needs no address, key or limit: the default points at whisper-server on this machine", () => {
  const { settings } = loadSettings({ fileProvider: "whisper-local" })
  const file = resolveFile({ secrets: noSecrets, settings })
  assert.deepEqual([file.id, file.name, file.host, file.model, file.problem], ["whisper-local", "本地 Whisper（whisper.cpp）", "127.0.0.1:8080", "whisper", undefined])
  assert.equal(file.capabilities.fileSizeLimit, WHISPER_LOCAL_FILE_LIMIT)
  assert.ok(WHISPER_LOCAL_FILE_LIMIT > 25 * 1024 * 1024, "a local server does not need recordings recompressed to fit OpenAI's cap")
  assert.equal(file.capabilities.diarization, false)
  assert.equal(file.directFormats.ogg, "ogg")
})

test("it requests <address>/audio/transcriptions with the language, no Authorization header, and reads timed segments", async () => {
  const { settings } = loadSettings({ fileProvider: "whisper-local", asrLanguage: "zh" })
  const requests: { url: string; headers: Record<string, string>; body: string }[] = []
  const post: FileAsrPost = async (url, headers, body) => {
    requests.push({ url, headers, body: Buffer.from(body as ArrayBuffer).toString("latin1") })
    return { status: 200, headers: {}, text: JSON.stringify({ duration: 3.2, text: "你好世界", segments: [{ start: 0, end: 3.2, text: "你好世界" }] }) }
  }
  const file = resolveFile({ secrets: noSecrets, settings })
  const result = await file.transcribe(audio, { speakers: false, post })
  assert.equal(requests[0].url, "http://127.0.0.1:8080/v1/audio/transcriptions")
  assert.equal(requests[0].headers.Authorization, undefined)
  assert.match(requests[0].body, /name="language"\r\n\r\nzh\r\n/)
  assert.match(requests[0].body, /name="response_format"\r\n\r\nverbose_json\r\n/)
  assert.deepEqual(result.utterances, [{ text: "你好世界", startMs: 0, endMs: 3200, speaker: undefined }])
})

test("a server address and model that the user changed are kept, and a bad address is reported", () => {
  const { settings } = loadSettings({ version: 2, providers: { whisperLocal: { baseUrl: " http://127.0.0.1:9000/v1 ", model: "Systran/faster-whisper-small" } } })
  settings.fileProvider = "whisper-local"
  const file = resolveFile({ secrets: noSecrets, settings })
  assert.deepEqual([file.host, file.model], ["127.0.0.1:9000", "Systran/faster-whisper-small"])
  settings.providers.whisperLocal.baseUrl = "not a url"
  assert.match(resolveFile({ secrets: noSecrets, settings }).problem ?? "", /./)
})

test("the recording's destination is listed as on this machine, and a server on another host is not", () => {
  const { settings } = loadSettings({ fileProvider: "whisper-local" })
  assert.deepEqual(destinations(settings).find((d) => d.kind === "file"), { kind: "file", name: "本地 Whisper（whisper.cpp）", host: "127.0.0.1:8080", local: true })
  settings.providers.whisperLocal.baseUrl = "http://192.168.1.9:8080/v1"
  assert.equal(destinations(settings).find((d) => d.kind === "file")?.local, undefined)
})

test("existing settings are unchanged by the new provider: the same file and live providers, and a default section", () => {
  const { settings } = loadSettings({ version: 2, liveProvider: "volc", fileProvider: "volc", providers: { openaiCompat: { baseUrl: "https://api.groq.com/openai/v1" } } })
  assert.deepEqual([settings.liveProvider, settings.fileProvider, settings.providers.openaiCompat.baseUrl], ["volc", "volc", "https://api.groq.com/openai/v1"])
  assert.deepEqual(settings.providers.whisperLocal, { baseUrl: "http://127.0.0.1:8080/v1", model: "whisper" })
})
