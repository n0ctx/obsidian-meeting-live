import assert from "node:assert/strict"
import { mock, test, type TestContext } from "node:test"
import { AsrError, type AsrConnect, type AsrUtterance } from "../src/asr/contract.ts"
import type { ResolvedLive } from "../src/asr/providers/registry.ts"
import { AudioCapture } from "../src/audio/capture.ts"
import { SegmentRecorder } from "../src/audio/recorder.ts"
import { MeetingSession, type SessionEnv } from "../src/meeting/session.ts"
import type { MeetingMeta } from "../src/meeting/types.ts"
import { DEFAULT_SETTINGS } from "../src/settings.ts"

/** Fast enough that one tick sends what the test buffered. */
const PACING = { maxRate: 6 }

/** A connector whose connections answer the end of stream at once and can be fed results by the test. */
function connector() {
  const sent = { connections: 0 }
  let emit: (utterances: AsrUtterance[]) => void = () => undefined
  const connect: AsrConnect = async (handlers) => {
    sent.connections++
    emit = (utterances) => handlers.onResult({ utterances }, false)
    return {
      connection: {
        sendAudio: (_pcm, last) => {
          if (last) handlers.onResult({ utterances: [] }, true)
        },
        close: () => undefined,
      },
    }
  }
  return { connect, sent, emit: (utterances: AsrUtterance[]) => emit(utterances) }
}

function setup(resolve: () => ResolvedLive, override: Partial<SessionEnv> = {}) {
  const env = {
    store: {
      path: (folder: string, name: string) => `${folder}/${name}`,
      audioFile: async (folder: string, _name: string | undefined, n: number, format: string) => `${folder}/audio/${n}.${format}`,
      fullPath: (path: string) => `/vault/${path}`,
      appendTranscript: async () => undefined,
      saveMeta: async () => undefined,
    },
    settings: () => ({ ...DEFAULT_SETTINGS, audioFormat: "wav" as const }),
    asr: resolve,
    llmConsented: () => true,
    llm: () => ({ problem: "未配置", model: "", target: "", complete: async () => "" }),
    claim: () => undefined,
    release: () => undefined,
    ...override,
  } as unknown as SessionEnv
  const meta = { id: "m-1", title: "访谈", notePath: "访谈.md", createdAt: "2026-10-27T14:30:00+08:00", summaries: [], gaps: [], segments: [], lastCutoffMs: 0 } as unknown as MeetingMeta
  return new MeetingSession(env, "m", meta, "")
}

const settle = () => new Promise((r) => setImmediate(r))

test("the recognizer is resolved at every run and each audio segment records the provider that heard it", async (t) => {
  // The microphone and the encoder are the parts that need a real device; the recognizer side is under test.
  t.mock.method(AudioCapture, "open", async () => ({ sampleRate: 16000, channels: 1, deviceLabel: "测试麦克风", close: async () => undefined }))
  t.mock.method(SegmentRecorder, "create", async () => ({ write: () => undefined, close: async () => undefined }))
  const a = connector()
  const b = connector()
  const plan: ResolvedLive[] = [
    { id: "volc", name: "火山引擎", connect: a.connect, pacing: PACING },
    { id: "volc", name: "火山引擎", connect: null, pacing: PACING, problem: "未配置凭证" },
    { id: "other", name: "其他服务", connect: b.connect, pacing: PACING },
  ]
  let calls = 0
  const session = setup(() => plan[calls++])

  await session.start()
  await settle()
  assert.equal(calls, 1)
  assert.equal(session.asrState, "live")
  assert.equal(session.asrName, "火山引擎")
  const streamer = (session as unknown as { asr: unknown }).asr
  a.emit([{ text: "第一段。", startMs: 0, endMs: 800, final: true }])
  assert.equal(session.utterances.length, 1)
  await session.pause()
  assert.equal(a.sent.connections, 1)

  // No recognizer this time: the card must read "disabled" with the reason, not keep showing "idle".
  await session.start()
  assert.equal(calls, 2)
  assert.equal(session.asrState, "disabled")
  assert.equal(session.asrDetail, "未配置凭证")
  await session.pause()

  // Credentials fixed and another provider chosen: the next run connects through it, and the reason is gone.
  await session.start()
  await settle()
  assert.equal(calls, 3)
  assert.equal(session.asrState, "live")
  assert.equal(session.asrDetail, undefined)
  assert.equal(session.asrName, "其他服务")
  assert.equal(b.sent.connections, 1)
  assert.equal(a.sent.connections, 1)
  // The streamer, with its buffer and the finals it has seen, outlives the runs.
  assert.equal((session as unknown as { asr: unknown }).asr, streamer)
  await session.pause()
  await session.stop()

  assert.deepEqual(session.meta.segments.map((s) => s.asrProvider), ["volc", undefined, "other"])
  assert.equal("asrProvider" in session.meta.segments[1], false)
})

test("retry now in the failed state resolves the recognizer afresh and loses neither the buffer nor the finals", async (t) => {
  t.mock.method(AudioCapture, "open", async () => ({ sampleRate: 16000, channels: 1, deviceLabel: "测试麦克风", close: async () => undefined }))
  t.mock.method(SegmentRecorder, "create", async () => ({ write: () => undefined, close: async () => undefined }))
  const rejected: ResolvedLive = {
    id: "volc",
    name: "火山引擎",
    connect: async () => {
      throw new AsrError("鉴权失败", true)
    },
    pacing: PACING,
  }
  const sent: number[] = []
  const fixed: ResolvedLive = {
    id: "other",
    name: "其他服务",
    pacing: PACING,
    connect: async (handlers) => ({
      connection: {
        sendAudio: (pcm, last) => {
          sent.push(pcm.length)
          if (last) handlers.onResult({ utterances: [] }, true)
        },
        close: () => undefined,
      },
    }),
  }
  const plan = [rejected, fixed]
  let calls = 0
  const session = setup(() => plan[Math.min(calls++, plan.length - 1)])
  await session.start()
  await settle()
  assert.equal(session.asrState, "failed")
  assert.equal(calls, 1)
  const streamer = (session as unknown as { asr: { push(pcm: Int16Array): void; tick(): void } }).asr
  streamer.push(new Int16Array(16000))

  session.retryAsr()
  await settle()
  assert.equal(calls, 2, "the recognizer is resolved again")
  assert.equal(session.asrState, "live")
  assert.equal(session.asrName, "其他服务")
  assert.equal(session.meta.segments[0].asrProvider, "other")
  assert.equal((session as unknown as { asr: unknown }).asr, streamer)
  streamer.tick()
  assert.ok(sent.length > 0, "audio from before the retry is sent")
  await session.pause()
  await session.stop()
})

test("retry now with settings that no longer resolve to a recognizer shows why and keeps the old one", async (t) => {
  t.mock.method(AudioCapture, "open", async () => ({ sampleRate: 16000, channels: 1, deviceLabel: "测试麦克风", close: async () => undefined }))
  t.mock.method(SegmentRecorder, "create", async () => ({ write: () => undefined, close: async () => undefined }))
  const rejected: ResolvedLive = {
    id: "volc",
    name: "火山引擎",
    connect: async () => {
      throw new AsrError("鉴权失败", true)
    },
    pacing: PACING,
  }
  const plan: ResolvedLive[] = [rejected, { id: "volc", name: "火山引擎", connect: null, pacing: PACING, problem: "未配置凭证" }]
  let calls = 0
  const session = setup(() => plan[calls++])
  await session.start()
  await settle()
  session.retryAsr()
  await settle()
  assert.equal(session.asrState, "failed")
  assert.equal(session.asrDetail, "未配置凭证")
  await session.pause()
  await session.stop()
})

const mockDevice = (t: TestContext, closeCapture: () => Promise<void> = async () => undefined) => {
  t.mock.method(AudioCapture, "open", async () => ({ sampleRate: 16000, channels: 1, deviceLabel: "测试麦克风", close: closeCapture }) as unknown as AudioCapture)
}
const idle: ResolvedLive = { id: "volc", name: "火山引擎", connect: null, pacing: PACING, problem: "未配置凭证" }

test("when the recorder fails and no new file can be opened, the card is told instead of a rejection going unseen", async (t) => {
  mockDevice(t)
  let created = 0
  t.mock.method(SegmentRecorder, "create", async () => {
    if (created++ > 0) throw new Error("磁盘已满")
    return { write: () => undefined, close: async () => undefined }
  })
  const session = setup(() => idle)
  await session.start()
  ;(session as unknown as { onRecorderError(e: Error): void }).onRecorderError(new Error("编码失败"))
  await settle()
  assert.match(session.error ?? "", /磁盘已满/)
  assert.equal(created, 2)
  assert.equal(session.status, "paused", "frames are no longer saved, so the status says so")
})

test("a capture that will not close does not keep the recording file open or recognition running, and the card says why", async (t) => {
  mockDevice(t, async () => {
    throw new Error("设备忙")
  })
  let recorderClosed = false
  t.mock.method(SegmentRecorder, "create", async () => ({ write: () => undefined, close: async () => void (recorderClosed = true) }))
  const session = setup(() => idle)
  await session.start()
  await (session as unknown as { onDeviceLost(): Promise<void> }).onDeviceLost()
  assert.equal(session.status, "paused")
  assert.equal(recorderClosed, true)
  assert.match(session.error ?? "", /设备忙/)
  assert.equal(session.asrState, "disabled")
})

test("the summary queue, which callers start and do not wait for, never rejects", async () => {
  const session = setup(() => idle, {
    llm: () => {
      throw new Error("设置读取失败")
    },
  })
  session.meta.summaries.push({ index: 1, startMs: 0, endMs: 1000, trigger: "manual", status: "pending", attempts: 0, utterances: [] })
  const logged = mock.method(console, "error", () => undefined)
  try {
    await session.runQueue()
    assert.equal(logged.mock.calls.filter((c) => c.arguments[0] === "[meeting-live]").length, 1)
  } finally {
    logged.mock.restore()
  }
})

test("resuming does not wait for a paused run to send its backlog: the unsent audio becomes a gap and recording restarts", { timeout: 15_000 }, async (t) => {
  mockDevice(t)
  t.mock.method(SegmentRecorder, "create", async () => ({ write: () => undefined, close: async () => undefined }))
  const slow = connector()
  const session = setup(() => ({ id: "slow", name: "慢速服务", connect: slow.connect, pacing: { maxRate: 1.25 } }))
  await session.start()
  await settle()
  // A minute of audio that has not been sent: at 1.25x, flushing it would take 48 s with the microphone closed.
  ;(session as unknown as { asr: { push(pcm: Int16Array): void } }).asr.push(new Int16Array(60 * 16000))
  const pausing = session.pause()
  const started = Date.now()
  await session.start()
  await pausing
  assert.ok(Date.now() - started < 3000, `resuming waited ${Date.now() - started} ms`)
  assert.equal(session.status, "recording")
  assert.ok(session.meta.gaps.some((g) => g.code === "unsent"), "the unsent part is recorded as a gap")
  await session.pause()
  await session.stop()
})

test("an overview past its limits is asked to fix itself once, and its to-dos and open questions never exceed five", async () => {
  const items = (n: number, word: string) => Array.from({ length: n }, (_, i) => ({ text: `${word}${i + 1}`, t: "00:00:01" }))
  const overview = (todos: number, open: number) => JSON.stringify({ title: "", paragraphs: [{ topic: "融资", text: "额度待定", t: "00:00:01" }], todos: items(todos, "待办"), open: items(open, "问题") })
  const replies = [overview(8, 7), overview(6, 3)]
  const asked: unknown[][] = []
  const session = setup(() => ({ id: "x", name: "x", connect: null, pacing: PACING, problem: "无" }), {
    llm: () => ({ model: "m", target: "t", complete: async (messages: unknown[]) => (asked.push(messages), replies.shift() ?? "") }),
    store: { saveMeta: async () => undefined, editNote: async () => undefined, readTranscript: async () => "", write: async () => undefined },
  } as unknown as Partial<SessionEnv>)
  const stage = { index: 1, startMs: 0, endMs: 60_000, trigger: "auto", status: "done", attempts: 1, utterances: [], content: { title: "融资", paragraphs: [{ topic: "融资", text: "额度待定", unverified: [] }], todos: [], open: [] } }
  session.meta.summaries.push(stage as never)
  await session.updateOverview()
  assert.equal(asked.length, 2, "one retry")
  assert.match(JSON.stringify(asked[1].at(-1)), /8 to-dos; keep at most 5.*7 open questions/)
  const content = session.meta.overview!.content!
  assert.deepEqual(content.todos.map((p) => p.text), ["待办1", "待办2", "待办3", "待办4", "待办5"], "still over after the retry: the first five are kept")
  assert.equal(content.open.length, 3)
})
