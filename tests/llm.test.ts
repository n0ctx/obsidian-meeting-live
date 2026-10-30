import assert from "node:assert/strict"
import { test } from "node:test"
import { chat, chatCompletionsUrl, chatRequestBody, extractCompletionText } from "../src/llm/client.ts"
import { buildMinutesMessages, stripMeetingBlocks } from "../src/llm/minutes.ts"
import { buildOverviewMessages, buildSummaryMessages, overviewMarkdown, parseSummary, summaryMarkdown, unverifiedNumbers, upgradeSummaries } from "../src/llm/summary.ts"
import { dueCutoff, uncovered } from "../src/meeting/schedule.ts"
import type { MeetingMeta, SummaryRecord, Utterance } from "../src/meeting/types.ts"

const utterances: Utterance[] = [
  { startMs: 1000, endMs: 4000, text: "今年收入预计 3.2 亿元，去年 2.1 亿。" },
  { startMs: 65_000, endMs: 70_000, text: "毛利率百分之四十二，在手订单 1.5 亿。" },
]

test("summary parsing reads paragraphs and lists, snaps citations, flags unverified numbers, tolerates fences", () => {
  const raw = '```json\n{"title":"收入与订单","paragraphs":[{"topic":"收入","text":"今年预计收入 3.2 亿元，高于去年","t":"00:00:01"},{"topic":"毛利","text":"毛利率 45%","t":"00:01:06"},{"text":""}],"todos":[{"text":"补充订单周期"}],"open":["在手订单 1.5 亿是否含税"]}\n```'
  const content = parseSummary(raw, utterances)!
  assert.equal(content.title, "收入与订单")
  assert.deepEqual(content.paragraphs.map((p) => [p.topic, p.t, p.unverified]), [
    ["收入", 1000, []],
    ["毛利", 65_000, ["45"]],
  ])
  assert.deepEqual(content.todos, [{ text: "补充订单周期", t: undefined, unverified: [] }])
  assert.deepEqual(content.open.map((p) => p.text), ["在手订单 1.5 亿是否含税"])
  assert.equal(parseSummary("抱歉，我无法完成", utterances), undefined)
})

test("number verification ignores separators but not different or partial numbers", () => {
  assert.deepEqual(unverifiedNumbers("收入 3,000万", "收入 3000万 元"), [])
  assert.deepEqual(unverifiedNumbers("订单 1.5亿", "在手订单 1.5 亿"), [])
  assert.deepEqual(unverifiedNumbers("订单 1.6亿", "在手订单 1.5 亿"), ["1.6"])
  assert.deepEqual(unverifiedNumbers("订单 5 亿", "在手订单 1.5 亿"), ["5"])
})

const stage1: SummaryRecord = {
  index: 1, startMs: 0, endMs: 60_000, trigger: "auto", status: "done", attempts: 1, utterances: [1000],
  content: { title: "收入", paragraphs: [{ topic: "收入", text: "收入 3.2 亿", t: 1000, unverified: [] }], todos: [{ text: "核对口径", unverified: [] }], open: [] },
}

test("summary prompt asks for topic paragraphs and carries focus, overview, prior stages and timestamps", () => {
  const overview = { title: "", paragraphs: [{ topic: "经营", text: "全年收入预计增长", t: 1000, unverified: [] }], todos: [], open: [] }
  const [system, user] = buildSummaryMessages("访谈", "关注订单", { startMs: 60_000, endMs: 120_000 }, utterances.slice(1), [stage1], overview)
  assert.match(system.content, /one paragraph per topic/)
  assert.match(system.content, /plans, forecasts and estimates/)
  assert.match(system.content, /关注订单/)
  assert.match(user.content, /overview so far \(context only\):\n经营: 全年收入预计增长 \[00:00:01\]/)
  assert.match(user.content, /Stage 1 \(00:00–01:00\) 收入:\n收入: 收入 3\.2 亿 \[00:00:01\]\nTo-do: 核对口径/)
  assert.match(user.content, /\[00:01:05\] 毛利/)
  const [, first] = buildSummaryMessages("访谈", "", { startMs: 0, endMs: 60_000 }, utterances, [], undefined)
  assert.match(first.content, /overview so far \(context only\):\n\(none\)/)
})

test("overview prompt merges new stages into the current overview by topic", () => {
  const [system, user] = buildOverviewMessages("访谈", "关注订单", undefined, [stage1])
  assert.match(system.content, /Organize by topic, not by time/)
  assert.match(system.content, /关注订单/)
  assert.match(user.content, /Current overview:\n\(none\)/)
  assert.match(user.content, /New stage summaries:\nStage 1 .*\n收入: 收入 3\.2 亿 \[00:00:01\]/)
})

test("summary markdown writes topic paragraphs, then to-dos and open questions", () => {
  const record: SummaryRecord = {
    index: 2, startMs: 60_000, endMs: 120_000, trigger: "manual", status: "done", attempts: 1, utterances: [],
    content: {
      title: "毛利",
      paragraphs: [
        { topic: "毛利", text: "毛利率 45%", t: 65_000, unverified: ["45"] },
        { topic: "", text: "维持报价，Q3 收入 3.2 亿元", unverified: [] },
      ],
      todos: [{ text: "周五前提交方案", unverified: [] }],
      open: [{ text: "是否含税未定", t: 70_000, unverified: [] }],
    },
  }
  const md = summaryMarkdown(record, (ms) => `@${ms}`)
  assert.match(md, /## 阶段 2 · 00:01:00 – 00:02:00 · 毛利/)
  assert.match(md, /^\*\*毛利\*\*：毛利率 \*\*45%\*\*（⚠ 原文未找到 45，请核对） @65000$/m)
  assert.match(md, /^维持报价，Q3 收入 \*\*3\.2 亿元\*\*$/m)
  assert.match(md, /^- \[ \] 【待办】周五前提交方案\n- 【未决】是否含税未定 @70000$/m)
  assert.match(overviewMarkdown(record.content!, 120_000, (ms) => `@${ms}`), /^## 会议概览 · 截至 00:02:00\n\n\*\*毛利\*\*：/)
  assert.match(summaryMarkdown({ ...record, content: { title: "", paragraphs: [], todos: [], open: [] } }, String), /本阶段没有可提炼的实质内容/)
})

test("saved marked points and sectioned summaries become paragraphs and lists", () => {
  const points = { title: "旧", items: [{ kind: "fact", text: "销量 4500 台", t: 30_000, unverified: ["4500"] }, { kind: "todo", text: "补数据", unverified: [] }, { kind: "opinion", text: "增长放缓", t: 40_000, unverified: [] }] }
  const sections = { topics: [{ text: "订单", t: 65_000 }], conclusions: [{ text: "收入增长", t: 1000 }], figures: [], conflicts: [{ text: "口径不一" }], followups: [{ text: "周期？" }] }
  const meta = { summaries: [points, sections].map((content, i) => ({ index: i + 1, startMs: 0, endMs: 120_000, trigger: "auto", status: "done", attempts: 1, utterances: [], content })) } as unknown as MeetingMeta
  upgradeSummaries(meta)
  assert.deepEqual(meta.summaries[0].content, {
    title: "旧",
    paragraphs: [
      { topic: "", text: "销量 4500 台", t: 30_000, unverified: ["4500"] },
      { topic: "", text: "增长放缓", t: 40_000, unverified: [] },
    ],
    todos: [{ text: "补数据", t: undefined, unverified: [] }],
    open: [],
  })
  assert.deepEqual(meta.summaries[1].content, {
    title: "",
    paragraphs: [
      { topic: "", text: "收入增长", t: 1000, unverified: [] },
      { topic: "", text: "订单", t: 65_000, unverified: [] },
    ],
    todos: [],
    open: [{ text: "口径不一", t: undefined, unverified: [] }],
  })
})

test("scheduling waits for grace and recognizer catch-up, and claims late utterances", () => {
  assert.equal(dueCutoff(301_000, 0, 300_000, 310_000, true), undefined)
  assert.equal(dueCutoff(305_000, 0, 300_000, 305_000, true), 300_000)
  assert.equal(dueCutoff(305_000, 0, 300_000, 290_000, true), undefined)
  assert.equal(dueCutoff(361_000, 0, 300_000, 290_000, true), 300_000)
  assert.equal(dueCutoff(305_000, 0, 300_000, 0, false), 300_000)
  const done: SummaryRecord[] = [{ index: 1, startMs: 0, endMs: 60_000, trigger: "auto", status: "done", attempts: 1, utterances: [65_000] }]
  assert.deepEqual(uncovered(utterances, done, Infinity).map((u) => u.startMs), [1000])
})

test("minutes input strips the meeting block and orders sources", () => {
  const note = "## 速记\n- 收入含税？\n\n```meeting-live\nid: m-1\n```\n\n- 结尾"
  assert.equal(stripMeetingBlocks(note), "## 速记\n- 收入含税？\n\n- 结尾")
  const [system, user] = buildMinutesMessages("", { title: "访谈", date: "2026-10-27", utterances, summaries: [], notes: [{ path: "a.md", content: "速记" }] })
  assert.match(system.content, /only source of facts/)
  assert.ok(user.content.indexOf("## Manual notes: a.md") < user.content.indexOf("## Transcript"))
  assert.match(user.content, /Date: 2026-10-27/)
})

test("chat client builds URLs, parses responses, surfaces API errors", async () => {
  assert.equal(chatCompletionsUrl("https://api.x.com/v1/"), "https://api.x.com/v1/chat/completions")
  assert.equal(chatCompletionsUrl("https://api.x.com/v1/chat/completions"), "https://api.x.com/v1/chat/completions")
  assert.equal(extractCompletionText({ choices: [{ message: { content: "<think>x</think>好" } }] }), "好")
  const config = { baseUrl: "https://api.x.com/v1", apiKey: "k", model: "m", temperature: 0.2, effort: "off" as const }
  let sent: { url: string; headers: Record<string, string>; body: string } | undefined
  const ok = await chat(config, [{ role: "user", content: "hi" }], async (url, headers, body) => {
    sent = { url, headers, body }
    return { status: 200, text: JSON.stringify({ choices: [{ message: { content: "OK" } }] }) }
  })
  assert.equal(ok, "OK")
  assert.equal(sent?.headers.Authorization, "Bearer k")
  await assert.rejects(chat(config, [], async () => ({ status: 401, text: '{"error":{"message":"bad key"}}' })), /HTTP 401.*bad key/)
  assert.equal(JSON.parse(sent!.body).reasoning_effort, undefined)
})

test("reasoning effort is sent, with DeepSeek's thinking switch only for DeepSeek", () => {
  const base = { apiKey: "k", model: "deepseek-flash", temperature: 0.2 }
  const deepseek = chatRequestBody({ ...base, baseUrl: "https://api.deepseek.com", effort: "low" }, [])
  assert.equal(deepseek.reasoning_effort, "low")
  assert.deepEqual(deepseek.thinking, { type: "enabled" })
  assert.deepEqual(chatRequestBody({ ...base, baseUrl: "https://api.deepseek.com/v1", effort: "off" }, []).thinking, { type: "disabled" })
  const other = chatRequestBody({ ...base, baseUrl: "https://openrouter.ai/api/v1", effort: "high" }, [])
  assert.equal(other.reasoning_effort, "high")
  assert.equal(other.thinking, undefined)
})
