import assert from "node:assert/strict"
import { test } from "node:test"
import { chat, chatCompletionsUrl, chatRequestBody, compatibleClient, extractCompletionText, llmConfigProblem, type ChatMessage, type LlmConfig } from "../src/llm/client.ts"
import { LLM_PRESETS, parseHeaders, presetById, presetForUrl } from "../src/llm/presets.ts"
import { DEFAULT_SETTINGS, llmConfig, loadSettings } from "../src/settings.ts"
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
  const [, third] = buildSummaryMessages("访谈", "", { startMs: 120_000, endMs: 180_000 }, [], [stage1, { ...stage1, index: 2, startMs: 60_000, endMs: 120_000 }], overview)
  assert.match(third.content, /Previous stage \(context only\):\nStage 2 /)
  assert.doesNotMatch(third.content, /Stage 1 /)
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
  assert.match(md, /^## 毛利$/m)
  assert.match(summaryMarkdown({ ...record, content: { ...record.content!, title: "" } }, String), /^## 阶段 2$/m)
  // A topic sits on its own line with its time; only unverified figures are marked, the rest stay plain.
  assert.match(md, /^\*\*毛利\*\* @65000\n毛利率 ==45%==$/m)
  assert.match(md, /^维持报价，Q3 收入 3\.2 亿元$/m)
  assert.doesNotMatch(md, /原文未找到|【/)
  assert.match(md, /^\*\*待办\*\*\n- \[ \] 周五前提交方案\n\n\*\*未决\*\*\n- 是否含税未定 @70000$/m)
  const overview = overviewMarkdown(record.content!, 120_000, (ms) => `@${ms}`)
  assert.match(overview, /^## 会议概览 · 截至 02:00\n\n- \*\*毛利\*\*：毛利率 ==45%== @65000\n- 维持报价，Q3 收入 3\.2 亿元\n\n\*\*待办\*\*\n- \[ \] 周五前提交方案\n/)
  assert.match(summaryMarkdown({ ...record, content: { title: "", paragraphs: [], todos: [], open: [] } }, String), /本阶段没有可提炼的实质内容/)

  // Anchors: the first line always gets the stage's, later lines only when asked.
  const anchored = summaryMarkdown(record, (ms) => `@${ms}`, "###", (point, first) => (first ? "s2" : point?.t !== undefined ? `t${point.t}` : undefined))
  assert.match(anchored, /^### 毛利$/m)
  assert.match(anchored, /^\*\*毛利\*\* @65000\n毛利率 ==45%== \^s2$/m)
  assert.match(anchored, /^维持报价，Q3 收入 3\.2 亿元$/m)
  assert.match(anchored, /^- \[ \] 周五前提交方案\n\n\*\*未决\*\*\n- 是否含税未定 @70000 \^t70000$/m)
  assert.match(summaryMarkdown({ ...record, content: { title: "", paragraphs: [], todos: [], open: [] } }, String, "###", () => "s9"), /本阶段没有可提炼的实质内容。 \^s9/)
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

const config = (preset: string, patch: Partial<LlmConfig> = {}): LlmConfig => ({ preset: presetById(preset), baseUrl: presetById(preset).baseUrl, apiKey: "k", model: "m", temperature: 0.2, effort: "off", headers: {}, inputLimit: 1000, ...patch })

test("chat client builds URLs, parses responses, surfaces API errors", async () => {
  assert.equal(chatCompletionsUrl("https://api.x.com/v1/"), "https://api.x.com/v1/chat/completions")
  assert.equal(chatCompletionsUrl("https://api.x.com/v1/chat/completions"), "https://api.x.com/v1/chat/completions")
  assert.equal(extractCompletionText({ choices: [{ message: { content: "<think>x</think>好" } }] }), "好")
  const custom = config("custom", { baseUrl: "https://api.x.com/v1" })
  let sent: { url: string; headers: Record<string, string>; body: string } | undefined
  const ok = await chat(custom, [{ role: "user", content: "hi" }], async (url, headers, body) => {
    sent = { url, headers, body }
    return { status: 200, text: JSON.stringify({ choices: [{ message: { content: "OK" } }] }) }
  })
  assert.equal(ok, "OK")
  assert.equal(sent?.headers.Authorization, "Bearer k")
  await assert.rejects(chat(custom, [], async () => ({ status: 401, text: '{"error":{"message":"bad key"}}' })), /HTTP 401.*bad key/)
  assert.equal(JSON.parse(sent!.body).reasoning_effort, undefined)
})

const hi: ChatMessage[] = [{ role: "user", content: "hi" }]

test("the author's DeepSeek configuration sends exactly the request body it always did", () => {
  const author = llmConfig({ getSecret: () => "key" }, { ...DEFAULT_SETTINGS, llmBaseUrl: "https://api.deepseek.com", llmModel: "deepseek-flash", llmEffort: "low", llmTemperature: 0.2 })
  assert.equal(author.preset.id, "deepseek")
  // Pinned as text so key order counts too; these strings are what 1.0.1 produced for the same input.
  assert.equal(JSON.stringify(chatRequestBody(author, hi)), '{"model":"deepseek-flash","messages":[{"role":"user","content":"hi"}],"temperature":0.2,"stream":false,"reasoning_effort":"low","thinking":{"type":"enabled"}}')
  // Summaries ask for JSON, but DeepSeek documents nothing about JSON output with thinking on, so with it on the body does not change.
  assert.equal(JSON.stringify(chatRequestBody(author, hi, { json: true })), JSON.stringify(chatRequestBody(author, hi)))
  const off = { ...author, effort: "off" as const }
  assert.equal(JSON.stringify(chatRequestBody(off, hi)), '{"model":"deepseek-flash","messages":[{"role":"user","content":"hi"}],"temperature":0.2,"stream":false,"thinking":{"type":"disabled"}}')
  assert.equal(JSON.stringify(chatRequestBody(off, hi, { json: true })), '{"model":"deepseek-flash","messages":[{"role":"user","content":"hi"}],"temperature":0.2,"stream":false,"thinking":{"type":"disabled"},"response_format":{"type":"json_object"}}')
})

test("an existing OpenAI-compatible host keeps the body it had: temperature and reasoning_effort, no thinking field", () => {
  const body = chatRequestBody(config("custom", { baseUrl: "https://openrouter.ai/api/v1", effort: "high" }), hi)
  assert.equal(JSON.stringify(body), '{"model":"m","messages":[{"role":"user","content":"hi"}],"temperature":0.2,"stream":false,"reasoning_effort":"high"}')
  assert.equal(chatRequestBody(config("custom", { effort: "off" }), hi).reasoning_effort, undefined)
})

test("each preset shapes the request the way its documentation says", () => {
  const body = (preset: string, effort: LlmConfig["effort"], json = false) => chatRequestBody(config(preset, { effort }), hi, { json })
  // OpenAI: no temperature, effort as reasoning_effort, JSON mode available.
  assert.deepEqual(body("openai", "medium", true), { model: "m", messages: hi, stream: false, reasoning_effort: "medium", response_format: { type: "json_object" } })
  // Anthropic: neither temperature, effort nor json_object (a 400) is sent.
  assert.deepEqual(body("anthropic", "high", true), { model: "m", messages: hi, stream: false })
  // Gemini: effort only.
  assert.deepEqual(body("gemini", "low", true), { model: "m", messages: hi, stream: false, reasoning_effort: "low" })
  // OpenRouter and Ollama: temperature, effort and JSON mode.
  for (const id of ["openrouter", "ollama"]) assert.deepEqual(body(id, "low", true), { model: "m", messages: hi, temperature: 0.2, stream: false, reasoning_effort: "low", response_format: { type: "json_object" } })
  // LM Studio: temperature only.
  assert.deepEqual(body("lmstudio", "high", true), { model: "m", messages: hi, temperature: 0.2, stream: false })
  // Azure: effort only, and the key goes in `api-key`.
  assert.deepEqual(body("azure", "low", true), { model: "m", messages: hi, stream: false, reasoning_effort: "low" })
  // Custom never asks for JSON mode, since nothing is known about the server.
  assert.equal("response_format" in body("custom", "off", true), false)
  // Without the option, no preset asks for JSON.
  for (const preset of LLM_PRESETS) assert.equal("response_format" in chatRequestBody(config(preset.id), hi), false, preset.id)
})

test("credentials follow the preset: Bearer, Azure's api-key header, none for a local server without a key, and extra headers", async () => {
  const headersFor = async (c: LlmConfig) => {
    let seen: Record<string, string> = {}
    await chat(c, hi, async (_url, headers) => ((seen = headers), { status: 200, text: '{"choices":[{"message":{"content":"x"}}]}' }))
    return seen
  }
  assert.deepEqual(await headersFor(config("openai")), { "Content-Type": "application/json", Authorization: "Bearer k" })
  assert.deepEqual(await headersFor(config("azure", { headers: { "x-ms-client": "ml" } })), { "Content-Type": "application/json", "api-key": "k", "x-ms-client": "ml" })
  assert.deepEqual(await headersFor(config("ollama", { apiKey: "" })), { "Content-Type": "application/json" })
  assert.deepEqual(await headersFor(config("ollama", { apiKey: "local" })), { "Content-Type": "application/json", Authorization: "Bearer local" })
  assert.equal(llmConfigProblem(config("ollama", { apiKey: "", baseUrl: "http://localhost:11434/v1" })), undefined)
  assert.match(llmConfigProblem(config("openai", { apiKey: "" })) ?? "", /API Key/)
  assert.match(llmConfigProblem(config("azure")) ?? "", /资源地址/)
  assert.equal(llmConfigProblem(config("azure", { baseUrl: "https://mine.openai.azure.com/openai/v1" })), undefined)
})

test("a service that refuses or blanks a JSON reply is asked again without it", async () => {
  const bodies: Record<string, unknown>[] = []
  const reply = (statuses: number[]) => async (_url: string, _headers: Record<string, string>, body: string) => {
    bodies.push(JSON.parse(body))
    const status = statuses.shift() ?? 200
    return { status, text: status === 200 && statuses.length === 0 && bodies.length > 1 ? '{"choices":[{"message":{"content":"{}"}}]}' : status === 200 ? '{"choices":[{"message":{"content":"  "}}]}' : '{"error":{"message":"nope"}}' }
  }
  const openai = config("openai")
  // HTTP 400 on the JSON request, then success.
  assert.equal(await chat(openai, hi, reply([400]), { json: true }), "{}")
  assert.deepEqual(bodies.map((b) => "response_format" in b), [true, false])
  // Blank content on the JSON request (DeepSeek's documented failure mode), then success.
  bodies.length = 0
  assert.equal(await chat(config("deepseek"), hi, reply([200]), { json: true }), "{}")
  assert.deepEqual(bodies.map((b) => "response_format" in b), [true, false])
  // A server error is not retried, and neither is a request that never asked for JSON.
  bodies.length = 0
  await assert.rejects(chat(openai, hi, reply([500]), { json: true }), /HTTP 500/)
  assert.equal(bodies.length, 1)
  bodies.length = 0
  await assert.rejects(chat(openai, hi, reply([400])), /HTTP 400/)
  assert.equal(bodies.length, 1)
})

test("the client reports the input limit: the user's, else the preset's", () => {
  assert.equal(compatibleClient(config("deepseek", { inputLimit: 777 }), async () => ({ status: 200, text: "" })).inputLimit, 777)
  const secrets = { getSecret: () => "k" }
  assert.equal(llmConfig(secrets, DEFAULT_SETTINGS).inputLimit, 1_000_000)
  assert.equal(llmConfig(secrets, { ...DEFAULT_SETTINGS, llmInputLimit: 30_000 }).inputLimit, 30_000)
})

test("existing configurations map to a preset by their base URL, anything else to Custom", () => {
  const cases: [string, string][] = [
    ["https://api.deepseek.com", "deepseek"],
    ["https://api.deepseek.com/v1", "deepseek"],
    ["https://api.deepseek.com/chat/completions", "deepseek"],
    ["https://api.openai.com/v1", "openai"],
    ["https://api.anthropic.com/v1/", "anthropic"],
    ["https://generativelanguage.googleapis.com/v1beta/openai/", "gemini"],
    ["https://openrouter.ai/api/v1", "openrouter"],
    ["http://localhost:11434/v1", "ollama"],
    ["http://127.0.0.1:11434/v1", "ollama"],
    ["http://localhost:1234/v1", "lmstudio"],
    ["https://my-res.openai.azure.com/openai/v1", "azure"],
    ["http://127.0.0.1:8790/v1", "custom"],
    ["https://ark.cn-beijing.volces.com/api/v3", "custom"],
    ["", "custom"],
    ["not a url", "custom"],
  ]
  for (const [url, id] of cases) assert.equal(presetForUrl(url).id, id, url)
  assert.equal(loadSettings({ version: 2, llmBaseUrl: "https://openrouter.ai/api/v1" }).settings.llmPreset, "openrouter")
  assert.equal(loadSettings({ llmBaseUrl: "http://10.0.0.5:8000/v1" }).settings.llmPreset, "custom")
  // A stored choice wins over the URL, and an invalid one is placed by the URL.
  assert.equal(loadSettings({ version: 2, llmPreset: "custom", llmBaseUrl: "https://api.deepseek.com" }).settings.llmPreset, "custom")
  assert.equal(loadSettings({ version: 2, llmPreset: "gone", llmBaseUrl: "https://api.deepseek.com" }).settings.llmPreset, "deepseek")
})

test("a configuration saved before presets is written back with its preset, and once is enough", () => {
  const before = { version: 2, llmBaseUrl: "https://api.deepseek.com", llmModel: "deepseek-flash", llmEffort: "low", llmTemperature: 0.2 }
  const first = loadSettings(before)
  assert.equal(first.migrated, true)
  assert.equal(first.settings.llmPreset, "deepseek")
  const second = loadSettings(JSON.parse(JSON.stringify(first.settings)))
  assert.equal(second.migrated, false)
  assert.deepEqual(second.settings, first.settings)
  assert.equal(loadSettings(null).migrated, false)
})

test("extra headers are parsed from lines and only presets that allow them use them", () => {
  assert.deepEqual(parseHeaders("X-Org: acme\n# comment\nbad line\nX-Empty:\n  X-Trim :  v:with:colons  \n:novalue\nbad name: v"), { "X-Org": "acme", "X-Trim": "v:with:colons" })
  const settings = { ...DEFAULT_SETTINGS, llmHeaders: "X-Org: acme" }
  const secrets = { getSecret: () => "k" }
  assert.deepEqual(llmConfig(secrets, { ...settings, llmPreset: "custom" }).headers, { "X-Org": "acme" })
  assert.deepEqual(llmConfig(secrets, { ...settings, llmPreset: "azure" }).headers, { "X-Org": "acme" })
  assert.deepEqual(llmConfig(secrets, { ...settings, llmPreset: "deepseek" }).headers, {})
})
