import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { AsrError, SentAudioClock, type AsrConnectionHandlers, type AsrUtterance } from "../src/asr/contract.ts"
import { volcResultSink } from "../src/asr/providers/volc/normalize.ts"
import { AsrStreamer, type AsrEvents } from "../src/asr/streamer.ts"
import type { TranscriptGap, Utterance } from "../src/meeting/types.ts"

/** Records what the streamer sends; results are fed either as neutral updates or as Volcengine JSON through the real adapter. */
class FakeServer {
  connections: { handlers: AsrConnectionHandlers; volc: (data: unknown, last: boolean) => void; sent: number; last: boolean; closed: boolean }[] = []
  fail: AsrError | undefined

  connect = async (handlers: AsrConnectionHandlers) => {
    if (this.fail) throw this.fail
    const record = { handlers, volc: volcResultSink(handlers), sent: 0, last: false, closed: false }
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

  /** A neutral update, as any adapter delivers it. */
  emit(utterances: AsrUtterance[], last = false) {
    this.current.handlers.onResult({ utterances }, last)
  }

  /** Volcengine-shaped JSON, normalized by the Volc adapter on its way to the streamer. */
  emitVolc(utterances: unknown[], last = false) {
    this.current.volc({ result: { utterances } }, last)
  }
}

type VolcUtterance = { text: string; start_time: number; end_time: number; definite: boolean }
const volcFinal = (text: string, start: number, end: number): VolcUtterance => ({ text, start_time: start, end_time: end, definite: true })
const volcInterim = (text: string, start: number, end: number): VolcUtterance => ({ text, start_time: start, end_time: end, definite: false })
const fin = (text: string, startMs: number, endMs: number): AsrUtterance => ({ text, startMs, endMs, final: true })
const interim = (text: string, startMs: number, endMs: number): AsrUtterance => ({ text, startMs, endMs, final: false })

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

// ---------------------------------------------------------------- Volcengine-shaped results through the Volc adapter

test("streams audio, emits interims, dedupes repeated finals", async () => {
  const server = new FakeServer()
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true, finalTimeoutMs: 50 })
  asr.begin(0, server.connect)
  await flush()
  assert.equal(asr.currentState, "live")
  asr.push(second())
  asr.tick()
  asr.tick()
  assert.equal(server.current.sent, 16000)
  server.emitVolc([volcInterim("今年收入", 100, 600)])
  assert.equal(rec.interims()[0].text, "今年收入")
  // Full-mode style responses repeat earlier definite utterances; they must not duplicate.
  server.emitVolc([volcFinal("今年收入三亿。", 100, 900)])
  server.emitVolc([volcFinal("今年收入三亿。", 100, 900), volcInterim("毛利", 950, 1000)])
  assert.deepEqual(rec.finals.map((u) => u.text), ["今年收入三亿。"])
  assert.equal(rec.interims()[0].text, "毛利")
  const ending = asr.end()
  await flush()
  assert.equal(server.current.last, true)
  server.emitVolc([volcFinal("毛利四成。", 950, 1000)], true)
  await ending
  assert.deepEqual(rec.finals.map((u) => u.text), ["今年收入三亿。", "毛利四成。"])
  assert.deepEqual(rec.gaps, [])
  assert.equal(asr.currentState, "idle")
})

test("reconnect resumes from unconfirmed speech with correct time offsets", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const server = new FakeServer()
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true, maxChunksPerTick: 100 })
  asr.begin(60_000, server.connect)
  await flush()
  asr.push(second())
  asr.push(second())
  asr.tick()
  server.emitVolc([volcFinal("第一句。", 0, 700)])
  server.emitVolc([volcInterim("第二句还没", 1200, 1900)])
  server.current.handlers.onClose(new AsrError("断开", false))
  assert.equal(asr.currentState, "reconnecting")
  asr.push(second())
  t.mock.timers.tick(1000)
  await flush()
  assert.equal(asr.currentState, "live")
  asr.tick()
  // New connection starts at 61.2 s, so it receives 1.8 s of audio (61.2 s → 63 s).
  assert.equal(server.current.sent, 16000 * 1.8)
  server.emitVolc([volcFinal("第二句还没说完。", 0, 900)])
  assert.deepEqual(
    rec.finals.map((u) => [u.text, u.startMs]),
    [
      ["第一句。", 60_000],
      ["第二句还没说完。", 61_200],
    ],
  )
  mock.timers.reset()
})

test("an utterance the recognizer drops without confirming is kept, but not one still in progress", async () => {
  const server = new FakeServer()
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true })
  asr.begin(0, server.connect)
  await flush()
  server.emitVolc([volcInterim("第一句", 1000, 2000)])
  // A reply carrying only an earlier sentence must not cut the one in progress short.
  server.emitVolc([volcFinal("开场。", 0, 500)])
  server.emitVolc([volcInterim("第一句还在说", 1000, 9000)])
  assert.deepEqual(rec.finals.map((u) => u.text), ["开场。"])
  server.emitVolc([volcFinal("第二句", 9200, 9800)])
  assert.deepEqual(rec.finals.map((u) => [u.text, u.startMs]), [["开场。", 0], ["第一句还在说", 1000], ["第二句", 9200]])
  asr.dispose()
})

test("an utterance left unconfirmed too long is kept and recognition restarts after it", async () => {
  const server = new FakeServer()
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true, maxChunksPerTick: 100, maxInterimMs: 5000 })
  asr.begin(0, server.connect)
  await flush()
  for (let i = 0; i < 8; i++) asr.push(second())
  asr.tick()
  server.emitVolc([volcInterim("一直没有判停", 1000, 5000)])
  assert.equal(server.connections.length, 1)
  server.emitVolc([volcInterim("一直没有判停的长句", 1000, 6400)])
  assert.deepEqual(rec.finals.map((u) => [u.text, u.startMs, u.endMs]), [["一直没有判停的长句", 1000, 6400]])
  assert.deepEqual(rec.interims(), [])
  assert.equal(server.connections[0].closed, true)
  await flush()
  assert.equal(server.connections.length, 2)
  asr.tick()
  // The new connection resumes where the kept text ends: 6.4 s → 8 s.
  assert.equal(server.current.sent, 16000 * 1.6)
  server.emitVolc([volcFinal("接着说。", 0, 800)])
  assert.equal(rec.finals.at(-1)?.startMs, 6400)
  asr.dispose()
})

test("first utterance without start_time uses its first word (real Volcengine shape)", async () => {
  const server = new FakeServer()
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true })
  asr.begin(30_000, server.connect)
  await flush()
  const emit = (utterances: unknown[], last = false) => server.current.volc({ result: { utterances } }, last)
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
  const asr = new AsrStreamer(rec.events, { manualTicks: true })
  asr.restore([{ startMs: 5000, endMs: 8000, text: "旧" }])
  asr.begin(8000, server.connect)
  await flush()
  server.emitVolc([volcFinal("新", 100, 500)])
  assert.deepEqual(rec.finals.map((u) => u.startMs), [8100])
  asr.dispose()
})

// ---------------------------------------------------------------- independent of the provider

test("offline longer than the buffer produces an explicit gap", async () => {
  const server = new FakeServer()
  server.fail = new AsrError("网络不可用", false)
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true, ringSeconds: 2 })
  asr.begin(0, server.connect)
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
  const asr = new AsrStreamer(rec.events, { manualTicks: true })
  asr.begin(0, server.connect)
  await flush()
  assert.equal(asr.currentState, "failed")
  assert.equal(server.connections.length, 0)

  const offline = recorder()
  const disabled = new AsrStreamer(offline.events, { manualTicks: true })
  disabled.begin(10_000, null)
  disabled.push(second())
  await disabled.end()
  assert.deepEqual(offline.gaps, [{ startMs: 10_000, endMs: 11_000, reason: "未配置语音识别，该时段未转写" }])
  asr.dispose()
})

// ---------------------------------------------------------------- the neutral contract, without any provider

test("neutral: interims, repeated finals and the end of stream", async () => {
  const server = new FakeServer()
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true, finalTimeoutMs: 50 })
  asr.begin(5000, server.connect)
  await flush()
  asr.push(second())
  asr.tick()
  server.emit([interim("今年收入", 100, 600)])
  assert.deepEqual(rec.interims().map((u) => [u.text, u.startMs, u.endMs]), [["今年收入", 5100, 5600]])
  server.emit([fin("今年收入三亿。", 100, 900)])
  server.emit([fin("今年收入三亿。", 100, 900), interim("毛利", 950, 1000)])
  assert.deepEqual(rec.finals.map((u) => [u.text, u.startMs, u.endMs]), [["今年收入三亿。", 5100, 5900]])
  assert.equal(rec.interims()[0].text, "毛利")
  const ending = asr.end()
  await flush()
  assert.equal(server.current.last, true)
  server.emit([fin("毛利四成。", 950, 1000)], true)
  await ending
  assert.deepEqual(rec.finals.map((u) => u.text), ["今年收入三亿。", "毛利四成。"])
  assert.equal(asr.currentState, "idle")
})

test("neutral: the streamer does not promote an interim that simply disappears", async () => {
  const server = new FakeServer()
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true })
  asr.begin(0, server.connect)
  await flush()
  server.emit([interim("第一句", 1000, 2000)])
  server.emit([fin("第二句", 9200, 9800)])
  assert.deepEqual(rec.finals.map((u) => u.text), ["第二句"])
  assert.deepEqual(rec.interims(), [])
  asr.dispose()
})

test("neutral: keepInterims leaves the text in progress alone, any other update replaces it", async () => {
  const server = new FakeServer()
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true })
  asr.begin(0, server.connect)
  await flush()
  server.emit([interim("进行中", 0, 500)])
  server.current.handlers.onResult({ utterances: [], keepInterims: true }, false)
  assert.equal(rec.interims()[0].text, "进行中")
  server.emit([])
  assert.deepEqual(rec.interims(), [])
  asr.dispose()
})

test("neutral: blank text is ignored, an end before the start is clamped, speaker is passed on", async () => {
  const server = new FakeServer()
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true })
  asr.begin(1000, server.connect)
  await flush()
  server.emit([fin("  ", 0, 100), { text: " 你好 ", startMs: 500, endMs: 100, final: true, speaker: "2" }])
  assert.deepEqual(rec.finals, [{ text: "你好", startMs: 1500, endMs: 1500, speaker: "2" }])
  asr.dispose()
})

test("neutral: a long unconfirmed utterance restarts recognition after the kept text", async () => {
  const server = new FakeServer()
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true, maxChunksPerTick: 100, maxInterimMs: 5000 })
  asr.begin(0, server.connect)
  await flush()
  for (let i = 0; i < 8; i++) asr.push(second())
  asr.tick()
  server.emit([interim("一直没有判停的长句", 1000, 6400)])
  assert.deepEqual(rec.finals.map((u) => [u.startMs, u.endMs]), [[1000, 6400]])
  await flush()
  assert.equal(server.connections.length, 2)
  asr.tick()
  assert.equal(server.current.sent, 16000 * 1.6)
  asr.dispose()
})

test("neutral: times count from the first sample sent on the connection, even if the buffer overflowed while connecting", async () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((r) => (release = r))
  const server = new FakeServer()
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true, ringSeconds: 2, maxChunksPerTick: 100 })
  asr.begin(0, async (handlers) => (await gate, server.connect(handlers)))
  for (let i = 0; i < 5; i++) asr.push(second())
  assert.equal(asr.currentState, "connecting")
  release()
  await flush()
  asr.tick()
  // The oldest 3 s fell out of the buffer, so the connection's first sample is at 3 s.
  assert.equal(server.current.sent, 16000 * 2)
  server.emit([fin("补发的内容", 0, 500)])
  assert.deepEqual(rec.finals.map((u) => u.startMs), [3000])
  asr.dispose()
})

test("neutral: continuing a meeting skips finals that were already saved", async () => {
  const server = new FakeServer()
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true })
  asr.restore([{ startMs: 5000, endMs: 8000, text: "旧" }])
  asr.begin(8000, server.connect)
  await flush()
  server.emit([fin("新", 100, 500)])
  assert.deepEqual(rec.finals.map((u) => u.startMs), [8100])
  asr.dispose()
})

// ---------------------------------------------------------------- an adapter whose provider returns no timestamps

/** Commits every second of audio it has been sent, stamping times from the audio clock; replies to the end of stream. */
class ClockServer {
  connections: { closed: boolean; handlers: AsrConnectionHandlers }[] = []

  connect = async (handlers: AsrConnectionHandlers) => {
    const clock = new SentAudioClock()
    const record = { closed: false, handlers }
    this.connections.push(record)
    let committed = 0
    let n = 0
    const commit = (last: boolean) => {
      const utterances: AsrUtterance[] = clock.ms > committed ? [{ text: `段${++n}`, startMs: committed, endMs: clock.ms, final: true }] : []
      committed = clock.ms
      handlers.onResult({ utterances }, last)
    }
    return {
      connection: {
        sendAudio: (pcm: Int16Array, last: boolean) => {
          clock.advance(pcm.length)
          if (last) return commit(true)
          if (clock.ms - committed >= 1000) commit(false)
          else handlers.onResult({ utterances: [{ text: "…", startMs: committed, endMs: clock.ms, final: false }] }, false)
        },
        close: () => (record.closed = true),
      },
    }
  }
}

test("an adapter without provider timestamps: clock-derived times survive a drop mid-utterance and the end of stream", { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const server = new ClockServer()
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true, maxChunksPerTick: 100, finalTimeoutMs: 300 })
  asr.begin(10_000, server.connect)
  await flush()
  asr.push(new Int16Array(16000 * 2.5))
  asr.tick()
  assert.deepEqual(rec.finals.map((u) => [u.startMs, u.endMs]), [[10_000, 11_000], [11_000, 12_000]])
  assert.equal(rec.interims()[0].startMs, 12_000)

  // The connection dies while 0.4 s of speech is still unconfirmed; the next one starts again from 12 s.
  server.connections[0].handlers.onClose(new AsrError("断开", false))
  assert.equal(asr.currentState, "reconnecting")
  asr.push(new Int16Array(16000 * 1))
  t.mock.timers.tick(1000)
  await flush()
  assert.equal(asr.currentState, "live")
  asr.tick()
  // 12 s → 13.5 s is 1.5 s of audio: one committed second and 0.5 s pending.
  assert.deepEqual(rec.finals.map((u) => [u.startMs, u.endMs]), [[10_000, 11_000], [11_000, 12_000], [12_000, 13_000]])
  mock.timers.reset()

  const started = Date.now()
  await asr.end()
  assert.ok(Date.now() - started < 250, "the end of stream must be answered, not waited out")
  assert.deepEqual(rec.finals.at(-1), { text: "段2", startMs: 13_000, endMs: 13_500 })
  assert.deepEqual(rec.gaps, [])
})

// ---------------------------------------------------------------- one streamer, several runs

test("each run brings its own connector; one streamer serves them all", async () => {
  const first = new FakeServer()
  const second_ = new FakeServer()
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true, finalTimeoutMs: 50 })

  asr.begin(0, first.connect)
  await flush()
  asr.push(second())
  asr.tick()
  first.emit([fin("第一段。", 0, 800)])
  const ending = asr.end()
  await flush()
  first.emit([], true)
  await ending
  assert.equal(first.connections.length, 1)

  // A run without a recognizer ends up disabled and records the audio as a gap.
  asr.begin(1000, null)
  assert.equal(asr.currentState, "disabled")
  asr.push(second())
  await asr.end()
  assert.deepEqual(rec.gaps.map((g) => [g.startMs, g.endMs]), [[1000, 2000]])

  // The next run uses a different connector; its times are relative to its own connection.
  asr.begin(2000, second_.connect)
  await flush()
  assert.equal(asr.currentState, "live")
  assert.equal(first.connections.length, 1)
  assert.equal(second_.connections.length, 1)
  second_.emit([fin("第二段。", 0, 500)])
  assert.deepEqual(rec.finals.map((u) => [u.text, u.startMs]), [["第一段。", 0], ["第二段。", 2000]])
  // Finals already seen still count: saved text is not emitted again if a later run reports it.
  asr.restore([{ startMs: 2500, endMs: 3000, text: "已保存" }])
  second_.emit([fin("已保存", 500, 1000)])
  assert.equal(rec.finals.length, 2)
  asr.dispose()
})
