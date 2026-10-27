import assert from "node:assert/strict"
import { test } from "node:test"
import { chat, chatCompletionsUrl, chatRequestBody, extractCompletionText } from "../src/llm/client.ts"
import { buildMinutesMessages, stripMeetingBlocks } from "../src/llm/minutes.ts"
import { buildSummaryMessages, parseSummary, summaryMarkdown, verifyFigure } from "../src/llm/summary.ts"
import { dueCutoff, uncovered } from "../src/meeting/schedule.ts"
import type { SummaryRecord, Utterance } from "../src/meeting/types.ts"

const utterances: Utterance[] = [
  { startMs: 1000, endMs: 4000, text: "今年收入预计 3.2 亿元，去年 2.1 亿。" },
  { startMs: 65_000, endMs: 70_000, text: "毛利率百分之四十二，在手订单 1.5 亿。" },
]

test("summary parsing snaps citations, verifies figures, tolerates fences", () => {
  const raw = '```json\n{"topics":[{"text":"收入与毛利","t":"00:01:06"}],"conclusions":["收入增长"],"figures":[{"value":"3.2 亿元","context":"今年预计收入","t":"00:00:01"},{"value":"45%","context":"毛利率","t":"bad"}],"conflicts":[],"followups":[{"text":"订单周期？","t":"00:09:59"}]}\n```'
  const content = parseSummary(raw, utterances)!
  assert.equal(content.topics[0].t, 65_000)
  assert.equal(content.conclusions[0].text, "收入增长")
  assert.equal(content.conclusions[0].t, undefined)
  assert.deepEqual(content.figures.map((f) => [f.value, f.verified, f.t]), [
    ["3.2 亿元", true, 1000],
    ["45%", false, undefined],
  ])
  assert.equal(content.followups[0].t, 65_000)
  assert.equal(parseSummary("抱歉，我无法完成", utterances), undefined)
})

test("figure verification ignores separators but not different numbers", () => {
  assert.equal(verifyFigure("3,000万", "收入 3000万 元"), true)
  assert.equal(verifyFigure("1.5亿", "在手订单 1.5 亿"), true)
  assert.equal(verifyFigure("1.6亿", "在手订单 1.5 亿"), false)
})

test("summary prompt carries contract, focus, timestamps and prior context", () => {
  const previous: SummaryRecord[] = [{ index: 1, startMs: 0, endMs: 60_000, trigger: "auto", status: "done", attempts: 1, utterances: [1000], content: { topics: [{ text: "收入" }], conclusions: [], figures: [], conflicts: [], followups: [] } }]
  const [system, user] = buildSummaryMessages("访谈", "关注订单", { startMs: 60_000, endMs: 120_000 }, utterances.slice(1), previous)
  assert.match(system.content, /plans, forecasts and estimates/)
  assert.match(system.content, /关注订单/)
  assert.match(user.content, /Stage 1 \(00:00–01:00\): topics: 收入/)
  assert.match(user.content, /\[00:01:05\] 毛利率/)
})

test("summary markdown renders sections and flags unverified figures", () => {
  const record: SummaryRecord = { index: 2, startMs: 60_000, endMs: 120_000, trigger: "manual", status: "done", attempts: 1, utterances: [], content: { topics: [], conclusions: [{ text: "结论", t: 65_000 }], figures: [{ value: "45%", context: "毛利率", verified: false }], conflicts: [], followups: [] } }
  const md = summaryMarkdown(record, (ms) => `@${ms}`)
  assert.match(md, /## 阶段 2 · 00:01:00 – 00:02:00/)
  assert.match(md, /- 结论 @65000/)
  assert.match(md, /\*\*45%\*\* 毛利率（⚠ 原文未找到该数值，请核对）/)
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
