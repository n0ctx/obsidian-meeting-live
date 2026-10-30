import assert from "node:assert/strict"
import { test } from "node:test"
import type { ChatMessage } from "../src/llm/client.ts"
import { MeetingSession, type SessionEnv } from "../src/meeting/session.ts"
import type { MeetingMeta, SummaryRecord } from "../src/meeting/types.ts"
import { utteranceLine } from "../src/meeting/transcriptFormat.ts"
import { DEFAULT_SETTINGS } from "../src/settings.ts"

const transcript = [{ startMs: 1000, endMs: 4000, text: "今年收入预计 3.2 亿元。" }, { startMs: 302_000, endMs: 305_000, text: "毛利率百分之四十二。" }].map(utteranceLine).join("")

function stage(index: number, startMs: number, utterance: number): SummaryRecord {
  return { index, startMs, endMs: startMs + 300_000, trigger: "auto", status: "pending", attempts: 0, utterances: [utterance] }
}

function setup(reply: (messages: ChatMessage[]) => string) {
  const prompts: ChatMessage[][] = []
  const files: Record<string, string> = {}
  const env = {
    store: {
      path: (folder: string, name: string) => `${folder}/${name}`,
      saveMeta: async () => undefined,
      writeSummaries: async (_folder: string, markdown: string) => void (files.summaries = markdown),
    },
    settings: () => DEFAULT_SETTINGS,
    llm: () => ({
      problem: undefined,
      model: "fake",
      target: "fake",
      complete: async (messages: ChatMessage[]) => {
        prompts.push(messages)
        return reply(messages)
      },
    }),
  } as unknown as SessionEnv
  const meta = { title: "访谈", summaries: [stage(1, 0, 1000), stage(2, 300_000, 302000)], gaps: [], segments: [], lastCutoffMs: 600_000 } as unknown as MeetingMeta
  const session = new MeetingSession(env, "m", meta, transcript)
  return { session, prompts, files }
}

const isOverview = (messages: ChatMessage[]) => messages[0].content.startsWith("You keep a running overview")

test("each finished stage is merged into the overview, which the next stage sees as context", async () => {
  let overviews = 0
  const { session, prompts, files } = setup((messages) => {
    if (!isOverview(messages)) return '{"title":"阶段","paragraphs":[{"topic":"收入","text":"收入 3.2 亿元","t":"00:00:01"}],"todos":[],"open":[]}'
    overviews++
    return `{"paragraphs":[{"topic":"经营","text":"第 ${overviews} 版概览","t":"00:00:01"}],"todos":[{"text":"核对口径"}],"open":[]}`
  })
  await session.runQueue()
  assert.deepEqual(prompts.map(isOverview), [false, true, false, true])
  assert.match(prompts[2][1].content, /overview so far \(context only\):\n经营: 第 1 版概览 \[00:00:01\]/)
  assert.match(prompts[3][1].content, /Current overview:\n经营: 第 1 版概览[^]*New stage summaries:\nStage 2 /)
  assert.deepEqual(session.meta.overview?.stages, [1, 2])
  assert.equal(session.meta.overview?.content?.paragraphs[0].text, "第 2 版概览")
  assert.equal(session.overviewThroughMs, 600_000)
  await new Promise((r) => setTimeout(r, 0))
  assert.ok(files.summaries.indexOf("## 会议概览 · 截至 00:10:00") < files.summaries.indexOf("## 阶段 1"))
})

test("a failed overview update keeps the previous overview and a retry merges every stage left out", async () => {
  let fail = false
  const { session, prompts } = setup((messages) => {
    if (!isOverview(messages)) return '{"title":"","paragraphs":[{"topic":"收入","text":"收入 3.2 亿元"}],"todos":[],"open":[]}'
    if (fail) throw new Error("网络中断")
    fail = true
    return '{"paragraphs":[{"topic":"经营","text":"第一版"}],"todos":[],"open":[]}'
  })
  await session.runQueue()
  assert.deepEqual(session.meta.overview?.stages, [1])
  assert.equal(session.meta.overview?.error, "网络中断")
  assert.equal(session.meta.overview?.content?.paragraphs[0].text, "第一版")
  assert.deepEqual(session.overviewBacklog.map((s) => s.index), [2])

  fail = false
  const before = prompts.length
  await session.updateOverview()
  assert.equal(prompts.length, before + 1)
  assert.deepEqual(session.meta.overview?.stages, [1, 2])
  assert.equal(session.meta.overview?.error, undefined)
})
