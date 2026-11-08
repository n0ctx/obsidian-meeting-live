import assert from "node:assert/strict"
import { test } from "node:test"
import type { ChatMessage, LlmClient } from "../src/llm/client.ts"
import { estimateTokens, messagesTokens, writeMinutes } from "../src/llm/contextGuard.ts"
import { buildMinutesMessages, type MinutesInput } from "../src/llm/minutes.ts"
import { formatClock, type SummaryRecord, type Utterance } from "../src/meeting/types.ts"

/** A meeting of `count` lines, each `chars` characters long, one every ten seconds. */
const meeting = (count: number, chars = 40): Utterance[] =>
  Array.from({ length: count }, (_, i) => ({ startMs: i * 10_000, endMs: i * 10_000 + 9000, text: `第${i}句`.padEnd(chars, "话") }))

const input = (utterances: Utterance[], extra: Partial<MinutesInput> = {}): MinutesInput => ({ title: "访谈", date: "2026-10-27", utterances, summaries: [], notes: [], ...extra })

const isMap = (messages: ChatMessage[]) => messages[0].content.startsWith("You summarize one stage")

/** Answers condensing requests with one point per part, citing the part's first line, and records every request. */
function fakeLlm(limit: number, options: { map?: (messages: ChatMessage[]) => string; reduce?: string } = {}) {
  const calls: { messages: ChatMessage[]; json: boolean }[] = []
  const llm: LlmClient = {
    problem: undefined,
    model: "fake",
    target: "fake",
    inputLimit: limit,
    complete: async (messages, asked) => {
      calls.push({ messages, json: !!asked?.json })
      if (!isMap(messages)) return options.reduce ?? "纪要正文"
      if (options.map) return options.map(messages)
      const first = /^\[(\d\d:\d\d:\d\d)\] (.*)$/m.exec(messages[1].content)!
      return JSON.stringify({ title: "", paragraphs: [{ topic: "话题", text: `概述：${first[2].slice(0, 8)}`, t: first[1] }], todos: [], open: [] })
    },
  }
  return { llm, calls, maps: () => calls.filter((c) => isMap(c.messages)), reduces: () => calls.filter((c) => !isMap(c.messages)) }
}

test("token estimates lean high and count CJK characters one by one", () => {
  assert.equal(estimateTokens(""), 0)
  assert.equal(estimateTokens("你好世界"), 4)
  assert.equal(estimateTokens("hello world"), 4)
  assert.ok(estimateTokens("收入3亿元") > estimateTokens("revenue"))
  assert.equal(messagesTokens([{ role: "user", content: "你好" }]), 6)
})

test("a request within the limit goes out unchanged, in one call", async () => {
  const { llm, calls } = fakeLlm(1_000_000)
  const messages = buildMinutesMessages("提示", input(meeting(5)))
  assert.equal(await writeMinutes(llm, "提示", input(meeting(5)), { focus: "" }), "纪要正文")
  assert.deepEqual(calls.map((c) => c.messages), [messages])
  assert.equal(calls[0].json, false)
})

test("a transcript over the limit is condensed part by part, then the notes are written from the parts and the manual notes", async () => {
  const utterances = meeting(120)
  const limit = 2500
  const whole = messagesTokens(buildMinutesMessages("提示", input(utterances)))
  assert.ok(whole > limit * 1.5, "the fixture must not fit")
  const { llm, maps, reduces } = fakeLlm(limit)
  const progress: string[] = []
  const notes = [{ path: "速记.md", content: "李总：订单 1.5 亿" }]
  const text = await writeMinutes(llm, "提示", input(utterances, { notes }), { focus: "关注订单", onProgress: (p) => progress.push(p) })
  assert.equal(text, "纪要正文")

  // Map: every part is a stage-summary request that fits, uses the user's focus, asks for JSON, and the parts cover the transcript in order.
  assert.ok(maps().length >= 2)
  let next = 0
  for (const { messages, json } of maps()) {
    assert.ok(messagesTokens(messages) <= limit, "a part must fit")
    assert.equal(json, true)
    assert.match(messages[0].content, /关注订单/)
    const lines = [...messages[1].content.matchAll(/^\[(\d\d:\d\d:\d\d)\] /gm)].map((m) => m[1])
    assert.equal(lines[0], formatClock(next * 10_000, true), "parts follow one another with no line skipped")
    next += lines.length
  }
  assert.equal(next, 120, "every line went into exactly one part")

  // Reduce: one request that fits, from the condensed lines (with their timestamps) and the manual notes, and no raw transcript.
  assert.equal(reduces().length, 1)
  const reduce = reduces()[0].messages
  assert.ok(messagesTokens(reduce) <= limit)
  assert.match(reduce[1].content, /## Manual notes: 速记\.md\n李总：订单 1\.5 亿/)
  assert.match(reduce[1].content, /## Transcript \(condensed\)/)
  assert.match(reduce[1].content, /\[00:00:00\] 话题: 概述：第0句/)
  assert.doesNotMatch(reduce[1].content, /第5句话/)
  assert.equal(reduce[0].content, buildMinutesMessages("提示", input([]))[0].content)
  assert.equal(progress[0], `正在分段压缩转写（1/${maps().length}）`)
  assert.equal(progress.at(-1), "正在根据压缩后的内容撰写纪要")
})

test("condensed lines keep the timestamps of the lines they cite, and an unreadable reply is kept whole at the part's start", async () => {
  const { llm, reduces } = fakeLlm(2500, {
    map: (messages) => {
      const stamps = [...messages[1].content.matchAll(/^\[(\d\d:\d\d:\d\d)\] /gm)].map((m) => m[1])
      if (stamps[0] === "00:00:00") return "抱歉，我无法完成这个请求"
      return JSON.stringify({ title: "", paragraphs: [{ topic: "", text: "中段要点", t: stamps[2] }], todos: [{ text: "跟进订单", t: stamps[1] }], open: [{ text: "口径未定" }] })
    },
  })
  await writeMinutes(llm, "提示", input(meeting(120)), { focus: "" })
  const body = reduces()[0].messages[1].content
  assert.match(body, /\[00:00:00\] 抱歉，我无法完成这个请求/)
  assert.match(body, /\[\d\d:\d\d:\d\d\] To-do: 跟进订单/)
  assert.match(body, /\[\d\d:\d\d:\d\d\] Open: 口径未定/)
  // Citations land on transcript lines: every stamp in the condensed text is the start of a real line.
  const real = new Set(meeting(120).map((u) => formatClock(u.startMs, true)))
  const cited = [...body.split("## Transcript (condensed)")[1].matchAll(/^\[(\d\d:\d\d:\d\d)\]/gm)].map((m) => m[1])
  assert.ok(cited.length > 3)
  for (const stamp of cited) assert.ok(real.has(stamp), stamp)
})

test("stage summaries give way once the transcript is condensed, if they would still not fit", async () => {
  const summary = (index: number): SummaryRecord => ({
    index, startMs: 0, endMs: 60_000, trigger: "auto", status: "done", attempts: 1, utterances: [],
    content: { title: "阶段", paragraphs: [{ topic: "话题", text: "摘要".padEnd(1200, "要"), t: 0, unverified: [] }], todos: [], open: [] },
  })
  const { llm, reduces } = fakeLlm(2500)
  await writeMinutes(llm, "提示", input(meeting(120), { summaries: [summary(1), summary(2), summary(3)] }), { focus: "" })
  assert.doesNotMatch(reduces()[0].messages[1].content, /Stage summaries/)
  // Small enough to fit beside the condensed parts: kept.
  const kept = fakeLlm(6000)
  await writeMinutes(kept.llm, "提示", input(meeting(150), { summaries: [{ ...summary(1), content: { ...summary(1).content!, paragraphs: [{ topic: "话题", text: "短摘要", t: 0, unverified: [] }] } }] }), { focus: "" })
  assert.match(kept.reduces()[0].messages[1].content, /Stage summaries \(for cross-checking only\)[^]*短摘要/)
})

test("condensed parts that are still too long are condensed again", async () => {
  // Each part comes back as many lines, so the first round does not shrink the material enough.
  const { llm, maps, reduces } = fakeLlm(1800, {
    map: (messages) => {
      const stamps = [...messages[1].content.matchAll(/^\[(\d\d:\d\d:\d\d)\] /gm)].map((m) => m[1])
      const paragraphs = stamps.map((t, i) => ({ topic: "", text: i % 2 === 0 ? `要点${t}`.padEnd(30, "点") : "", t })).filter((p) => p.text)
      return JSON.stringify({ title: "", paragraphs, todos: [], open: [] })
    },
  })
  await writeMinutes(llm, "提示", input(meeting(200, 30)), { focus: "" })
  const first = maps().filter((c) => /\[00:00:00\]/.test(c.messages[1].content)).length
  assert.ok(first >= 2, "the first line is sent to a condensing call in more than one round")
  assert.equal(reduces().length, 1)
  assert.ok(messagesTokens(reduces()[0].messages) <= 1800)
})

test("a limit too small for the prompt and the notes, or material that will not shrink, fails clearly and spends nothing", async () => {
  const tiny = fakeLlm(300)
  await assert.rejects(writeMinutes(tiny.llm, "提示", input(meeting(30)), { focus: "" }), /输入上限.*太小/)
  assert.equal(tiny.calls.length, 0)

  const heavyNotes = fakeLlm(2500)
  await assert.rejects(writeMinutes(heavyNotes.llm, "提示", input(meeting(60), { notes: [{ path: "长笔记.md", content: "笔".repeat(4000) }] }), { focus: "" }), /输入上限/)
  assert.equal(heavyNotes.calls.length, 0)

  // A condenser that returns more than it was given never gets the request under the limit.
  const growing = fakeLlm(2500, { map: (messages) => JSON.stringify({ title: "", paragraphs: [...messages[1].content.matchAll(/^\[(\d\d:\d\d:\d\d)\] /gm)].map((m) => ({ topic: "", text: "膨胀".padEnd(80, "胀"), t: m[1] })), todos: [], open: [] }) })
  await assert.rejects(writeMinutes(growing.llm, "提示", input(meeting(60)), { focus: "" }), /压缩 3 次后仍超过/)
  assert.equal(growing.reduces().length, 0)
})
