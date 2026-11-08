// DashScope (Alibaba Cloud Bailian) realtime recognition over WebSocket: JSON task messages and raw 16 kHz mono PCM16 up,
// JSON events down.
//   https://www.alibabacloud.com/help/en/model-studio/qwen-audio-asr-streaming-client-events  (run-task and finish-task, parameters, inline hotwords)
//   https://www.alibabacloud.com/help/en/model-studio/fun-asr-client-events  (the same messages for Fun-ASR; language_hints takes the first value only)
//   https://www.alibabacloud.com/help/en/model-studio/real-time-speech-recognition-user-guide  (audio is sent as 100 ms packets; the examples wait for task-started)
//   https://www.alibabacloud.com/help/en/model-studio/error-code  (error code strings)
// Flow: connect with `Authorization: Bearer <key>`, send run-task, wait for task-started, stream binary audio, send finish-task,
// read results until task-finished.
import { randomUUID } from "node:crypto"
import { t } from "../../../i18n/index.ts"
import { hostOf } from "../../../url.ts"
import { AsrError, SentAudioClock, type AsrConnect, type AsrConnection } from "../../contract.ts"
import { takesInlineHotwords } from "./info.ts"
import { parseDashScopeMessage } from "./normalize.ts"
import { frameText, openSocket, SocketLifecycle } from "../wsSocket.ts"

export interface DashScopeConfig {
  endpoint: string
  apiKey: string
  model: string
  /** ISO 639-1 code, or undefined to let the service detect the language. */
  language: string | undefined
  hotwords: string[]
}

/** Weight of an inline hotword: the documentation allows 1-5 (50 for a "super" word). */
const HOTWORD_WEIGHT = 4
/** The documentation caps a hotword list (inline plus pre-created) at 2000; a meeting's own list stays far below. */
const MAX_HOTWORDS = 200

export function dashScopeConfigProblem(config: DashScopeConfig): string | undefined {
  if (!config.apiKey) return t("dashscope.noKey")
  if (!config.model.trim()) return t("dashscope.noModel")
  if (!hostOf(config.endpoint.replace(/^ws/, "http"))) return t("dashscope.badEndpoint")
  return undefined
}

/** The run-task message: PCM16 at 16 kHz, with the language hint and hotwords where the model takes them. */
export function runTaskMessage(config: DashScopeConfig, taskId: string): Record<string, unknown> {
  const parameters: Record<string, unknown> = { format: "pcm", sample_rate: 16000, heartbeat: true }
  if (config.language) parameters.language_hints = [config.language]
  const words = config.hotwords.map((w) => w.trim()).filter(Boolean).slice(0, MAX_HOTWORDS)
  if (words.length && takesInlineHotwords(config.model)) parameters.vocabulary = Object.fromEntries(words.map((w) => [w, HOTWORD_WEIGHT]))
  return {
    header: { action: "run-task", task_id: taskId, streaming: "duplex" },
    payload: { task_group: "audio", task: "asr", function: "recognition", model: config.model.trim(), parameters, input: {} },
  }
}

export const finishTaskMessage = (taskId: string): Record<string, unknown> => ({ header: { action: "finish-task", task_id: taskId, streaming: "duplex" }, payload: { input: {} } })

const detail = (body: string): string => {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; code?: unknown }
    if (typeof parsed.message === "string" && parsed.message) return parsed.message
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return body.slice(0, 200)
}

/** A refused handshake: credentials and parameters are the user's to fix, anything else is worth another try. */
function upgradeError(status: number, body: string): AsrError {
  const why = detail(body)
  if (status === 401) return new AsrError(t("dashscope.auth", why), true)
  if (status === 403) return new AsrError(t("dashscope.forbidden", why), true)
  if (status === 400 || status === 404) return new AsrError(t("dashscope.badRequest", status, why), true)
  return new AsrError(t("dashscope.refused", status, why), false)
}

/** Error code strings from the error-code page that retrying cannot fix: key, balance, access, model and parameters. */
const FATAL_CODE = /InvalidApiKey|invalid_api_key|NOT AUTHORIZED|Arrearage|OUT_OF_SERVICE|AccessDenied|access_denied|ModelNotFound|model_not_found|InvalidParameter|BadRequest|Unpurchased/i

export function taskFailedError(code: string, message: string): AsrError {
  const text = t("dashscope.taskFailed", code, message)
  return new AsrError(text, FATAL_CODE.test(code) || FATAL_CODE.test(message))
}

export function dashScopeConnector(config: DashScopeConfig): AsrConnect {
  return async (handlers) => {
    const socket = await openSocket(config.endpoint.trim(), { Authorization: `Bearer ${config.apiKey}` }, upgradeError, () => new AsrError(t("dashscope.timeout"), false))
    const taskId = randomUUID()
    const clock = new SentAudioClock()
    return new Promise((resolve, reject) => {
      let ready = false
      let endRequested = false
      let endAnnounced = false
      const startTimer = window.setTimeout(() => life.fail(new AsrError(t("dashscope.timeout"), false)), 15_000)
      const life = new SocketLifecycle(
        socket,
        (error) => (ready ? handlers.onClose(error) : reject(error)),
        () => window.clearTimeout(startTimer),
      )
      /** Tells the streamer every result has arrived, once, whichever of task-finished and the close comes first. */
      const announceEnd = () => {
        if (endAnnounced) return
        endAnnounced = true
        handlers.onResult({ utterances: [], keepInterims: true }, true)
      }
      const connection: AsrConnection = {
        sendAudio(pcm, last) {
          if (socket.readyState !== socket.OPEN) throw new AsrError(t("dashscope.socketClosed"), false)
          if (pcm.length > 0) {
            socket.send(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
            clock.advance(pcm.length)
          }
          if (last) {
            endRequested = true
            socket.send(JSON.stringify(finishTaskMessage(taskId)))
          }
        },
        close: () => life.closeLocally(),
      }

      socket.on("message", (data, isBinary) => {
        if (isBinary || life.finished) return
        const event = parseDashScopeMessage(frameText(data), clock.ms)
        switch (event.kind) {
          case "started":
            if (ready) return
            ready = true
            window.clearTimeout(startTimer)
            resolve({ connection })
            break
          case "result":
            if (ready) handlers.onResult(event.update, false)
            break
          case "finished":
            announceEnd()
            life.complete()
            break
          case "failed":
            life.fail(taskFailedError(event.code, event.message))
            break
        }
      })
      socket.on("error", (error) => life.fail(new AsrError(t("asr.network", error.message), false)))
      socket.on("close", (code) => {
        if (life.finished) return
        if (endRequested) {
          // A close after finish-task, before task-finished: the results sent so far are all there will be.
          announceEnd()
          life.complete()
          return
        }
        life.fail(new AsrError(t("dashscope.closed", code), false))
      })
      socket.send(JSON.stringify(runTaskMessage(config, taskId)))
    })
  }
}
