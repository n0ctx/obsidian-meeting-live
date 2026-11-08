// A scriptable WebSocket server on 127.0.0.1 for connector tests: it records what it receives and lets each test script the replies.
import assert from "node:assert/strict"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { after } from "node:test"
import { WebSocketServer, type WebSocket } from "ws"
import type { AsrConnectionHandlers, AsrError, AsrUpdate } from "../../src/asr/contract.ts"

export interface Seen {
  frames: { binary: boolean; text: string; bytes: number }[]
  url: string
  headers: IncomingMessage["headers"]
  socket?: WebSocket
}

const closers = new Set<() => void>()
after(() => closers.forEach((close) => close()))

export async function fakeWs(behave: (ws: WebSocket, seen: Seen) => void = () => undefined, reject?: { status: number; body?: string }) {
  const seen: Seen = { frames: [], url: "", headers: {} }
  const server = createServer()
  const wss = new WebSocketServer({ noServer: true })
  server.on("upgrade", (req, socket, head) => {
    seen.url = req.url ?? ""
    seen.headers = req.headers
    if (reject) {
      const body = reject.body ?? ""
      socket.end(`HTTP/1.1 ${reject.status} Rejected\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      seen.socket = ws
      ws.on("message", (data, isBinary) => seen.frames.push({ binary: isBinary, text: isBinary ? "" : data.toString(), bytes: (data as Buffer).length }))
      ws.on("error", () => undefined)
      behave(ws, seen)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const close = () => {
    for (const client of wss.clients) client.terminate()
    server.close()
    server.closeAllConnections()
  }
  closers.add(close)
  const port = (server.address() as AddressInfo).port
  return { url: `ws://127.0.0.1:${port}`, seen, close, port }
}

/** Handlers that collect what the streamer would be told. */
export function collect() {
  const results: { update: AsrUpdate; last: boolean }[] = []
  const closes: AsrError[] = []
  const handlers: AsrConnectionHandlers = { onResult: (update, last) => results.push({ update, last }), onClose: (error) => closes.push(error) }
  return { handlers, results, closes }
}

export async function waitFor(condition: () => boolean, ms = 2000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > ms) assert.fail("timed out waiting")
    await new Promise((r) => setTimeout(r, 5))
  }
}

export const pcm = (ms: number) => new Int16Array((16000 * ms) / 1000).fill(100)
