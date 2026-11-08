import assert from "node:assert/strict"
import { test } from "node:test"
import type { AsrConnect, AsrUtterance } from "../src/asr/contract.ts"
import { MeetingSession, type SessionEnv } from "../src/meeting/session.ts"
import type { MeetingMeta } from "../src/meeting/types.ts"
import { DEFAULT_SETTINGS } from "../src/settings.ts"

type Resolution = { connect: AsrConnect | null; problem?: string }

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

function setup(resolve: () => Resolution) {
  const appended: string[] = []
  const env = {
    store: {
      path: (folder: string, name: string) => `${folder}/${name}`,
      appendTranscript: async (_path: string, text: string) => void appended.push(text),
      saveMeta: async () => undefined,
    },
    settings: () => DEFAULT_SETTINGS,
    asrConnector: resolve,
    llm: () => ({ problem: "未配置", model: "", target: "", complete: async () => "" }),
  } as unknown as SessionEnv
  const meta = { id: "m-1", title: "访谈", notePath: "访谈.md", createdAt: "2026-10-27T14:30:00+08:00", summaries: [], gaps: [], segments: [], lastCutoffMs: 0 } as unknown as MeetingMeta
  const session = new MeetingSession(env, "m", meta, "")
  // The audio side of a run needs a microphone; the recognizer side is what is under test.
  const run = {
    start: () => (session as unknown as { startAsr(): void }).startAsr(),
    end: () => (session as unknown as { asr: { end(): Promise<void> } }).asr.end(),
  }
  return { session, run, appended }
}

test("the recognizer is resolved at every run, so settings changed between runs apply to the next one", async () => {
  const a = connector()
  const b = connector()
  const plan: Resolution[] = [{ connect: a.connect }, { connect: null, problem: "未配置凭证" }, { connect: b.connect }]
  let calls = 0
  const { session, run } = setup(() => plan[calls++])

  run.start()
  await new Promise((r) => setImmediate(r))
  assert.equal(session.asrState, "live")
  const streamer = (session as unknown as { asr: unknown }).asr
  a.emit([{ text: "第一段。", startMs: 0, endMs: 800, final: true }])
  assert.equal(session.utterances.length, 1)
  await run.end()
  assert.equal(a.sent.connections, 1)

  // No recognizer this time: the card must read "disabled" with the reason, not keep showing "idle".
  run.start()
  assert.equal(session.asrState, "disabled")
  assert.equal(session.asrDetail, "未配置凭证")
  await run.end()

  // Credentials fixed: the next run connects, and the reason is gone.
  run.start()
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 3)
  assert.equal(session.asrState, "live")
  assert.equal(session.asrDetail, undefined)
  assert.equal(b.sent.connections, 1)
  assert.equal(a.sent.connections, 1)
  // The streamer, with its buffer and the finals it has seen, outlives the runs.
  assert.equal((session as unknown as { asr: unknown }).asr, streamer)
  await run.end()
})
