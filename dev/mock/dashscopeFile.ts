// DashScope recorded-file recognition as documented: a temporary-storage upload credential, a multipart POST to the storage host
// (the file as the last field), a task submitted with X-DashScope-Async and the oss:// address, polled until it succeeds, and the
// transcript fetched from the signed address the task returns. The key "bad" is refused with 401.
//   https://www.alibabacloud.com/help/en/model-studio/get-temporary-file-url
//   https://www.alibabacloud.com/help/en/model-studio/fun-asr-recorded-speech-recognition-http-api
import type { IncomingMessage, ServerResponse } from "node:http"
import { SENTENCES, SENTENCE_MS, readBody, reply } from "./shared.ts"

interface Task {
  bytes: number
  speakers: boolean
  polls: number
}

const stored = new Map<string, number>()
const tasks = new Map<string, Task>()

/** The field names of a multipart body in the order they appear, and the size of the file part. */
function multipartOrder(body: Buffer): { names: string[]; fileBytes: number } {
  const text = body.toString("latin1")
  const names = [...text.matchAll(/Content-Disposition: form-data; name="([^"]+)"/g)].map((m) => m[1])
  const head = text.indexOf('name="file"')
  const start = text.indexOf("\r\n\r\n", head) + 4
  const end = text.lastIndexOf("\r\n--")
  return { names, fileBytes: head < 0 ? 0 : end - start }
}

/** True when the request was one of the DashScope file routes. `origin` is where this server can be reached. */
export async function dashscopeFileRoutes(req: IncomingMessage, res: ServerResponse, origin: string): Promise<boolean> {
  const url = new URL(req.url ?? "", origin)
  const path = url.pathname
  if (!path.startsWith("/api/v1/") && !path.startsWith("/oss-upload") && !path.startsWith("/dashscope-result/")) return false
  const body = await readBody(req)
  const refused = (payload: object = { code: "InvalidApiKey", message: "Invalid API-key provided." }) => (reply(res, 401, payload), true)
  const authorized = /^Bearer \S+$/.test(req.headers.authorization ?? "") && req.headers.authorization !== "Bearer bad"
  if (path === "/api/v1/uploads" && req.method === "GET") {
    if (!authorized) return refused()
    if (url.searchParams.get("action") !== "getPolicy" || !url.searchParams.get("model")) return reply(res, 400, { code: "InvalidParameter", message: "action and model are required" }), true
    return reply(res, 200, { request_id: "mock", data: { policy: "p", signature: "s", upload_dir: "dashscope-instant/mock/2026-11-08/dir", upload_host: `${origin}/oss-upload`, expire_in_seconds: 300, max_file_size_mb: 1024, capacity_limit_mb: 999999, oss_access_key_id: "ak", x_oss_object_acl: "private", x_oss_forbid_overwrite: "true" } }), true
  }
  if (path === "/oss-upload" && req.method === "POST") {
    const { names, fileBytes } = multipartOrder(body)
    const need = ["OSSAccessKeyId", "Signature", "policy", "x-oss-object-acl", "x-oss-forbid-overwrite", "key", "file"]
    if (names.at(-1) !== "file" || need.some((n) => !names.includes(n))) return reply(res, 400, { code: "InvalidArgument", message: "the file must be the last field, after the credential fields" }), true
    const key = /name="key"\r\n\r\n([^\r]+)/.exec(body.toString("latin1"))?.[1] ?? ""
    stored.set(`oss://${key}`, fileBytes)
    res.statusCode = 200
    res.end()
    return true
  }
  if (path === "/api/v1/services/audio/asr/transcription" && req.method === "POST") {
    if (!authorized) return refused()
    if (req.headers["x-dashscope-async"] !== "enable") return reply(res, 403, { code: "AccessDenied", message: "current user api does not support synchronous calls" }), true
    const request = JSON.parse(body.toString() || "{}") as { model?: string; input?: { file_urls?: string[] }; parameters?: { diarization_enabled?: boolean } }
    if (!request.parameters) return reply(res, 200, { output: { task_id: "no-parameters", task_status: "PENDING" } }), true
    const fileUrl = request.input?.file_urls?.[0] ?? ""
    if (req.headers["x-dashscope-ossresourceresolve"] !== "enable" && fileUrl.startsWith("oss://")) return reply(res, 400, { code: "InvalidParameter", message: "the oss:// address cannot be resolved without X-DashScope-OssResourceResolve" }), true
    const bytes = stored.get(fileUrl)
    if (bytes === undefined) return reply(res, 400, { code: "InvalidParameter", message: "file_urls: no such file" }), true
    const id = `task${tasks.size + 1}`
    tasks.set(id, { bytes, speakers: request.parameters.diarization_enabled === true, polls: 0 })
    return reply(res, 200, { request_id: "mock", output: { task_id: id, task_status: "PENDING" } }), true
  }
  const polled = /^\/api\/v1\/tasks\/(\w+)$/.exec(path)
  if (polled && req.method === "GET") {
    if (!authorized) return refused()
    const task = tasks.get(polled[1])
    if (!task) return reply(res, 404, { code: "InvalidParameter", message: "task not found" }), true
    task.polls++
    if (task.bytes === 0) return reply(res, 200, { output: { task_id: polled[1], task_status: "SUCCEEDED", results: [{ file_url: "x", subtask_status: "FAILED", code: "FILE_DOWNLOAD_FAILED", message: "The audio file is empty" }] } }), true
    if (task.polls < 3) return reply(res, 200, { output: { task_id: polled[1], task_status: task.polls === 1 ? "PENDING" : "RUNNING" } }), true
    return reply(res, 200, { output: { task_id: polled[1], task_status: "SUCCEEDED", results: [{ file_url: "x", subtask_status: "SUCCEEDED", transcription_url: `${origin}/dashscope-result/${polled[1]}.json` }] } }), true
  }
  const result = /^\/dashscope-result\/(\w+)\.json$/.exec(path)
  if (result && req.method === "GET") {
    const task = tasks.get(result[1])
    if (!task) return reply(res, 404, { message: "expired" }), true
    const duration = Math.max(8, Math.round(task.bytes / 4000)) * 1000
    const sentences = Array.from({ length: Math.ceil(duration / SENTENCE_MS) }, (_, i) => ({ begin_time: i * SENTENCE_MS, end_time: Math.min(duration, (i + 1) * SENTENCE_MS), text: SENTENCES[i % SENTENCES.length], sentence_id: i + 1, ...(task.speakers ? { speaker_id: i % 2 } : {}), words: [] }))
    return reply(res, 200, { file_url: "x", properties: { audio_format: "pcm_s16le", channels: [0], original_sampling_rate: 16000, original_duration_in_milliseconds: duration }, transcripts: [{ channel_id: 0, content_duration_in_milliseconds: duration, text: sentences.map((s) => s.text).join(""), sentences }] }), true
  }
  return false
}
