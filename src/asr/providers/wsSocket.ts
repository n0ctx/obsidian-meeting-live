// What the WebSocket adapters share: opening a socket with a handshake timeout and the failure paths of the handshake,
// and a small lifecycle that reports a failure exactly once. Everything provider-specific stays in the adapter.
import WebSocket, { type RawData } from "ws"
import { t } from "../../i18n/index.ts"
import { AsrError } from "../contract.ts"

export const HANDSHAKE_TIMEOUT_MS = 10_000

export const frameText = (data: RawData): string => (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString("utf8")

/**
 * Opens a socket and resolves once it is open. A server that answers the upgrade with an HTTP error rejects with
 * what `refused` makes of the status and body; a network failure rejects with a retryable error.
 */
export function openSocket(url: string, headers: Record<string, string>, refused: (status: number, body: string) => AsrError, timedOut: () => AsrError): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers, handshakeTimeout: HANDSHAKE_TIMEOUT_MS })
    const timer = window.setTimeout(() => {
      socket.terminate()
      reject(timedOut())
    }, HANDSHAKE_TIMEOUT_MS + 5000)
    const settle = (action: () => void) => {
      window.clearTimeout(timer)
      action()
    }
    socket.on("unexpected-response", (_request, response) => {
      let body = ""
      response.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")))
      response.on("end", () => settle(() => reject(refused(response.statusCode ?? 0, body.trim()))))
    })
    socket.on("error", (error) => settle(() => reject(new AsrError(t("asr.network", error.message), false))))
    socket.on("open", () => settle(() => resolve(socket)))
  })
}

/**
 * Reports one failure of a connection, whichever of the error, close and message handlers sees it first, and stops
 * the socket. Before the connection is ready the failure goes to the caller of connect; afterwards to `onClose`.
 */
export class SocketLifecycle {
  private done = false
  readonly socket: WebSocket
  private readonly report: (error: AsrError) => void
  private readonly cleanup: () => void

  constructor(socket: WebSocket, report: (error: AsrError) => void, cleanup: () => void = () => undefined) {
    this.socket = socket
    this.report = report
    this.cleanup = cleanup
  }

  /** True once the connection has ended for any reason, including a close requested locally. */
  get finished(): boolean {
    return this.done
  }

  fail(error: AsrError): void {
    if (this.done) return
    this.done = true
    this.cleanup()
    this.report(error)
    this.socket.terminate()
  }

  /** The stream ended as intended: nothing more is reported. */
  complete(): void {
    this.done = true
    this.cleanup()
  }

  closeLocally(): void {
    this.done = true
    this.cleanup()
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close()
    else this.socket.terminate()
  }
}
