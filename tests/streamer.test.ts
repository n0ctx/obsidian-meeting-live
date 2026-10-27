import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { AsrError, AsrStreamer, type AsrConnectionHandlers, type AsrEvents } from "../src/asr/streamer.ts"
import type { TranscriptGap, Utterance } from "../src/meeting/types.ts"

class FakeServer {
  connections: { handlers: AsrConnectionHandlers; sent: number; last: boolean; closed: boolean }[] = []
  fail: AsrError | undefined

  connect = async (handlers: AsrConnectionHandlers) => {
    if (this.fail) throw this.fail
    const record = { handlers, sent: 0, last: false, closed: false }
    this.connections.push(record)
    return {
      connection: {
        sendAudio: (pcm: Int16Array, last: boolean) => {
          record.sent += pcm.length
          if (last) record.last = true
        },
        close: () => (record.closed = true),
      },
      logId: `log-${this.connections.length}`,
    }
  }

  get current() {
    return this.connections[this.connections.length - 1]
  }

  emit(utterances: { text: string; start_time: number; end_time: number; definite: boolean }[], last = false) {
    this.current.handlers.onResult({ result: { utterances } }, last)
  }
}

function recorder() {
  const finals: Utterance[] = []
  const gaps: TranscriptGap[] = []
  const states: string[] = []
  let interims: Utterance[] = []
  const events: AsrEvents = {
    onFinal: (u) => finals.push(u),
    onInterim: (list) => (interims = list),
    onGap: (g) => gaps.push(g),
    onState: (s) => states.push(s),
  }
  return { events, finals, gaps, states, interims: () => interims }
}

const second = () => new Int16Array(16000)
const flush = () => new Promise((r) => setImmediate(r))

test("streams audio, emits interims, dedupes repeated finals", async () => {
  const server = new FakeServer()
  const rec = recorder()
  const asr = new AsrStreamer(server.connect, rec.events, { manualTicks: true, finalTimeoutMs: 50 })
  asr.begin(0)
  await flush()
  assert.equal(asr.currentState, "live")
  asr.push(second())
  asr.tick()
  asr.tick()
  assert.equal(server.current.sent, 16000)
  server.emit([{ text: "今年收入", start_time: 100, end_time: 600, definite: false }])
  assert.equal(rec.interims()[0].text, "今年收入")
  // Full-mode style responses repeat earlier definite utterances; they must not duplicate.
  server.emit([{ text: "今年收入三亿。", start_time: 100, end_time: 900, definite: true }])
  server.emit([
    { text: "今年收入三亿。", start_time: 100, end_time: 900, definite: true },
    { text: "毛利", start_time: 950, end_time: 1000, definite: false },
  ])
  assert.deepEqual(rec.finals.map((u) => u.text), ["今年收入三亿。"])
  assert.equal(rec.interims()[0].text, "毛利")
  const ending = asr.end()
  await flush()
  assert.equal(server.current.last, true)
  server.emit([{ text: "毛利四成。", start_time: 950, end_time: 1000, definite: true }], true)
  await ending
  assert.deepEqual(rec.finals.map((u) => u.text), ["今年收入三亿。", "毛利四成。"])
  assert.deepEqual(rec.gaps, [])
  assert.equal(asr.currentState, "idle")
})

test("reconnect resumes from unconfirmed speech with correct time offsets", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const server = new FakeServer()
  const rec = recorder()
  const asr = new AsrStreamer(server.connect, rec.events, { manualTicks: true, maxChunksPerTick: 100 })
  asr.begin(60_000)
  await flush()
  asr.push(second())
  asr.push(second())
  asr.tick()
  server.emit([{ text: "第一句。", start_time: 0, end_time: 700, definite: true }])
  server.emit([{ text: "第二句还没", start_time: 1200, end_time: 1900, definite: false }])
  server.current.handlers.onClose(new AsrError("断开", false))
  assert.equal(asr.currentState, "reconnecting")
  asr.push(second())
  t.mock.timers.tick(1000)
  await flush()
  assert.equal(asr.currentState, "live")
  asr.tick()
  // New connection starts at 61.2 s, so it receives 1.8 s of audio (61.2 s → 63 s).
  assert.equal(server.current.sent, 16000 * 1.8)
  server.emit([{ text: "第二句还没说完。", start_time: 0, end_time: 900, definite: true }])
  assert.deepEqual(
    rec.finals.map((u) => [u.text, u.startMs]),
    [
      ["第一句。", 60_000],
      ["第二句还没说完。", 61_200],
    ],
  )
  mock.timers.reset()
})

test("offline longer than the buffer produces an explicit gap", async () => {
  const server = new FakeServer()
  server.fail = new AsrError("网络不可用", false)
  const rec = recorder()
  const asr = new AsrStreamer(server.connect, rec.events, { manualTicks: true, ringSeconds: 2 })
  asr.begin(0)
  await flush()
  for (let i = 0; i < 5; i++) asr.push(second())
  assert.deepEqual(rec.gaps.map((g) => [g.startMs, g.endMs]), [
    [0, 1000],
    [1000, 2000],
    [2000, 3000],
  ])
  await asr.end()
  assert.deepEqual(rec.gaps.at(-1)?.startMs, 3000)
  assert.deepEqual(rec.gaps.at(-1)?.endMs, 5000)
  asr.dispose()
})

test("fatal errors stop retrying; missing config records the whole run as a gap", async () => {
  const server = new FakeServer()
  server.fail = new AsrError("鉴权失败", true)
  const rec = recorder()
  const asr = new AsrStreamer(server.connect, rec.events, { manualTicks: true })
  asr.begin(0)
  await flush()
  assert.equal(asr.currentState, "failed")
  assert.equal(server.connections.length, 0)

  const offline = recorder()
  const disabled = new AsrStreamer(null, offline.events, { manualTicks: true })
  disabled.begin(10_000)
  disabled.push(second())
  await disabled.end()
  assert.deepEqual(offline.gaps, [{ startMs: 10_000, endMs: 11_000, reason: "未配置语音识别，该时段未转写" }])
  asr.dispose()
})

test("first utterance without start_time uses its first word (real Volcengine shape)", async () => {
  const server = new FakeServer()
  const rec = recorder()
  const asr = new AsrStreamer(server.connect, rec.events, { manualTicks: true })
  asr.begin(30_000)
  await flush()
  const emit = (utterances: unknown[], last = false) => server.current.handlers.onResult({ result: { utterances } }, last)
  emit([{ definite: false, end_time: 999, text: "大家好", words: [{ start_time: 120, end_time: 200, text: "大家" }] }])
  assert.equal(rec.interims()[0].startMs, 30_120)
  const first = { definite: true, end_time: 20422, text: "大家好，今天聊经营情况。", words: [{ start_time: 120, end_time: 360, text: "大" }] }
  const second = { definite: true, start_time: 20422, end_time: 21312, text: "月投产" }
  emit([first])
  emit([first, second], true)
  emit([{ definite: true, end_time: 500, text: "无字级时间" }])
  assert.deepEqual(rec.finals.map((u) => [u.startMs, u.text]), [
    [30_120, "大家好，今天聊经营情况。"],
    [50_422, "月投产"],
  ])
  asr.dispose()
})

test("continuing a meeting skips finals that were already saved", async () => {
  const server = new FakeServer()
  const rec = recorder()
  const asr = new AsrStreamer(server.connect, rec.events, { manualTicks: true })
  asr.restore([{ startMs: 5000, endMs: 8000, text: "旧" }])
  asr.begin(8000)
  await flush()
  server.emit([{ text: "新", start_time: 100, end_time: 500, definite: true }])
  assert.deepEqual(rec.finals.map((u) => u.startMs), [8100])
  asr.dispose()
})
