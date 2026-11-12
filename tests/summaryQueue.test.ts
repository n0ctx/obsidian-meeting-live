import assert from "node:assert/strict"
import { test } from "node:test"
import type { ChatMessage, CompleteOptions } from "../src/llm/client.ts"
import { applyEdit, type TextEdit } from "../src/meeting/noteSummary.ts"
import { MeetingSession, type SessionEnv } from "../src/meeting/session.ts"
import type { MeetingMeta, SummaryRecord } from "../src/meeting/types.ts"
import { utteranceLine } from "../src/meeting/transcriptFormat.ts"
import { DEFAULT_SETTINGS } from "../src/settings.ts"

const transcript = [{ startMs: 1000, endMs: 4000, text: "今年收入预计 3.2 亿元。" }, { startMs: 302_000, endMs: 305_000, text: "毛利率百分之四十二。" }].map((u) => utteranceLine(u)).join("")

function stage(index: number, startMs: number, utterance: number): SummaryRecord {
  return { index, startMs, endMs: startMs + 300_000, trigger: "auto", status: "pending", attempts: 0, utterances: [utterance] }
}

function setup(reply: (messages: ChatMessage[]) => string) {
  const prompts: ChatMessage[][] = []
  const options: (CompleteOptions | undefined)[] = []
  const files: Record<string, string> = { "m/原始转写.md": transcript, "访谈.md": "# 访谈\n\n```meeting-live\nid: m-1\n```\n\n我的速记\n" }
  const env = {
    store: {
      path: (folder: string, name: string) => `${folder}/${name}`,
      saveMeta: async () => undefined,
      readTranscript: async (path: string) => files[path] ?? "",
      write: async (path: string, content: string) => void (files[path] = content),
      editNote: async (path: string, edit: (content: string) => TextEdit | undefined) => {
        const change = edit(files[path] ?? "")
        if (change) files[path] = applyEdit(files[path] ?? "", change)
      },
    },
    // The stages are not tidied here: these tests are about summaries and the overview (see llmCorrection.test.ts).
    settings: () => ({ ...DEFAULT_SETTINGS, transcriptCleanup: "off" }),
    llmConsented: () => true,
    llm: () => ({
      problem: undefined,
      model: "fake",
      target: "fake",
      inputLimit: 1_000_000,
      complete: async (messages: ChatMessage[], asked?: CompleteOptions) => {
        prompts.push(messages)
        options.push(asked)
        return reply(messages)
      },
    }),
  } as unknown as SessionEnv
  const meta = { id: "m-1", title: "访谈", notePath: "访谈.md", createdAt: "2026-10-27T14:30:00+08:00", summaries: [stage(1, 0, 1000), stage(2, 300_000, 302000)], gaps: [], segments: [], lastCutoffMs: 600_000 } as unknown as MeetingMeta
  const session = new MeetingSession(env, "m", meta, transcript)
  return { session, prompts, options, files }
}

const isOverview = (messages: ChatMessage[]) => messages[0].content.startsWith("You keep a running overview")

test("each finished stage is merged into the overview, which the next stage sees as context", async () => {
  let overviews = 0
  const { session, prompts, options, files } = setup((messages) => {
    if (!isOverview(messages)) return '{"title":"阶段","paragraphs":[{"topic":"收入","text":"收入 3.2 亿元","t":"00:00:01"}],"todos":[],"open":[]}'
    overviews++
    return `{"paragraphs":[{"topic":"经营","text":"第 ${overviews} 版概览","t":"00:00:01"}],"todos":[{"text":"核对口径"}],"open":[]}`
  })
  await session.runQueue()
  assert.deepEqual(prompts.map(isOverview), [false, true, false, true])
  assert.deepEqual(options.map((o) => o?.json), [true, true, true, true], "stage summaries and overviews ask for a JSON reply")
  assert.ok(options.every((o) => typeof o?.usage === "function"), "and their usage is counted")
  assert.match(prompts[2][1].content, /overview so far \(context only\):\n经营: 第 1 版概览 \[00:00:01\]/)
  assert.match(prompts[3][1].content, /Current overview:\n经营: 第 1 版概览[^]*New stage summaries:\nStage 2 /)
  assert.deepEqual(session.meta.overview?.stages, [1, 2])
  assert.equal(session.meta.overview?.content?.paragraphs[0].text, "第 2 版概览")
  await new Promise((r) => setTimeout(r, 0))
  const note = files["访谈.md"]
  assert.match(note, /^```\n\n%% meeting-live-summary m-1 %%\n\nAI 阶段摘要 · 截至 10:00 · /m)
  assert.ok(note.indexOf("- **经营**：第 2 版概览") < note.indexOf("### 阶段 · "))
  assert.ok(note.lastIndexOf("### 阶段 · ") < note.indexOf("%% /meeting-live-summary m-1 %%"))
  assert.match(note, /%% \/meeting-live-summary m-1 %%\n\n我的速记\n$/)
  assert.equal(note.match(/AI 阶段摘要/g)?.length, 1)
  // The first line of each stage carries its anchor; the transcript times point at the stage or point citing them.
  assert.match(note, /^\*\*收入\*\* \[\[[^\]]*\]\]\n收入 3\.2 亿元 \^m-1-s1$/m)
  assert.match(files["m/原始转写.md"], /^\[\[访谈#\^m-1-s1\|00:00:01\]\] 今年收入/m)
  assert.match(files["m/原始转写.md"], /^\[\[访谈#\^m-1-s2\|00:05:02\]\] 毛利率/m)
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
