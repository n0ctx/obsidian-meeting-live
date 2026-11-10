import { randomUUID } from "node:crypto"
import WebSocket, { type RawData } from "ws"
import { t } from "../../../i18n/index.ts"
import { AsrError, type AsrConnect, type AsrConnection } from "../../contract.ts"
import { volcResultSink } from "./normalize.ts"
import { decodeServerFrame, encodeAudio, encodeFullRequest } from "./protocol.ts"

export interface VolcConfig {
  endpoint: string
  resourceId: string
  /** New-console single key. When set, appId/accessToken are not used. */
  apiKey: string
  appId: string
  accessToken: string
  endWindowMs: number
  /** request.corpus (hotwords, scene, table ids), fixed when the recognizer is resolved: the protocol takes it in the first frame only. */
  corpus?: Record<string, unknown>
  /** Label speakers: the request asks for enable_speaker_info, and utterances then carry the speaker. */
  speakers?: boolean
}

const HANDSHAKE_TIMEOUT_MS = 10_000

export function volcConfigProblem(config: VolcConfig): string | undefined {
  if (!config.endpoint.trim()) return t("volc.noEndpoint")
  if (!config.resourceId.trim()) return t("volc.noResource")
  if (!config.apiKey && !(config.appId && config.accessToken)) return t("volc.noCredentials")
  return undefined
}

export function buildVolcRequest(config: VolcConfig): Record<string, unknown> {
  const request: Record<string, unknown> = {
    model_name: "bigmodel",
    enable_itn: true,
    enable_punc: true,
    enable_ddc: false,
    show_utterances: true,
    result_type: "single",
    end_window_size: config.endWindowMs,
  }
  // The streaming speaker-separation page lists exactly these two flags (show_utterances is already on); results then carry speaker_id.
  //   https://www.volcengine.com/docs/6561/2699972  (大模型ASR-说话人分离最佳实践: 流式大模型 SSD)
  if (config.speakers) request.enable_speaker_info = true
  if (/bigmodel_async\/?$/.test(config.endpoint.trim())) request.enable_nonstream = true
  if (config.corpus) request.corpus = config.corpus
  return {
    user: { uid: "obsidian-meeting-live" },
    audio: { format: "pcm", codec: "raw", rate: 16000, bits: 16, channel: 1 },
    request,
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

function isFatalCode(code: number): boolean {
  return code === 45000001 || code === 45000151
}

export function volcConnector(config: VolcConfig): AsrConnect {
  return (handlers) =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        "X-Api-Resource-Id": config.resourceId.trim(),
        "X-Api-Connect-Id": randomUUID(),
      }
      if (config.apiKey) headers["X-Api-Key"] = config.apiKey
      else {
        headers["X-Api-App-Key"] = config.appId
        headers["X-Api-Access-Key"] = config.accessToken
      }
      const socket = new WebSocket(config.endpoint.trim(), { headers, handshakeTimeout: HANDSHAKE_TIMEOUT_MS })
      let logId: string | undefined
      let ready = false
      let closedLocally = false
      let finished = false
      const feed = volcResultSink(handlers)

      const fail = (error: AsrError) => {
        if (finished) return
        finished = true
        if (ready) handlers.onClose(error)
        else reject(error)
        socket.terminate()
      }
      const timer = window.setTimeout(() => fail(new AsrError(t("volc.timeout"), false)), HANDSHAKE_TIMEOUT_MS + 5000)

      socket.on("upgrade", (response) => {
        const value = response.headers["x-tt-logid"]
        logId = Array.isArray(value) ? value[0] : value
      })
      socket.on("unexpected-response", (_request, response) => {
        const status = response.statusCode ?? 0
        let body = ""
        response.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")))
        response.on("end", () => {
          const fatal = status === 401 || status === 403 || status === 400
          fail(new AsrError(t("volc.refused", status, fatal, body.slice(0, 200)), fatal))
        })
      })
      socket.on("open", () => socket.send(encodeFullRequest(buildVolcRequest(config)), { binary: true }))
      socket.on("message", (data, isBinary) => {
        if (!isBinary) return
        let frame
        try {
          frame = decodeServerFrame(toBuffer(data))
        } catch (error) {
          fail(new AsrError((error as Error).message, false))
          return
        }
        if (frame.kind === "error") {
          fail(new AsrError(t("volc.asrError", frame.code, frame.message), isFatalCode(frame.code)))
          return
        }
        if (!ready) {
          ready = true
          window.clearTimeout(timer)
          const connection: AsrConnection = {
            sendAudio(pcm, last) {
              if (socket.readyState !== WebSocket.OPEN) throw new AsrError(t("volc.socketClosed"), false)
              socket.send(encodeAudio(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), last), { binary: true })
            },
            close() {
              closedLocally = true
              finished = true
              if (socket.readyState === WebSocket.OPEN) socket.close()
              else socket.terminate()
            },
          }
          resolve({ connection, logId })
          return
        }
        feed(frame.data, frame.last)
      })
      socket.on("error", (error) => fail(new AsrError(t("asr.network", error.message), false)))
      socket.on("close", (code) => {
        window.clearTimeout(timer)
        if (!closedLocally) fail(new AsrError(t("volc.closed", code), false))
      })
    })
}

export type HandshakeResult =
  /** The server accepted the connection (HTTP 101). */
  | { ok: true; logId?: string }
  /** The server answered the upgrade with an HTTP error, which says whether the key or the resource was refused. */
  | { ok: false; status: number; body: string }
  /** No connection could be made. */
  | { ok: false; status: 0; body: string }

/**
 * Opens the stream's socket with the credentials and the resource id, and closes it at once without sending the request or any audio.
 * Whether the account may use the resource is decided in the upgrade: 101 when it may, 403 `requested resource not granted` when it may not
 * (https://github.com/Open-Less/openless/issues/1071; the official pages document no status for it). Volcengine bills by audio duration
 * (https://docs.volcengine.com/docs/6561/1359370), and nothing is sent here, though it does not say in so many words that a bare connection is free.
 */
export function volcHandshake(config: VolcConfig): Promise<HandshakeResult> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { "X-Api-Resource-Id": config.resourceId.trim(), "X-Api-Connect-Id": randomUUID() }
    if (config.apiKey) headers["X-Api-Key"] = config.apiKey
    else {
      headers["X-Api-App-Key"] = config.appId
      headers["X-Api-Access-Key"] = config.accessToken
    }
    let socket: WebSocket
    try {
      socket = new WebSocket(config.endpoint.trim(), { headers, handshakeTimeout: HANDSHAKE_TIMEOUT_MS })
    } catch (error) {
      return resolve({ ok: false, status: 0, body: (error as Error).message })
    }
    let logId: string | undefined
    let settled = false
    const done = (result: HandshakeResult) => {
      if (settled) return
      settled = true
      socket.terminate()
      resolve(result)
    }
    socket.on("upgrade", (response) => {
      const value = response.headers["x-tt-logid"]
      logId = Array.isArray(value) ? value[0] : value
    })
    socket.on("unexpected-response", (_request, response) => {
      let body = ""
      response.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")))
      response.on("end", () => done({ ok: false, status: response.statusCode ?? 0, body: body.trim().slice(0, 200) }))
    })
    socket.on("open", () => done({ ok: true, logId }))
    socket.on("error", (error) => done({ ok: false, status: 0, body: error.message }))
  })
}
