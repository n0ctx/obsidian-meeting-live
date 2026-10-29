import assert from "node:assert/strict"
import { test } from "node:test"
import { chat, chatCompletionsUrl, chatRequestBody, extractCompletionText } from "../src/llm/client.ts"
import { buildMinutesMessages, stripMeetingBlocks } from "../src/llm/minutes.ts"
import { buildSummaryMessages, parseSummary, summaryMarkdown, unverifiedNumbers, upgradeSummaries } from "../src/llm/summary.ts"
import { dueCutoff, uncovered } from "../src/meeting/schedule.ts"
import type { MeetingMeta, SummaryRecord, Utterance } from "../src/meeting/types.ts"

const utterances: Utterance[] = [
  { startMs: 1000, endMs: 4000, text: "今年收入预计 3.2 亿元，去年 2.1 亿。" },
  { startMs: 65_000, endMs: 70_000, text: "毛利率百分之四十二，在手订单 1.5 亿。" },
]

test("summary parsing snaps citations, orders by time, flags unverified numbers, tolerates fences", () => {
  const raw = '```json\n{"title":"收入与订单","items":[{"kind":"opinion","text":"毛利率 45%","t":"00:01:06"},{"kind":"fact","text":"今年预计收入 3.2 亿元","t":"00:00:01"},{"kind":"todo","text":"补充订单周期"},{"kind":"bogus","text":"在手订单 1.5 亿"}]}\n```'
  const content = parseSummary(raw, utterances)!
  assert.equal(content.title, "收入与订单")
  assert.deepEqual(content.items.map((i) => [i.kind, i.t, i.unverified]), [
    ["fact", 1000, []],
    ["todo", undefined, []],
    ["fact", undefined, []],
    ["opinion", 65_000, ["45"]],
  ])
  assert.equal(parseSummary("抱歉，我无法完成", utterances), undefined)
})

test("number verification ignores separators but not different or partial numbers", () => {
  assert.deepEqual(unverifiedNumbers("收入 3,000万", "收入 3000万 元"), [])
  assert.deepEqual(unverifiedNumbers("订单 1.5亿", "在手订单 1.5 亿"), [])
  assert.deepEqual(unverifiedNumbers("订单 1.6亿", "在手订单 1.5 亿"), ["1.6"])
  assert.deepEqual(unverifiedNumbers("订单 5 亿", "在手订单 1.5 亿"), ["5"])
})

test("summary prompt carries contract, focus, timestamps and prior context", () => {
  const previous: SummaryRecord[] = [{ index: 1, startMs: 0, endMs: 60_000, trigger: "auto", status: "done", attempts: 1, utterances: [1000], content: { title: "收入", items: [{ kind: "fact", text: "收入 3.2 亿", unverified: [] }] } }]
  const [system, user] = buildSummaryMessages("访谈", "关注订单", { startMs: 60_000, endMs: 120_000 }, utterances.slice(1), previous)
  assert.match(system.content, /plans, forecasts and estimates/)
  assert.match(system.content, /- fact: .*\n- opinion: /)
  assert.doesNotMatch(system.content, /misrecognized/)
  assert.match(system.content, /关注订单/)
  assert.match(user.content, /Stage 1 \(00:00–01:00\) 收入: 收入 3\.2 亿/)
  assert.match(user.content, /\[00:01:05\] 毛利率/)
})

test("summary markdown lists items with kind marks, bold figures and flags unverified numbers", () => {
  const record: SummaryRecord = {
    index: 2, startMs: 60_000, endMs: 120_000, trigger: "manual", status: "done", attempts: 1, utterances: [],
    content: { title: "毛利", items: [
      { kind: "fact", text: "毛利率 45%", t: 65_000, unverified: ["45"] },
      { kind: "opinion", text: "维持报价，Q3 收入 3.2 亿元", unverified: [] },
      { kind: "todo", text: "周五前提交方案", unverified: [] },
      { kind: "open", text: "是否含税未定", unverified: [] },
    ] },
  }
  const md = summaryMarkdown(record, (ms) => `@${ms}`)
  assert.match(md, /## 阶段 2 · 00:01:00 – 00:02:00 · 毛利/)
  assert.match(md, /^- 📄 毛利率 \*\*45%\*\*（⚠ 原文未找到 45，请核对） @65000$/m)
  assert.match(md, /^- 💬 维持报价，Q3 收入 \*\*3\.2 亿元\*\*$/m)
  assert.match(md, /^- \[ \] 周五前提交方案$/m)
  assert.match(md, /^- ❓ 是否含税未定$/m)
})

test("legacy sectioned summaries become one time-ordered list without follow-ups", () => {
  const legacy = { topics: [{ text: "订单", t: 65_000 }], conclusions: [{ text: "收入增长", t: 1000 }], figures: [{ value: "4500 台", context: "销量", t: 30_000, verified: false }], conflicts: [], followups: [{ text: "周期？" }] }
  const meta = { summaries: [{ index: 1, startMs: 0, endMs: 120_000, trigger: "auto", status: "done", attempts: 1, utterances: [], content: legacy }] } as unknown as MeetingMeta
  upgradeSummaries(meta)
  assert.deepEqual(meta.summaries[0].content, {
    title: "",
    items: [
      { kind: "opinion", text: "收入增长", t: 1000, unverified: [] },
      { kind: "fact", text: "销量 4500 台", t: 30_000, unverified: ["4500"] },
      { kind: "fact", text: "订单", t: 65_000, unverified: [] },
    ],
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
