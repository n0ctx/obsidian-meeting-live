import { randomUUID } from "node:crypto"
import WebSocket, { type RawData } from "ws"
import { AsrError, type AsrConnect, type AsrConnection } from "./streamer.ts"
import { decodeServerFrame, encodeAudio, encodeFullRequest } from "./volcProtocol.ts"

export interface VolcConfig {
  endpoint: string
  resourceId: string
  /** New-console single key. When set, appId/accessToken are not used. */
  apiKey: string
  appId: string
  accessToken: string
  endWindowMs: number
  hotwords: string[]
}

const HANDSHAKE_TIMEOUT_MS = 10_000

export function volcConfigProblem(config: VolcConfig): string | undefined {
  if (!config.endpoint.trim()) return "未填写火山引擎 WebSocket 地址"
  if (!config.resourceId.trim()) return "未填写火山引擎 Resource ID"
  if (!config.apiKey && !(config.appId && config.accessToken)) return "未配置火山引擎凭证（API Key，或 App ID + Access Token）"
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
  if (/bigmodel_async\/?$/.test(config.endpoint.trim())) request.enable_nonstream = true
  const hotwords = config.hotwords.map((w) => w.trim()).filter(Boolean).slice(0, 100)
  if (hotwords.length) request.corpus = { context: JSON.stringify({ hotwords: hotwords.map((word) => ({ word })) }) }
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

      const fail = (error: AsrError) => {
        if (finished) return
        finished = true
        if (ready) handlers.onClose(error)
        else reject(error)
        socket.terminate()
      }
      const timer = window.setTimeout(() => fail(new AsrError("连接火山引擎超时", false)), HANDSHAKE_TIMEOUT_MS + 5000)

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
          const hint = fatal ? "，请检查凭证与 Resource ID 是否匹配" : ""
          fail(new AsrError(`火山引擎拒绝连接（HTTP ${status}${hint}）${body ? `：${body.slice(0, 200)}` : ""}`, fatal))
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
          fail(new AsrError(`火山引擎 ASR 错误 ${frame.code}：${frame.message}`, isFatalCode(frame.code)))
          return
        }
        if (!ready) {
          ready = true
          window.clearTimeout(timer)
          const connection: AsrConnection = {
            sendAudio(pcm, last) {
              if (socket.readyState !== WebSocket.OPEN) throw new AsrError("火山引擎连接已关闭", false)
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
        handlers.onResult(frame.data, frame.last)
      })
      socket.on("error", (error) => fail(new AsrError(`网络错误：${error.message}`, false)))
      socket.on("close", (code) => {
        window.clearTimeout(timer)
        if (!closedLocally) fail(new AsrError(`火山引擎连接断开（${code}）`, false))
      })
    })
}
