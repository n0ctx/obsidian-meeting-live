// AssemblyAI Universal-Streaming (v3) over WebSocket: raw 16 kHz mono PCM16 up, JSON turns down.
//   https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api  (URL, query parameters, Authorization without Bearer,
//     Begin / Turn / Termination, Terminate, UpdateConfiguration with keyterms_prompt, 20-1000 ms audio chunks)
//   https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures  (close codes: 1008 unauthorized, 3005 server error,
//     3008 session expired, 3009 too many sessions or rate limit; an Error frame precedes the close)
// Billing follows how long the socket stays open, not how much audio is sent.
import type WebSocket from "ws"
import { t } from "../../../i18n/index.ts"
import { hostOf } from "../../../url.ts"
import { AsrError, SentAudioClock, type AsrConnect, type AsrConnection } from "../../contract.ts"
import { frameText, openSocket, SocketLifecycle } from "../wsSocket.ts"
import { needsFormatTurns } from "./info.ts"
import { parseAssemblyAiMessage } from "./normalize.ts"

export interface AssemblyAiConfig {
  endpoint: string
  /** Sent as the Authorization header, without a Bearer prefix. */
  apiKey: string
  model: string
  diarize: boolean
  /** Terms to bias recognition towards. */
  keyterms: string[]
}

/** The documentation caps keyterms_prompt at 100 terms. */
const MAX_KEYTERMS = 100
const BEGIN_TIMEOUT_MS = 15_000

export function assemblyAiConfigProblem(config: AssemblyAiConfig): string | undefined {
  if (!config.apiKey) return t("assemblyai.noKey")
  if (!config.model.trim()) return t("assemblyai.noModel")
  if (!hostOf(config.endpoint.replace(/^ws/, "http"))) return t("assemblyai.badEndpoint")
  return undefined
}

/** The endpoint with the stream's parameters: 16 kHz PCM16 (the defaults, stated anyway), the model, and speaker labels on request. */
export function assemblyAiUrl(config: AssemblyAiConfig): string {
  const url = new URL(config.endpoint.trim())
  const params: Record<string, string> = { sample_rate: "16000", encoding: "pcm_s16le", speech_model: config.model.trim() }
  if (needsFormatTurns(config.model)) params.format_turns = "true"
  if (config.diarize) params.speaker_labels = "true"
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

export const keytermsMessage = (terms: string[]): Record<string, unknown> | undefined => {
  const list = terms.map((w) => w.trim()).filter(Boolean).slice(0, MAX_KEYTERMS)
  return list.length ? { type: "UpdateConfiguration", keyterms_prompt: list } : undefined
}

const detail = (body: string): string => {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown }
    const text = parsed.error ?? parsed.message
    if (typeof text === "string" && text) return text
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return body.slice(0, 200)
}

/** A refused handshake: a bad key, an account without funds or a rejected request is the user's to fix. */
function upgradeError(status: number, body: string): AsrError {
  const why = detail(body)
  if (status === 401 || status === 403) return new AsrError(t("assemblyai.auth", why), true)
  if (status === 402) return new AsrError(t("assemblyai.balance", why), true)
  if (status === 400 || status === 404) return new AsrError(t("assemblyai.badRequest", status, why), true)
  return new AsrError(t("assemblyai.refused", status, why), false)
}

/**
 * 1008 is an unauthorized connection: a bad or missing key, or an account out of funds, which a retry only repeats. The other codes
 * the documentation lists (3005 server error, 3008 session expired, 3009 too many sessions or rate limit) and a plain drop are worth another try.
 */
export function closeError(code: number, reason: string): AsrError {
  return new AsrError(code === 1008 ? t("assemblyai.unauthorized", reason) : t("assemblyai.closed", code, reason), code === 1008)
}

/** An Error frame the server sends before it closes the socket; its code is the close code that follows. */
export const frameError = (code: string, message: string): AsrError => new AsrError(t("assemblyai.error", code, message), Number(code) === 1008)

export function assemblyAiConnector(config: AssemblyAiConfig): AsrConnect {
  return (handlers) =>
    new Promise((resolve, reject) => {
      const clock = new SentAudioClock()
      const formatTurns = needsFormatTurns(config.model)
      let ready = false
      let endRequested = false
      let endAnnounced = false
      let lastFinalEndMs = 0
      let life: SocketLifecycle
      let beginTimer: number | undefined
      /** Tells the streamer every final has arrived, once, whichever of Termination and the close comes first. */
      const announceEnd = () => {
        if (endAnnounced) return
        endAnnounced = true
        handlers.onResult({ utterances: [], keepInterims: true }, true)
      }
      const wire = (socket: WebSocket) => {
        life = new SocketLifecycle(
          socket,
          (error) => (ready ? handlers.onClose(error) : reject(error)),
          () => window.clearTimeout(beginTimer),
        )
        beginTimer = window.setTimeout(() => life.fail(new AsrError(t("assemblyai.timeout"), false)), BEGIN_TIMEOUT_MS)
        const connection: AsrConnection = {
          sendAudio(pcm, last) {
            if (socket.readyState !== socket.OPEN) throw new AsrError(t("assemblyai.socketClosed"), false)
            if (pcm.length > 0) {
              socket.send(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
              clock.advance(pcm.length)
            }
            if (last) {
              endRequested = true
              socket.send(JSON.stringify({ type: "Terminate" }))
            }
          },
          close: () => life.closeLocally(),
        }
        socket.on("message", (data, isBinary) => {
          if (isBinary || life.finished) return
          const event = parseAssemblyAiMessage(frameText(data), { sentMs: clock.ms, afterMs: lastFinalEndMs, formatTurns })
          switch (event.kind) {
            case "begin": {
              if (ready) return
              ready = true
              window.clearTimeout(beginTimer)
              const keyterms = keytermsMessage(config.keyterms)
              if (keyterms) socket.send(JSON.stringify(keyterms))
              resolve({ connection })
              break
            }
            case "results":
              if (!ready) break
              for (const u of event.update.utterances) if (u.final) lastFinalEndMs = Math.max(lastFinalEndMs, u.endMs)
              handlers.onResult(event.update, false)
              break
            case "end":
              announceEnd()
              life.complete()
              break
            case "error":
              life.fail(frameError(event.code, event.message))
              break
          }
        })
        socket.on("error", (error) => life.fail(new AsrError(t("asr.network", error.message), false)))
        socket.on("close", (code, reason) => {
          if (life.finished) return
          if (endRequested) {
            // A close after Terminate without a Termination message: the finals sent so far are all there will be.
            announceEnd()
            life.complete()
            return
          }
          life.fail(closeError(code, reason.toString("utf8")))
        })
      }
      openSocket(assemblyAiUrl(config), { Authorization: config.apiKey }, upgradeError, () => new AsrError(t("assemblyai.timeout"), false), wire).catch(reject)
    })
}
