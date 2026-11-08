// Deepgram live transcription over WebSocket: raw 16 kHz mono PCM16 up, JSON results down.
//   https://developers.deepgram.com/reference/speech-to-text/listen-streaming  (URL, query parameters, messages)
//   https://developers.deepgram.com/guides/fundamentals/authenticating  (Authorization: Token <key>)
//   https://developers.deepgram.com/docs/audio-keep-alive  (KeepAlive as a text frame every 3-5 s; 10 s without audio or KeepAlive closes the socket)
//   https://developers.deepgram.com/docs/close-stream  (CloseStream: remaining finals, a Metadata message, then the server closes)
//   https://developers.deepgram.com/docs/stt-troubleshooting-websocket-data-and-net-errors  (close codes; never send an empty frame)
import WebSocket, { type RawData } from "ws"
import { t } from "../../../i18n/index.ts"
import { AsrError, type AsrConnect, type AsrConnection } from "../../contract.ts"
import { isLocalHost, hostOf } from "../../../url.ts"
import { parseDeepgramMessage } from "./normalize.ts"

export interface DeepgramConfig {
  endpoint: string
  /** Sent as `Authorization: Token <key>`. */
  apiKey: string
  model: string
  /** Language code, or `multi`. */
  language: string
  diarize: boolean
}

export interface DeepgramTuning {
  /** Longest the socket may go without a frame from us before a KeepAlive is sent. */
  keepAliveMs?: number
}

const HANDSHAKE_TIMEOUT_MS = 10_000
/** Well inside the 10 s the server waits, and the 3-5 s the documentation recommends. */
const KEEP_ALIVE_MS = 3000
/** Silence that ends an utterance. The documentation suggests 300-500 ms for people who pause mid-thought. */
const ENDPOINTING_MS = 300

export function deepgramConfigProblem(config: DeepgramConfig): string | undefined {
  if (!config.endpoint.trim()) return t("deepgram.noEndpoint")
  const host = hostOf(config.endpoint.replace(/^ws/, "http"))
  if (!host) return t("deepgram.badEndpoint")
  if (!config.model.trim()) return t("deepgram.noModel")
  if (!config.apiKey && !isLocalHost(host)) return t("deepgram.noKey")
  return undefined
}

/** The endpoint with the stream's parameters: raw PCM16 at 16 kHz mono, interim results and endpointing on. */
export function deepgramUrl(config: DeepgramConfig): string {
  const url = new URL(config.endpoint.trim())
  const params: Record<string, string> = {
    model: config.model.trim(),
    language: config.language,
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "true",
    endpointing: String(ENDPOINTING_MS),
    smart_format: "true",
  }
  if (config.diarize) params.diarize = "true"
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

const text = (data: RawData): string => (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString("utf8")

/** Errors the user has to fix: retrying a bad key, a model the project cannot use or a rejected parameter only repeats them. */
function upgradeError(status: number, body: string): AsrError {
  const detail = body.slice(0, 200)
  switch (status) {
    case 401:
      return new AsrError(t("deepgram.auth", detail), true)
    case 402:
      return new AsrError(t("deepgram.balance", detail), true)
    case 403:
      return new AsrError(t("deepgram.forbidden", detail), true)
    case 400:
      return new AsrError(t("deepgram.badParams", detail), true)
    default:
      return new AsrError(t("deepgram.refused", status, detail), false)
  }
}

/**
 * Close code 1008 is DATA-0000: the server could not read what we sent as audio, which retrying will not change.
 * Everything else (1011 NET-0000/0001/0002 timeouts, a dropped network) is worth another try.
 */
function closeError(code: number, reason: string): AsrError {
  return new AsrError(t("deepgram.closed", code, reason), code === 1008)
}

/** An `Error` message names a variant; schema and permission problems come from our own request and cannot be retried away. */
const FATAL_VARIANT = /schema|auth|permission|forbidden/i

export function deepgramConnector(config: DeepgramConfig, tuning: DeepgramTuning = {}): AsrConnect {
  const keepAliveMs = tuning.keepAliveMs ?? KEEP_ALIVE_MS
  return (handlers) =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = {}
      if (config.apiKey) headers.Authorization = `Token ${config.apiKey}`
      const socket = new WebSocket(deepgramUrl(config), { headers, handshakeTimeout: HANDSHAKE_TIMEOUT_MS })
      let logId: string | undefined
      let ready = false
      let finished = false
      let closedLocally = false
      let endRequested = false
      let endAnnounced = false
      let lastSentAt = Date.now()
      let keepAlive: number | undefined

      const stopKeepAlive = () => {
        if (keepAlive) window.clearInterval(keepAlive)
        keepAlive = undefined
      }
      const fail = (error: AsrError) => {
        if (finished) return
        finished = true
        stopKeepAlive()
        window.clearTimeout(timer)
        if (ready) handlers.onClose(error)
        else reject(error)
        socket.terminate()
      }
      /** Tells the streamer every final has arrived. Once, whichever of the closing summary and the close comes first. */
      const announceEnd = () => {
        if (endAnnounced) return
        endAnnounced = true
        handlers.onResult({ utterances: [], keepInterims: true }, true)
      }
      const timer = window.setTimeout(() => fail(new AsrError(t("deepgram.timeout"), false)), HANDSHAKE_TIMEOUT_MS + 5000)

      socket.on("upgrade", (response) => {
        // The request id header name is from memory of Deepgram's responses, not from the documentation; without it the log id is simply absent.
        const value = response.headers["dg-request-id"]
        logId = Array.isArray(value) ? value[0] : value
      })
      socket.on("unexpected-response", (_request, response) => {
        let body = ""
        response.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")))
        response.on("end", () => fail(upgradeError(response.statusCode ?? 0, body.trim())))
      })
      socket.on("open", () => {
        ready = true
        window.clearTimeout(timer)
        // No audio flows while a run is paused or the backlog is being built up; the server hangs up after 10 s of nothing.
        keepAlive = window.setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN || Date.now() - lastSentAt < keepAliveMs) return
          socket.send(JSON.stringify({ type: "KeepAlive" }))
          lastSentAt = Date.now()
        }, Math.max(10, Math.floor(keepAliveMs / 3)))
        const connection: AsrConnection = {
          sendAudio(pcm, last) {
            if (socket.readyState !== WebSocket.OPEN) throw new AsrError(t("deepgram.socketClosed"), false)
            // An empty binary frame makes the server close the stream, so the end of the audio is a message, not an empty frame.
            if (pcm.length > 0) {
              socket.send(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
              lastSentAt = Date.now()
            }
            if (last) {
              endRequested = true
              stopKeepAlive()
              socket.send(JSON.stringify({ type: "CloseStream" }))
            }
          },
          close() {
            closedLocally = true
            finished = true
            stopKeepAlive()
            if (socket.readyState === WebSocket.OPEN) socket.close()
            else socket.terminate()
          },
        }
        resolve({ connection, logId })
      })
      socket.on("message", (data, isBinary) => {
        if (isBinary || finished) return
        const event = parseDeepgramMessage(text(data), config.diarize)
        if (event.kind === "results") handlers.onResult(event.update, false)
        else if (event.kind === "end" && endRequested) announceEnd()
        else if (event.kind === "error") fail(new AsrError(t("deepgram.error", event.variant, event.description), FATAL_VARIANT.test(event.variant)))
      })
      socket.on("error", (error) => fail(new AsrError(t("asr.network", error.message), false)))
      socket.on("close", (code, reason) => {
        window.clearTimeout(timer)
        stopKeepAlive()
        if (closedLocally || finished) return
        if (endRequested) {
          // The server closes after the closing summary; a close without one still means the finals are all in.
          announceEnd()
          finished = true
          return
        }
        fail(closeError(code, reason.toString("utf8")))
      })
    })
}
