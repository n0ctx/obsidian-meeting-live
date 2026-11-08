// Local stand-in for the speech and language services, for testing without paid APIs or keys.
// Run: node --import ./tests/support/register.mjs dev/mock-server.ts [port]   (port 0 picks a free one; the URL is printed;
// the loader stands in for the obsidian module that the shared protocol code reaches through its messages)
//   Volcengine streaming ASR:     ws://127.0.0.1:<port>/asr
//   Deepgram live:                ws://127.0.0.1:<port>/v1/listen   (Authorization: Token <key>; the key "bad" gets a 401)
//   OpenAI-style transcription:   http://127.0.0.1:<port>/v1   (POST /audio/transcriptions; the key "bad" gets a 401)
//   OpenAI-compatible LLM:        http://127.0.0.1:<port>/v1   (POST /chat/completions)
//   POST /drop closes every ASR socket to simulate a network failure.
//   GET /stats counts what the Deepgram route has seen, for tests.
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { WebSocketServer, type WebSocket } from "ws"
import { decodeClientFrame, encodeServerResult } from "../src/asr/providers/volc/protocol.ts"

const port = Number(process.argv[2] ?? 8790)
const SENTENCES = [
  "我们今年的收入预计在三点二亿元左右，去年是两亿一千万。",
  "毛利率大概维持在百分之四十二，主要是材料成本下降了。",
  "目前在手订单有一点五亿，其中头部客户占比接近六成。",
  "产能方面，二期产线计划明年三月投产，届时年产能翻倍。",
  "融资这一轮我们希望估值在二十亿，老股东会继续跟投。",
  "竞争对手主要是两家日本企业，他们的价格比我们高百分之二十左右。",
  "团队现在一共一百二十人，研发占了一半以上。",
  "关于上市，我们初步考虑二零二八年申报科创板，但还要看业绩情况。",
]
const SENTENCE_MS = 4200
/** OpenAI documents 25 MB per upload; the mock refuses more with the same status. */
const UPLOAD_LIMIT = 25 * 1024 * 1024
const stats = { deepgramConnections: 0, keepAlives: 0, binaryFrames: 0, emptyFrames: 0, closeStreams: 0 }

/** The text fields of a multipart body and the size of its file part. */
function parseMultipart(body: Buffer, contentType: string): { fields: Record<string, string>; fileBytes: number } | undefined {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1]
  if (!boundary) return undefined
  const delimiter = Buffer.from(`--${boundary}`)
  const fields: Record<string, string> = {}
  let fileBytes = 0
  let at = body.indexOf(delimiter)
  while (at >= 0) {
    const next = body.indexOf(delimiter, at + delimiter.length)
    if (next < 0) break
    const part = body.subarray(at + delimiter.length + 2, next - 2)
    const split = part.indexOf("\r\n\r\n")
    const head = part.subarray(0, split).toString("utf8")
    const name = /name="([^"]+)"/.exec(head)?.[1]
    if (name === "file") fileBytes = part.length - split - 4
    else if (name) fields[name] = part.subarray(split + 4).toString("utf8")
    at = next
  }
  return { fields, fileBytes }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks)))
  })
}

/** What an OpenAI-style /audio/transcriptions answers: segments of the mock sentences, spread over a duration guessed from the file size (about 32 kbit/s). */
function transcription(fields: Record<string, string>, fileBytes: number): { status: number; body: unknown } {
  const model = fields.model ?? ""
  const format = fields.response_format ?? "json"
  if (/^gpt-.*transcribe$/.test(model) && format === "verbose_json") return { status: 400, body: { error: { message: `response_format 'verbose_json' is not compatible with model '${model}'`, type: "invalid_request_error" } } }
  const duration = Math.max(8, Math.round(fileBytes / 4000))
  const segments = Array.from({ length: Math.ceil((duration * 1000) / SENTENCE_MS) }, (_, i) => ({
    id: i,
    speaker: i % 2 ? "B" : "A",
    start: (i * SENTENCE_MS) / 1000,
    end: Math.min(duration, ((i + 1) * SENTENCE_MS) / 1000),
    text: SENTENCES[i % SENTENCES.length],
  }))
  const text = segments.map((x) => x.text).join("")
  if (format === "verbose_json") return { status: 200, body: { task: "transcribe", language: fields.language ?? "chinese", duration, text, segments: segments.map(({ id, start, end, text }) => ({ id, start, end, text })) } }
  if (format === "diarized_json") return { status: 200, body: { task: "transcribe", duration, text, segments: segments.map((x) => ({ type: "transcript.text.segment", ...x })) } }
  return { status: 200, body: { text } }
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/stats") {
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(stats))
    return
  }
  if (req.method === "POST" && req.url?.endsWith("/audio/transcriptions")) {
    const body = await readBody(req)
    const reply = (status: number, payload: unknown) => {
      res.statusCode = status
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify(payload))
    }
    if (req.headers.authorization === "Bearer bad") return reply(401, { error: { message: "Incorrect API key provided: bad", type: "invalid_request_error" } })
    const form = parseMultipart(body, req.headers["content-type"] ?? "")
    if (!form?.fileBytes) return reply(400, { error: { message: "you must provide a file", type: "invalid_request_error" } })
    if (form.fileBytes > UPLOAD_LIMIT) return reply(413, { error: { message: `Maximum content size limit (${UPLOAD_LIMIT}) exceeded`, type: "server_error" } })
    const { status, body: payload } = transcription(form.fields, form.fileBytes)
    return reply(status, payload)
  }
  if (req.method === "POST" && req.url === "/drop") {
    for (const socket of wss.clients) socket.terminate()
    res.end("dropped")
    return
  }
  if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      const request = JSON.parse(body) as { messages: { role: string; content: string }[] }
      const user = request.messages.find((m) => m.role === "user")?.content ?? ""
      const lines = [...user.matchAll(/^\[(\d{2}:\d{2}:\d{2})\] (.+)$/gm)].map((m) => ({ t: m[1], text: m[2] }))
      const isSummary = request.messages[0]?.content.includes("Output one JSON object only")
      let content: string
      if (isSummary) {
        const first = lines[0] ?? { t: "00:00:00", text: "" }
        const last = lines[lines.length - 1] ?? first
        content = JSON.stringify({
          title: "经营情况",
          paragraphs: [
            { topic: "经营情况", text: `讨论了${first.text.slice(0, 18)}…等问题，毛利率 45%（测试用错误数字）。`, t: first.t },
            { topic: "判断", text: last.text.replace(/。$/, ""), t: last.t },
          ],
          todos: [{ text: "财务补充收入口径说明", t: last.t }],
          open: [{ text: "收入为预计值，尚未经审计", t: last.t }],
        })
      } else {
        content = `1.业务情况\n公司今年收入预计三点二亿元，去年为两亿一千万。\n\n待核实事项\n- 毛利率口径（来源 ${lines[1]?.t ?? "00:00:00"}）`
      }
      setTimeout(() => {
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }))
      }, 1200)
    })
    return
  }
  res.statusCode = 404
  res.end()
})

const wss = new WebSocketServer({ noServer: true })
server.on("upgrade", (req, socket, head) => {
  const deepgram = req.url?.startsWith("/v1/listen")
  const key = deepgram ? req.headers.authorization?.replace(/^Token /, "") : (req.headers["x-api-key"] ?? req.headers["x-api-access-key"])
  if (key === "bad") {
    socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 12\r\n\r\ninvalid key\n")
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
})

/**
 * Deepgram's live protocol as documented: binary PCM in, Results out (interims growing until a final settles the stretch,
 * times in seconds from the first sample of the connection), KeepAlive and CloseStream as text, and on CloseStream the
 * remaining final, a Metadata message and a normal close. An empty binary frame ends the stream abnormally, as Deepgram does.
 */
function deepgramSession(ws: WebSocket): void {
  stats.deepgramConnections++
  let receivedMs = 0
  let index = Math.floor(Math.random() * SENTENCES.length)
  let segmentStart = 0
  const results = (text: string, start: number, end: number, final: boolean) =>
    ws.send(JSON.stringify({ type: "Results", channel_index: [0, 1], duration: (end - start) / 1000, start: start / 1000, is_final: final, speech_final: final, channel: { alternatives: [{ transcript: text, confidence: 0.9, words: [] }] }, metadata: { request_id: "mock" } }))
  const partial = () => {
    const sentence = SENTENCES[index % SENTENCES.length]
    return sentence.slice(0, Math.max(1, Math.floor((sentence.length * (receivedMs - segmentStart)) / SENTENCE_MS)))
  }
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      const message = JSON.parse(data.toString()) as { type?: string }
      if (message.type === "KeepAlive") stats.keepAlives++
      if (message.type === "CloseStream") {
        stats.closeStreams++
        if (receivedMs > segmentStart) results(partial(), segmentStart, receivedMs, true)
        ws.send(JSON.stringify({ type: "Metadata", request_id: "mock", sha256: "x", created: new Date().toISOString(), duration: receivedMs / 1000, channels: 1 }))
        ws.close(1000)
      }
      return
    }
    stats.binaryFrames++
    if (data.length === 0) {
      stats.emptyFrames++
      ws.close(1011, "NET-0001: empty frame")
      return
    }
    receivedMs += (data.length / 2 / 16000) * 1000
    if (receivedMs - segmentStart >= SENTENCE_MS) {
      results(SENTENCES[index % SENTENCES.length], segmentStart, receivedMs, true)
      index++
      segmentStart = receivedMs
    } else results(partial(), segmentStart, receivedMs, false)
  })
  ws.on("error", () => undefined)
}

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  if (req.url?.startsWith("/v1/listen")) return deepgramSession(ws)
  let sequence = 1
  let receivedMs = 0
  let index = Math.floor(Math.random() * SENTENCES.length)
  let sentenceStart = 0
  const send = (utterances: unknown[], last = false) => ws.send(encodeServerResult(++sequence, { result: { text: "", utterances } }, last))
  ws.on("message", (data: Buffer) => {
    const frame = decodeClientFrame(data)
    if (frame.type === 1) {
      ws.send(encodeServerResult(sequence, { result: { text: "" } }, false))
      return
    }
    receivedMs += (frame.payload.length / 2 / 16000) * 1000
    const sentence = SENTENCES[index % SENTENCES.length]
    const progress = (receivedMs - sentenceStart) / SENTENCE_MS
    if (frame.last || progress >= 1) {
      send([{ text: sentence, start_time: Math.round(sentenceStart), end_time: Math.round(receivedMs), definite: true }], frame.last)
      index++
      sentenceStart = receivedMs + 300
      if (frame.last) ws.close()
    } else if (receivedMs > sentenceStart) {
      const chars = Math.max(1, Math.floor(sentence.length * progress))
      send([{ text: sentence.slice(0, chars), start_time: Math.round(sentenceStart), end_time: Math.round(receivedMs), definite: false }])
    }
  })
  ws.on("error", () => undefined)
})

server.listen(port, "127.0.0.1", () => console.log(`mock server on http://127.0.0.1:${(server.address() as AddressInfo).port}`))
