// Live transcription against a sherpa-onnx streaming server running on the user's machine.
//   https://k2-fsa.github.io/sherpa/onnx/websocket/online-websocket.html
//   https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/online-websocket-server-impl.cc
// Audio goes up as binary frames of float32 samples in [-1, 1] at 16 kHz, the end of the input is the text frame "Done", and
// JSON results come down. The server sends "Done!" after the last result and does not close the socket: the client does.
import WebSocket, { type RawData } from "ws"
import { t } from "../../../i18n/index.ts"
import { hostOf } from "../../../url.ts"
import { AsrError, SentAudioClock, type AsrConnect, type AsrConnection, type AsrUpdate } from "../../contract.ts"
import { SherpaNormalizer } from "./normalize.ts"

export interface SherpaConfig {
  endpoint: string
}

const HANDSHAKE_TIMEOUT_MS = 10_000

export function sherpaConfigProblem(config: SherpaConfig): string | undefined {
  if (!config.endpoint.trim()) return t("sherpa.noEndpoint")
  if (!/^wss?:\/\//i.test(config.endpoint.trim()) || !hostOf(config.endpoint.trim().replace(/^ws/i, "http"))) return t("sherpa.badEndpoint")
  return undefined
}

const text = (data: RawData): string => (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString("utf8")

/** PCM16 as the float32 samples the server reads. */
export function floatFrame(pcm: Int16Array): Buffer {
  const samples = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
}

export function sherpaConnector(config: SherpaConfig): AsrConnect {
  return (handlers) =>
    new Promise((resolve, reject) => {
      const endpoint = config.endpoint.trim()
      const socket = new WebSocket(endpoint, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS })
      const clock = new SentAudioClock()
      const normalizer = new SherpaNormalizer(() => clock.ms)
      let ready = false
      let finished = false
      let closedLocally = false
      let endRequested = false
      let endAnnounced = false

      const fail = (error: AsrError) => {
        if (finished) return
        finished = true
        window.clearTimeout(timer)
        if (ready) handlers.onClose(error)
        else reject(error)
        socket.terminate()
      }
      /** Tells the streamer every result has arrived, once: with the reply that closes the stream, or "Done!" if that never came. */
      const announceEnd = (update: AsrUpdate) => {
        if (endAnnounced) return
        endAnnounced = true
        handlers.onResult(update, true)
      }
      const timer = window.setTimeout(() => fail(new AsrError(t("sherpa.timeout", endpoint), false)), HANDSHAKE_TIMEOUT_MS + 5000)

      socket.on("open", () => {
        ready = true
        window.clearTimeout(timer)
        const connection: AsrConnection = {
          sendAudio(pcm, last) {
            if (socket.readyState !== WebSocket.OPEN) throw new AsrError(t("sherpa.socketClosed"), false)
            if (pcm.length > 0) {
              socket.send(floatFrame(pcm), { binary: true })
              clock.advance(pcm.length)
            }
            if (last) {
              endRequested = true
              socket.send("Done")
            }
          },
          close() {
            closedLocally = true
            finished = true
            if (socket.readyState === WebSocket.OPEN) socket.close()
            else socket.terminate()
          },
        }
        resolve({ connection })
      })
      socket.on("message", (data, isBinary) => {
        if (isBinary || finished) return
        const body = text(data)
        if (body === "Done!") {
          if (endRequested) announceEnd({ utterances: [], keepInterims: true })
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(body)
        } catch {
          return
        }
        const result = normalizer.update(parsed)
        if (!result) return
        if (result.last && endRequested) announceEnd(result.update)
        else handlers.onResult(result.update, false)
      })
      socket.on("error", (error) => {
        const refused = (error as NodeJS.ErrnoException).code === "ECONNREFUSED"
        fail(refused ? new AsrError(t("sherpa.refused", endpoint), false) : new AsrError(t("asr.network", error.message), false))
      })
      socket.on("close", (code) => {
        window.clearTimeout(timer)
        if (closedLocally || finished) return
        // A server that goes away after the input was ended has said all it will say.
        if (endRequested) {
          announceEnd({ utterances: [], keepInterims: true })
          finished = true
          return
        }
        fail(new AsrError(t("sherpa.closed", code), false))
      })
    })
}
