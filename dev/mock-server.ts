// Local stand-in for the Volcengine streaming ASR and an OpenAI-compatible LLM, for testing
// without paid APIs. Run: node dev/mock-server.ts [port]
//   ASR endpoint: ws://127.0.0.1:<port>/asr     LLM base URL: http://127.0.0.1:<port>/v1
//   POST /drop closes every ASR socket to simulate a network failure.
import { createServer } from "node:http"
import { WebSocketServer, type WebSocket } from "ws"
import { decodeClientFrame, encodeServerResult } from "../src/asr/volcProtocol.ts"

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

const server = createServer((req, res) => {
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
          items: [
            { kind: "fact", text: `讨论了${first.text.slice(0, 18)}…等问题`, t: first.t },
            { kind: "fact", text: "毛利率 45%（测试用错误数字）", t: first.t },
            { kind: "opinion", text: last.text.replace(/。$/, ""), t: last.t },
            { kind: "todo", text: "财务补充收入口径说明", t: last.t },
            { kind: "open", text: "收入为预计值，尚未经审计", t: last.t },
          ],
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
  const key = req.headers["x-api-key"] ?? req.headers["x-api-access-key"]
  if (key === "bad") {
    socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 12\r\n\r\ninvalid key\n")
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
})

wss.on("connection", (ws: WebSocket) => {
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

server.listen(port, "127.0.0.1", () => console.log(`mock server on http://127.0.0.1:${port}`))
