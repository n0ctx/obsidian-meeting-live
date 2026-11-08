// Audio pacing: each live provider declares how fast it takes audio, and the streamer never sends faster, in steady state, while catching
// up after a reconnect and when a run ends. Time is simulated: a manual tick stands for tickMs (100 ms), mocked timers stand for the rest.
import assert from "node:assert/strict"
import { test } from "node:test"
import { AsrError, CAUTIOUS_LIVE_PACING, type AsrConnectionHandlers, type LivePacing } from "../src/asr/contract.ts"
import { ASR_PROVIDERS, liveProviders, resolveLive } from "../src/asr/providers/registry.ts"
import { AsrStreamer, DEFAULT_FLUSH_MS, type AsrEvents } from "../src/asr/streamer.ts"
import type { TranscriptGap } from "../src/meeting/types.ts"
import { SERVICES } from "../src/accounts/services.ts"
import { DEFAULT_SETTINGS } from "../src/settings.ts"
import { withAccount, withOne } from "./support/accounts.ts"

const RATE = 16000
const TICK_MS = 100
const TICKS_PER_SECOND = 1000 / TICK_MS
const CHUNK = 0.2 * RATE
const flush = () => new Promise((r) => setImmediate(r))

/** What each live provider declares under the default settings. */
const declared = liveProviders().map((p) => ({ id: p.id, pacing: p.live!.pacing(withOne(SERVICES.find((s) => s.asr === p.id)!.id).account) }))

class Server {
  sent = 0
  last = false
  handlers: AsrConnectionHandlers | undefined
  connects = 0

  connect = async (handlers: AsrConnectionHandlers) => {
    this.connects++
    this.handlers = handlers
    return {
      connection: {
        sendAudio: (pcm: Int16Array, last: boolean) => {
          this.sent += pcm.length
          if (last) this.last = true
        },
        close: () => undefined,
      },
    }
  }

  /** The service saying it has nothing more to add, once the end of stream arrived. */
  finish() {
    this.handlers?.onResult({ utterances: [] }, true)
  }
}

function recorder() {
  const gaps: TranscriptGap[] = []
  const events: AsrEvents = { onFinal: () => undefined, onInterim: () => undefined, onGap: (g) => gaps.push(g), onState: () => undefined }
  return { events, gaps }
}

/** The most audio any `windowTicks` consecutive steps carried. */
function busiest(steps: number[], windowTicks: number): number {
  let best = 0
  for (let i = 0; i + windowTicks <= steps.length; i++) best = Math.max(best, steps.slice(i, i + windowTicks).reduce((a, b) => a + b, 0))
  return best
}

const lostMs = (gaps: TranscriptGap[]) => gaps.reduce((n, g) => n + (g.endMs - g.startMs), 0)

/** What a pace allows a window of `ticks` steps: its rate, and one chunk that was left over from before. */
const allowed = (pacing: LivePacing, ticks: number) => Math.floor(pacing.maxRate * ticks * (TICK_MS / 1000) * RATE) + CHUNK

/**
 * A run that was offline while `outageS` seconds of audio piled up, then connects and catches up while new audio keeps arriving.
 * Returns the audio sent in each tick.
 */
async function catchUp(pacing: LivePacing, outageS: number, ticks: number, ringSeconds = 600) {
  const server = new Server()
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true, ringSeconds })
  let release: () => void = () => undefined
  const gate = new Promise<void>((r) => (release = r))
  asr.begin(0, async (handlers) => (await gate, server.connect(handlers)), pacing)
  for (let i = 0; i < outageS * TICKS_PER_SECOND; i++) asr.push(new Int16Array(RATE / TICKS_PER_SECOND))
  release()
  await flush()
  const steps: number[] = []
  for (let i = 0; i < ticks; i++) {
    const before = server.sent
    asr.push(new Int16Array(RATE / TICKS_PER_SECOND))
    asr.tick()
    steps.push(server.sent - before)
  }
  return { steps, asr, server, rec }
}

// ---------------------------------------------------------------- the declarations

test("every live provider declares a pace, at or above real time and never unbounded", () => {
  assert.deepEqual(declared.map((d) => d.id).sort(), ASR_PROVIDERS.filter((p) => p.live).map((p) => p.id).sort())
  for (const { id, pacing } of declared) assert.ok(Number.isFinite(pacing.maxRate) && pacing.maxRate >= 1, `${id} declares ${pacing.maxRate}`)
})

test("the declared values are the documented ones", () => {
  const rates = Object.fromEntries(declared.map((d) => [d.id, d.pacing.maxRate]))
  assert.deepEqual(rates, { volc: 6, dashscope: 1.25, assemblyai: 1.25, deepgram: 1.25, "sherpa-onnx": 2.5 })
})

test("a resolved recognizer carries its provider's pace, also when it has no connector; an unknown one gets the cautious default", () => {
  const secrets = { getSecret: () => null }
  for (const { id, pacing } of declared) {
    const settings = structuredClone(DEFAULT_SETTINGS)
    withAccount(settings, SERVICES.find((s) => s.asr === id)!.id)
    assert.equal(settings.roles.live !== "", true, `${id} is the live account`)
    assert.deepEqual(resolveLive({ secrets, settings }).pacing, pacing, id)
  }
  const unknown = structuredClone(DEFAULT_SETTINGS)
  unknown.accounts.push({ id: "gone", service: "gone", name: "", apiKeySecret: "", options: {}, llm: { temperature: 0, effort: "off", inputLimit: 0, headers: "" } })
  unknown.roles.live = "gone"
  assert.deepEqual(resolveLive({ secrets, settings: unknown }).pacing, CAUTIOUS_LIVE_PACING)
  assert.deepEqual(resolveLive({ secrets, settings: structuredClone(DEFAULT_SETTINGS) }).pacing, CAUTIOUS_LIVE_PACING, "no account at all")
})

// ---------------------------------------------------------------- catching up and steady state

for (const { id, pacing } of declared) {
  test(`${id}: catching up after a reconnect never sends faster than ${pacing.maxRate}x real time, in any second, and does not stall`, async () => {
    const { steps } = await catchUp(pacing, 400, 600)
    const window = TICKS_PER_SECOND
    assert.ok(busiest(steps, window) <= allowed(pacing, window), `busiest second ${busiest(steps, window)} samples, allowed ${allowed(pacing, window)}`)
    assert.ok(busiest(steps, 5 * window) <= allowed(pacing, 5 * window))
    // The backlog is deeper than the whole run sends, so every tick's allowance is used: the total is the rate, give or take the chunk in flight.
    const total = steps.reduce((a, b) => a + b, 0)
    const expected = pacing.maxRate * 600 * (TICK_MS / 1000) * RATE
    assert.ok(total <= expected + CHUNK && total >= expected - CHUNK, `sent ${total}, expected about ${expected}`)
  })

  test(`${id}: in steady state audio goes out as it arrives, in whole chunks, with no backlog left over`, async () => {
    const server = new Server()
    const asr = new AsrStreamer(recorder().events, { manualTicks: true })
    asr.begin(0, server.connect, pacing)
    await flush()
    const steps: number[] = []
    for (let i = 0; i < 100; i++) {
      const before = server.sent
      asr.push(new Int16Array(RATE / TICKS_PER_SECOND))
      asr.tick()
      steps.push(server.sent - before)
    }
    assert.ok(steps.every((s) => s % CHUNK === 0))
    assert.ok(asr.backlogMs <= 400, `${asr.backlogMs} ms left behind`)
    assert.ok(busiest(steps, TICKS_PER_SECOND) <= allowed(pacing, TICKS_PER_SECOND))
    asr.dispose()
  })

  test(`${id}: ending a run flushes the backlog at ${pacing.maxRate}x too, then ends the stream`, { timeout: 20_000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
    const server = new Server()
    const asr = new AsrStreamer(recorder().events, { manualTicks: true })
    asr.begin(0, server.connect, pacing)
    await flush()
    for (let i = 0; i < 20 * TICKS_PER_SECOND; i++) asr.push(new Int16Array(RATE / TICKS_PER_SECOND))
    const ending = asr.end()
    const steps: number[] = []
    let before = 0
    for (let i = 0; i < 10_000 && !server.last; i++) {
      await flush()
      steps.push(server.sent - before)
      before = server.sent
      if (server.last) break
      t.mock.timers.tick(TICK_MS)
    }
    assert.equal(server.sent, 20 * RATE, "the whole backlog was sent before the end of stream")
    assert.ok(busiest(steps, TICKS_PER_SECOND) <= allowed(pacing, TICKS_PER_SECOND), `busiest second ${busiest(steps, TICKS_PER_SECOND)}`)
    assert.ok(steps.length >= 1 + Math.floor((20 * RATE) / (pacing.maxRate * RATE * (TICK_MS / 1000))) - 2, `finished in ${steps.length} steps: too fast for ${pacing.maxRate}x`)
    server.finish()
    await ending
  })
}

test("a late tick is granted the time that passed, not a burst", async () => {
  const pacing = { maxRate: 2 }
  const { asr, server } = await catchUp(pacing, 60, 0)
  asr.tick(1000)
  assert.ok(server.sent <= allowed(pacing, TICKS_PER_SECOND) && server.sent >= 2 * RATE - CHUNK, `a one-second step sent ${server.sent} samples`)
  asr.dispose()
})

// ---------------------------------------------------------------- Volcengine is as it was

test("Volcengine: the send pattern is what the streamer did before pacing existed (three chunks per tick, nothing carried)", async () => {
  const volc = declared.find((d) => d.id === "volc")!.pacing
  const { asr, server, rec } = await catchUp(volc, 0, 0)
  assert.deepEqual(rec.gaps, [])
  // The previous rule, verbatim: per tick, up to three whole chunks, while a whole chunk is waiting.
  let cursor = 0
  let end = 0
  const expected: number[] = []
  const actual: number[] = []
  // Live audio at 1x, a burst of audio that piled up while offline, and a stretch with nothing arriving.
  const arrivals = [...Array(30).fill(1600), 400_000, ...Array(80).fill(1600), ...Array(60).fill(0), 5000, 70_000, ...Array(40).fill(1600)]
  for (const n of arrivals) {
    end += n
    let sent = 0
    for (let i = 0; i < 3 && end - cursor >= CHUNK; i++) {
      cursor += CHUNK
      sent += CHUNK
    }
    expected.push(sent)
    const before = server.sent
    if (n > 0) asr.push(new Int16Array(n))
    asr.tick()
    actual.push(server.sent - before)
  }
  assert.deepEqual(actual, expected)
  asr.dispose()
})

test("Volcengine: a normal stop flushes the last fraction of a second at once, with no timer to wait for", async () => {
  const volc = declared.find((d) => d.id === "volc")!.pacing
  const server = new Server()
  const asr = new AsrStreamer(recorder().events, { manualTicks: true, finalTimeoutMs: 50 })
  asr.begin(0, server.connect, volc)
  await flush()
  asr.push(new Int16Array(0.5 * RATE))
  const ending = asr.end()
  await flush()
  assert.equal(server.sent, 0.5 * RATE)
  assert.equal(server.last, true)
  await ending
})

// ---------------------------------------------------------------- the bound on end()

test("a backlog the bound cannot flush is sent up to the bound, and the rest is an explicit gap with its own reason", { timeout: 20_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const server = new Server()
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true, flushMs: 5000 })
  asr.begin(0, server.connect, { maxRate: 1.25 })
  await flush()
  for (let i = 0; i < 30 * TICKS_PER_SECOND; i++) asr.push(new Int16Array(RATE / TICKS_PER_SECOND))
  const ending = asr.end()
  for (let i = 0; i < 200 && !server.last; i++) {
    await flush()
    t.mock.timers.tick(TICK_MS)
  }
  assert.equal(server.last, true, "the end of stream is still sent")
  server.finish()
  await ending
  // Five seconds at 1.25x: about 6.25 s of audio went out, to the chunk.
  assert.ok(server.sent >= 6.25 * RATE - 2 * CHUNK && server.sent <= 6.25 * RATE + 2 * CHUNK, `sent ${server.sent / RATE} s`)
  assert.equal(rec.gaps.length, 1)
  const [gap] = rec.gaps
  assert.equal(gap.code, "unsent")
  assert.equal(gap.startMs, (server.sent / RATE) * 1000, "the gap starts where the sending stopped")
  assert.equal(gap.endMs, 30_000, "and covers everything that was not sent")
  assert.equal(asr.currentState, "idle")
})

test("a backlog the bound allows is sent whole, with no gap", { timeout: 20_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const server = new Server()
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true })
  asr.begin(0, server.connect, { maxRate: 1.25 })
  await flush()
  // 45 s of backlog needs 36 s at 1.25x: inside the default bound.
  for (let i = 0; i < 45 * TICKS_PER_SECOND; i++) asr.push(new Int16Array(RATE / TICKS_PER_SECOND))
  const ending = asr.end()
  for (let i = 0; i < 1000 && !server.last; i++) {
    await flush()
    t.mock.timers.tick(TICK_MS)
  }
  server.finish()
  await ending
  assert.equal(server.sent, 45 * RATE)
  assert.deepEqual(rec.gaps, [])
})

test("the default bound covers a minute of backlog at the slowest declared rate, and not a full ring of it", () => {
  const slowest = Math.min(...declared.map((d) => d.pacing.maxRate))
  // A backlog is flushed at the rate, so the audio the bound covers is bound × rate.
  assert.ok((DEFAULT_FLUSH_MS / 1000) * slowest >= 60, "a minute of backlog fits")
  assert.ok((DEFAULT_FLUSH_MS / 1000) * slowest < 300, "a full ring does not")
})

test("a resumed recording cuts the flush short: the unsent part is a gap and end() returns at once", { timeout: 20_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const server = new Server()
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true })
  asr.begin(0, server.connect, { maxRate: 1.25 })
  await flush()
  for (let i = 0; i < 60 * TICKS_PER_SECOND; i++) asr.push(new Int16Array(RATE / TICKS_PER_SECOND))
  let done = false
  const ending = asr.end().then(() => (done = true))
  for (let i = 0; i < 20; i++) {
    await flush()
    t.mock.timers.tick(TICK_MS)
  }
  assert.equal(done, false, "still flushing")
  asr.interruptFlush()
  await flush()
  assert.equal(server.last, true)
  server.finish()
  await ending
  assert.equal(rec.gaps.length, 1)
  assert.equal(rec.gaps[0].code, "unsent")
  assert.equal(rec.gaps[0].endMs, 60_000)
  assert.ok(server.sent < 4 * RATE, `${server.sent / RATE} s sent in the two seconds before the cut`)
})

test("a connection lost during the flush ends it: the unsent part is a disconnected gap, and nothing throws", { timeout: 20_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const server = new Server()
  const rec = recorder()
  const asr = new AsrStreamer(rec.events, { manualTicks: true })
  asr.begin(0, server.connect, { maxRate: 1.25 })
  await flush()
  for (let i = 0; i < 30 * TICKS_PER_SECOND; i++) asr.push(new Int16Array(RATE / TICKS_PER_SECOND))
  const ending = asr.end()
  for (let i = 0; i < 5; i++) {
    await flush()
    t.mock.timers.tick(TICK_MS)
  }
  server.handlers!.onClose(new AsrError("断开", false))
  for (let i = 0; i < 3; i++) {
    await flush()
    t.mock.timers.tick(TICK_MS)
  }
  await ending
  assert.equal(server.last, false, "no end of stream on a dead connection")
  assert.equal(rec.gaps.length, 1)
  assert.equal(rec.gaps[0].code, "disconnected")
  assert.equal(rec.gaps[0].endMs, 30_000)
  assert.equal(asr.currentState, "idle")
})

// ---------------------------------------------------------------- the ring and the slowest rate

test("an outage up to the ring's length is recovered whole at the slowest declared rate; the rate only sets how long catching up takes", async () => {
  const slowest = Math.min(...declared.map((d) => d.pacing.maxRate))
  const { steps, asr, rec } = await catchUp({ maxRate: slowest }, 170, 0, 180)
  assert.deepEqual(rec.gaps, [])
  assert.equal(asr.backlogMs, 170_000 + 0, "nothing was sent while offline")
  for (let i = 0; i < 600 * TICKS_PER_SECOND && asr.backlogMs > 0; i++) {
    asr.push(new Int16Array(RATE / TICKS_PER_SECOND))
    asr.tick()
    assert.deepEqual(rec.gaps, [], "no overflow at any point of the catch-up")
  }
  assert.deepEqual(steps, [])
  // Live audio keeps arriving, so the backlog shrinks by (rate - 1) seconds per second: 170 s at 1.25x takes 680 s to clear.
  assert.ok(asr.backlogMs > 0, "still behind after 600 s")
  assert.ok(Math.abs(asr.backlogMs - (170_000 - (slowest - 1) * 600_000)) < 1000, `${asr.backlogMs} ms behind`)
  asr.dispose()
})

test("an outage longer than the ring loses its oldest part as an overflow gap, whatever the rate", async () => {
  const { rec } = await catchUp({ maxRate: 6 }, 200, 0, 180)
  assert.equal(lostMs(rec.gaps), 20_000)
  assert.ok(rec.gaps.every((g) => g.code === "overflow"))
})

test("at real time a backlog never shrinks, and a second outage on top of it overflows the ring", async () => {
  const { asr, rec } = await catchUp({ maxRate: 1 }, 100, 0, 180)
  for (let i = 0; i < 300 * TICKS_PER_SECOND; i++) {
    asr.push(new Int16Array(RATE / TICKS_PER_SECOND))
    asr.tick()
  }
  assert.ok(Math.abs(asr.backlogMs - 100_000) <= 200, `${asr.backlogMs} ms behind`)
  assert.equal(lostMs(rec.gaps), 0)
  // 100 s still unsent plus another 90 s offline is more than the ring holds.
  for (let i = 0; i < 90 * TICKS_PER_SECOND; i++) asr.push(new Int16Array(RATE / TICKS_PER_SECOND))
  assert.equal(lostMs(rec.gaps), 10_000)
  assert.ok(rec.gaps.every((g) => g.code === "overflow"))
  asr.dispose()
})
