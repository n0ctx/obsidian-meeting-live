import assert from "node:assert/strict"
import { test } from "node:test"
import type { FileAsrGet, FileAsrPost, FileAsrResponse } from "../src/asr/fileAsr.ts"
import { dashScopeFileProvider, parseTranscript, submitBody, type DashScopeFileConfig } from "../src/asr/providers/dashscope/file.ts"
import { dashScopeFileConfig } from "../src/asr/providers/dashscope/settings.ts"
import { resolveFile } from "../src/asr/providers/registry.ts"
import { destinations } from "../src/consent.ts"
import type { PreparedAudio } from "../src/audio/transcode.ts"
import { loadSettings } from "../src/settings.ts"

const config = (patch: Partial<DashScopeFileConfig> = {}): DashScopeFileConfig => ({ baseUrl: "https://dashscope.aliyuncs.com", apiKey: "sk-1", model: "fun-asr", language: "zh", ...patch })
const audio = (n = 12): PreparedAudio => ({ data: new Uint8Array(n).fill(9), format: "ogg", transcoded: true, bytes: n })
const ok = (body: unknown, status = 200): FileAsrResponse => ({ status, headers: {}, text: JSON.stringify(body) })

const policy = { request_id: "r", data: { policy: "POLICY", signature: "SIG", upload_dir: "dashscope-instant/u/2026-11-08/d", upload_host: "https://oss.example.com", expire_in_seconds: 300, oss_access_key_id: "AK", x_oss_object_acl: "private", x_oss_forbid_overwrite: "true" } }
const transcript = { properties: { original_duration_in_milliseconds: 12_000 }, transcripts: [{ text: "你好。再见。", sentences: [{ begin_time: 100, end_time: 900, text: "你好。", speaker_id: 0 }, { begin_time: 1000, end_time: 1800, text: "再见。", speaker_id: 1 }] }] }
const succeeded = { output: { task_status: "SUCCEEDED", results: [{ subtask_status: "SUCCEEDED", transcription_url: "https://result.example.com/t.json" }] } }

interface Script {
  policy?: FileAsrResponse
  upload?: FileAsrResponse
  submit?: FileAsrResponse
  polls?: FileAsrResponse[]
  result?: FileAsrResponse
}

function flow(script: Script = {}) {
  const sent: { method: string; url: string; headers: Record<string, string>; body?: string | ArrayBuffer }[] = []
  const polls = [...(script.polls ?? [ok(succeeded)])]
  const post: FileAsrPost = async (url, headers, body) => {
    sent.push({ method: "POST", url, headers, body })
    if (url === "https://oss.example.com") return script.upload ?? { status: 200, headers: {}, text: "" }
    return script.submit ?? ok({ request_id: "r", output: { task_id: "task-1", task_status: "PENDING" } })
  }
  const get: FileAsrGet = async (url, headers) => {
    sent.push({ method: "GET", url, headers })
    if (url.includes("/uploads")) return script.policy ?? ok(policy)
    if (url.startsWith("https://result.example.com")) return script.result ?? ok(transcript)
    return polls.shift() ?? ok({ output: { task_status: "RUNNING" } })
  }
  return { sent, post, get }
}

test("the flow: credential, multipart upload with the file last, task with the oss address and both headers, polling, then the signed result", async () => {
  const { sent, post, get } = flow({ polls: [ok({ output: { task_status: "PENDING" } }), ok({ output: { task_status: "RUNNING" } }), ok(succeeded)] })
  const stages: string[] = []
  const result = await dashScopeFileProvider(config()).transcribe(audio(), { speakers: true, post, get, sleep: async () => undefined, onStage: (s) => stages.push(s.stage) })

  const [credential, upload, submit, ...rest] = sent
  assert.equal(credential.url, "https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=fun-asr")
  assert.equal(credential.headers.Authorization, "Bearer sk-1")
  assert.equal(upload.url, "https://oss.example.com")
  assert.match(upload.headers["Content-Type"], /^multipart\/form-data; boundary=/)
  const text = Buffer.from(upload.body as ArrayBuffer).toString("latin1")
  const names = [...text.matchAll(/; name="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(names, ["OSSAccessKeyId", "Signature", "policy", "x-oss-object-acl", "x-oss-forbid-overwrite", "key", "success_action_status", "file"])
  assert.match(text, /name="key"\r\n\r\ndashscope-instant\/u\/2026-11-08\/d\/audio\.ogg\r\n/)
  assert.match(text, /name="OSSAccessKeyId"\r\n\r\nAK\r\n/)

  assert.equal(submit.url, "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription")
  assert.equal(submit.headers["X-DashScope-Async"], "enable")
  assert.equal(submit.headers["X-DashScope-OssResourceResolve"], "enable")
  assert.deepEqual(JSON.parse(submit.body as string), { model: "fun-asr", input: { file_urls: ["oss://dashscope-instant/u/2026-11-08/d/audio.ogg"] }, parameters: { language_hints: ["zh"], diarization_enabled: true } })
  assert.deepEqual(rest.map((r) => r.url), [...Array(3).fill("https://dashscope.aliyuncs.com/api/v1/tasks/task-1"), "https://result.example.com/t.json"])
  assert.deepEqual(rest.at(-1)!.headers, {}, "the signed address takes no credentials")
  assert.equal(stages[0], "uploading")
  assert.ok(stages.includes("recognizing"))

  assert.equal(result.durationMs, 12_000)
  assert.deepEqual(result.utterances, [{ text: "你好。", startMs: 100, endMs: 900, speaker: "1" }, { text: "再见。", startMs: 1000, endMs: 1800, speaker: "2" }])
})

test("parameters are always sent, with no language and no diarization when neither is wanted; speakers appear only when asked for", () => {
  assert.deepEqual(submitBody("oss://x", config({ language: undefined }), false), { model: "fun-asr", input: { file_urls: ["oss://x"] }, parameters: {} })
  assert.equal(parseTranscript(transcript, false).utterances[0].speaker, undefined)
  assert.deepEqual(parseTranscript({ transcripts: [{ text: "只有文字" }] }, false).utterances, [{ text: "只有文字", startMs: 0, endMs: 0 }])
})

test("errors say what to fix: key, access, quota, a refused upload, a failed subtask, a missing field", async () => {
  const run = (script: Script) => {
    const { post, get } = flow(script)
    return dashScopeFileProvider(config()).transcribe(audio(), { speakers: false, post, get, sleep: async () => undefined })
  }
  await assert.rejects(run({ policy: ok({ code: "InvalidApiKey", message: "Invalid API-key provided." }, 401) }), /鉴权失败.*Invalid API-key provided/)
  await assert.rejects(run({ policy: ok({ code: "Arrearage", message: "Access denied, please make sure your account is in good standing." }, 403) }), /拒绝访问.*good standing/)
  await assert.rejects(run({ policy: ok({ message: "Throttling.RateQuota" }, 429) }), /429.*Throttling/)
  await assert.rejects(run({ policy: ok({ data: {} }) }), /没有返回临时存储的上传凭证/)
  await assert.rejects(run({ upload: { status: 403, headers: {}, text: "<Error><Code>AccessDenied</Code><Message>Policy expired</Message></Error>" } }), /上传到阿里云临时存储失败（HTTP 403）.*Policy expired/)
  await assert.rejects(run({ submit: ok({ code: "InvalidParameter", message: "file_urls is invalid" }, 400) }), /HTTP 400.*file_urls is invalid/)
  await assert.rejects(run({ submit: ok({ output: {} }) }), /没有返回识别任务编号/)
  await assert.rejects(run({ polls: [ok({ output: { task_status: "FAILED", code: "InvalidFile", message: "unsupported format" } })] }), /识别失败.*InvalidFile unsupported format/)
  await assert.rejects(run({ polls: [ok({ output: { task_status: "SUCCEEDED", results: [{ subtask_status: "FAILED", code: "FILE_DOWNLOAD_FAILED", message: "cannot read" }] } })] }), /识别失败.*FILE_DOWNLOAD_FAILED cannot read/)
  await assert.rejects(run({ polls: [ok({ output: { task_status: "SUCCEEDED", results: [{ subtask_status: "SUCCEEDED" }] } })] }), /没有返回识别结果的下载地址/)
  await assert.rejects(dashScopeFileProvider(config()).transcribe(audio(), { speakers: false, post: flow().post }), /不能向阿里云百炼查询/)
})

test("polling can be cancelled and gives up after the wait limit", async () => {
  const controller = new AbortController()
  const { post, get } = flow({ polls: Array(1000).fill(ok({ output: { task_status: "RUNNING" } })) })
  await assert.rejects(dashScopeFileProvider(config()).transcribe(audio(), { speakers: false, post, get, signal: controller.signal, sleep: async () => controller.abort() }), /已取消/)
  let slept = 0
  const again = flow({ polls: Array(1000).fill(ok({ output: { task_status: "RUNNING" } })) })
  await assert.rejects(dashScopeFileProvider(config()).transcribe(audio(), { speakers: false, post: again.post, get: again.get, sleep: async (ms) => void (slept += ms) }), /识别超时/)
  assert.ok(slept >= 30 * 60_000)
})

test("settings: the key and region are all that is needed; the host, limit and capabilities are the service's", () => {
  const { settings } = loadSettings(null)
  settings.fileProvider = "dashscope"
  settings.providers.dashscope.apiKeySecret = "ds"
  settings.asrLanguage = "ja"
  const secrets = (value: string | null) => ({ getSecret: () => value })
  assert.match(resolveFile({ secrets: secrets(null), settings }).problem ?? "", /API Key/)
  const file = resolveFile({ secrets: secrets(" sk-1 "), settings })
  assert.equal(file.problem, undefined)
  assert.equal(file.host, "dashscope.aliyuncs.com")
  assert.equal(file.model, "fun-asr")
  assert.deepEqual(file.capabilities, { language: true, diarization: true, fileSizeLimit: 1024 ** 3 })
  assert.equal(file.directFormats.mp3, "mp3")
  assert.deepEqual(destinations(settings).find((d) => d.kind === "file"), { kind: "file", name: "阿里云百炼", host: "dashscope.aliyuncs.com" })
  settings.providers.dashscope.region = "intl"
  assert.equal(destinations(settings).find((d) => d.kind === "file")?.host, "dashscope-intl.aliyuncs.com")
  assert.deepEqual(dashScopeFileConfig(secrets("k"), settings.providers.dashscope, "ja"), { baseUrl: "https://dashscope-intl.aliyuncs.com", apiKey: "k", model: "fun-asr", language: "ja" })
})
