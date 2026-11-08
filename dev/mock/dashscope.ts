// DashScope realtime recognition as documented (run-task, task-started, binary PCM, result-generated, finish-task, task-finished):
// https://www.alibabacloud.com/help/en/model-studio/qwen-audio-asr-streaming-client-events
// https://www.alibabacloud.com/help/en/model-studio/qwen-audio-asr-streaming-server-events
// Times are milliseconds from the first sample of the task. An open sentence has end_time null; a finished one carries it.
import type { WebSocket } from "ws"
import { SENTENCES, SENTENCE_MS, stats } from "./shared.ts"

export const DASHSCOPE_PATH = "/api-ws/v1/inference"

export function dashscopeSession(ws: WebSocket): void {
  stats.dashscopeConnections++
  let taskId = ""
  let started = false
  let receivedMs = 0
  let sentenceId = 1
  let index = Math.floor(Math.random() * SENTENCES.length)
  let sentenceStart = 0
  const event = (name: string, header: Record<string, unknown> = {}, payload: unknown = {}) => ws.send(JSON.stringify({ header: { task_id: taskId, event: name, attributes: {}, ...header }, payload }))
  const sentence = (text: string, end: number | null, final: boolean) =>
    event("result-generated", {}, { output: { sentence: { sentence_id: sentenceId, begin_time: Math.round(sentenceStart), end_time: end === null ? null : Math.round(end), text, heartbeat: false, sentence_begin: false, sentence_end: final, words: [] } }, usage: final ? { duration: Math.ceil(receivedMs / 1000) } : null })
  const partial = () => {
    const text = SENTENCES[index % SENTENCES.length]
    return text.slice(0, Math.max(1, Math.floor((text.length * (receivedMs - sentenceStart)) / SENTENCE_MS)))
  }
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      const message = JSON.parse(data.toString()) as { header?: { action?: string; task_id?: string }; payload?: { parameters?: { format?: string; sample_rate?: number } } }
      if (message.header?.action === "run-task") {
        taskId = message.header.task_id ?? ""
        const parameters = message.payload?.parameters
        if (parameters?.format !== "pcm" || parameters.sample_rate !== 16000) return event("task-failed", { error_code: "InvalidParameter", error_message: "format or sample_rate missing" })
        started = true
        event("task-started")
      } else if (message.header?.action === "finish-task") {
        stats.dashscopeFinishTasks++
        if (receivedMs > sentenceStart) sentence(partial(), receivedMs, true)
        event("task-finished", {}, { output: {}, usage: null })
        ws.close(1000)
      }
      return
    }
    if (!started) return event("task-failed", { error_code: "CLIENT_ERROR", error_message: "audio before task-started" })
    receivedMs += (data.length / 2 / 16000) * 1000
    if (receivedMs - sentenceStart >= SENTENCE_MS) {
      sentence(SENTENCES[index % SENTENCES.length], receivedMs, true)
      index++
      sentenceId++
      sentenceStart = receivedMs
    } else sentence(partial(), null, false)
  })
  ws.on("error", () => undefined)
}
