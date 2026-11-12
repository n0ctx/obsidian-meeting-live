import assert from "node:assert/strict"
import { test } from "node:test"
import { acceptFixes, correctionTerms } from "../src/llm/correction.ts"
import type { ChatMessage } from "../src/llm/client.ts"
import { applyEdit, type TextEdit } from "../src/meeting/noteSummary.ts"
import { MeetingSession, type SessionEnv } from "../src/meeting/session.ts"
import { linkTranscript, utteranceLine } from "../src/meeting/transcriptFormat.ts"
import type { MeetingMeta, Utterance } from "../src/meeting/types.ts"
import { DEFAULT_SETTINGS } from "../src/settings.ts"

const lines: Utterance[] = [
  { startMs: 1000, endMs: 4000, text: "兰箭今年收入预计三亿。" },
  { startMs: 5000, endMs: 8000, text: "张帆说产能还要扩。" },
]

const isCorrection = (messages: ChatMessage[]) => messages[0].content.startsWith("You check a meeting's speech-to-text transcript")
const SUMMARY = '{"title":"阶段","paragraphs":[{"topic":"收入","text":"收入三亿","t":"00:00:01"}],"todos":[],"open":[]}'

/** A meeting with one pending stage over `lines`, whose model answers the correction prompt with `fixes` and the summary with SUMMARY. */
function setup(fixes: () => string, hotwords = "蓝箭\n章帆") {
  const prompts: ChatMessage[][] = []
  // The transcript lines already link back to the note, as they do once a summary has been published.
  const files: Record<string, string> = {
    "m/原始转写.md": linkTranscript(lines.map((u) => utteranceLine(u, "访谈")).join(""), () => "访谈#^m-1-s0"),
    "访谈.md": "# 访谈\n\n```meeting-live\nid: m-1\n```\n",
  }
  const env = {
    store: {
      path: (folder: string, name: string) => `${folder}/${name}`,
      saveMeta: async () => undefined,
      readNote: async (path: string) => files[path] ?? "",
      readTranscript: async (path: string) => files[path] ?? "",
      write: async (path: string, content: string) => void (files[path] = content),
      editNote: async (path: string, edit: (content: string) => TextEdit | undefined) => {
        const change = edit(files[path] ?? "")
        if (change) files[path] = applyEdit(files[path] ?? "", change)
      },
    },
    settings: () => ({ ...DEFAULT_SETTINGS, hotwords, transcriptCleanup: "names" }),
    llmConsented: () => true,
    llm: () => ({
      problem: undefined,
      model: "fake",
      target: "fake",
      inputLimit: 1_000_000,
      complete: async (messages: ChatMessage[]) => {
        prompts.push(messages)
        if (isCorrection(messages)) return fixes()
        return messages[0].content.startsWith("You keep a running overview") ? '{"paragraphs":[],"todos":[],"open":[]}' : SUMMARY
      },
    }),
  } as unknown as SessionEnv
  const meta = {
    id: "m-1",
    title: "访谈",
    notePath: "访谈.md",
    createdAt: "2026-11-09T14:30:00+08:00",
    summaries: [{ index: 1, startMs: 0, endMs: 300_000, trigger: "auto", status: "pending", attempts: 0, utterances: [1000, 5000] }],
    gaps: [],
    segments: [],
    lastCutoffMs: 300_000,
  } as unknown as MeetingMeta
  const session = new MeetingSession(env, "m", meta, files["m/原始转写.md"])
  return { session, prompts, files }
}

test("the window is corrected first and summarized after, with the same model; the summary reads the corrected text", async () => {
  const { session, prompts, files } = setup(() => '{"fixes":[{"from":"兰箭","to":"蓝箭"},{"from":"张帆","to":"章帆"}]}')
  await session.runQueue()
  assert.deepEqual(prompts.map(isCorrection).slice(0, 2), [true, false])
  assert.match(prompts[0][1].content, /Known terms:\n- 蓝箭\n- 章帆/)
  assert.match(prompts[1][1].content, /蓝箭今年收入预计三亿。[^]*章帆说产能还要扩。/)
  assert.doesNotMatch(prompts[1][1].content, /兰箭|张帆/)
  assert.deepEqual(session.utterances.map((u) => u.text), ["蓝箭今年收入预计三亿。", "章帆说产能还要扩。"])
  assert.match(files["m/原始转写.md"], /^\[\[访谈#\^m-1-s\d\|00:00:01\]\] 蓝箭今年收入预计三亿。 \^t1000-4000$/m)
  assert.equal(session.meta.summaries[0].status, "done")
})

test("the check reads the note when it runs, so a name written just before counts even if the note watcher has not fired yet", async () => {
  const { session, prompts, files } = setup(() => '{"fixes":[]}', "蓝箭")
  await session.correctTranscript()
  files["访谈.md"] += "\n参会：[[章帆]]\n"
  await session.runQueue()
  assert.match(prompts[0][1].content, /Known terms:\n- 蓝箭\n- 章帆/)
})

test("a fix that changes a number, aims outside the known terms or replaces text the window does not have is dropped", () => {
  const terms = correctionTerms({ hotwords: ["蓝箭", "四亿"], scene: "参会人章帆" }, [[{ from: "甲木", to: "甲沐" }]])
  const proposed = [
    { from: "三亿", to: "四亿" },
    { from: "兰箭", to: "蓝箭科技" },
    { from: "白箭", to: "蓝箭" },
    { from: "张帆", to: "章帆" },
    { from: "兰箭", to: "蓝箭" },
    { from: "在", to: "蓝箭" },
    { from: "张帆说", to: "帆" },
  ]
  assert.deepEqual(acceptFixes(proposed, lines, terms), [
    { from: "张帆", to: "章帆" },
    { from: "兰箭", to: "蓝箭" },
  ])
})

test("a failed or unreadable check leaves the text as it was and the summary still goes out; without known terms nothing is asked", async () => {
  const failed = setup(() => {
    throw new Error("网络中断")
  })
  await failed.session.runQueue()
  assert.equal(failed.session.meta.summaries[0].status, "done")
  assert.equal(failed.session.meta.summaries[0].attempts, 1, "the check failing does not count against the summary")
  assert.equal(failed.session.utterances[0].text, "兰箭今年收入预计三亿。")

  const garbled = setup(() => "不是 JSON")
  await garbled.session.runQueue()
  assert.equal(garbled.session.utterances[0].text, "兰箭今年收入预计三亿。")
  assert.equal(garbled.session.meta.summaries[0].status, "done")

  const bare = setup(() => assert.fail("asked without terms"), "")
  await bare.session.runQueue()
  assert.ok(!bare.prompts.some(isCorrection))
  assert.equal(bare.session.meta.summaries[0].status, "done")
})
