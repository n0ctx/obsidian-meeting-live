import assert from "node:assert/strict"
import { test } from "node:test"
import { chat, chatRequestBody, metered, usageOf, type ChatMessage, type CompleteOptions, type LlmConfig, type LlmUsage } from "../src/llm/client.ts"
import { correctionTerms } from "../src/llm/correction.ts"
import { acceptPolish, acceptableLine, buildPolishMessages, parsePolish } from "../src/llm/polish.ts"
import { presetById } from "../src/llm/presets.ts"
import { applyEdit, type TextEdit } from "../src/meeting/noteSummary.ts"
import { MeetingSession, type SessionEnv } from "../src/meeting/session.ts"
import { linkTranscript, utteranceLine } from "../src/meeting/transcriptFormat.ts"
import type { MeetingMeta, Utterance } from "../src/meeting/types.ts"
import { DEFAULT_SETTINGS, loadSettings, type TranscriptCleanup } from "../src/settings.ts"

const none = correctionTerms({ hotwords: [], scene: "" }, [])

// ---------------------------------------------------------------- the line check

test("tidying that keeps what was said passes: punctuation, filler, swearing as filler, stutters, BD written in capitals", () => {
  const tidy: [string, string][] = [
    ["那山东投那个有几个亿收入了，他妈也不行。", "山东投的那个有几个亿收入了，也不行。"],
    ["是不是也，也？现在也不行了，也不能看，现在器械基本上都不都不行，对", "是不是也？现在也不行了，也不能看，现在器械基本上都不行，对。"],
    [
      "哎，医疗行业器械我还不太清楚，就是能创新药创新药的话主要都是 bd 嘛，因为你真正有价值的就是那个管线，没有那个管线其实平台而言的话没有太大的并购的价值。嗯。",
      "医疗器械我还不太清楚。创新药主要都是 BD，因为真正有价值的是管线，没有管线的话，平台本身没有太大的并购价值。",
    ],
    ["弯头的器械有，有十来个吧？对冲药有十来个", "弯头的器械有十来个吧？对冲药有十来个。"],
    ["我们一个一个一个地看", "我们一个一个地看。"],
    ["啊，对，那个是。", "对，那个是。"],
    ["So, um, I think we should, uh, go with the second option.", "So I think we should go with the second option."],
    ["对对对，就是，就是那个意思。", "对，就是那个意思。"],
  ]
  for (const [before, after] of tidy) assert.ok(acceptableLine(before, after, none), after)
})

test("a misheard known term may be corrected, even when it is longer than the slack for new text", () => {
  const terms = correctionTerms({ hotwords: ["尚德生物科技"], scene: "" }, [])
  assert.ok(acceptableLine("还有个做血清的还是什么，就很上帝那个叫啥？", "还有个做血清的还是什么，就是尚德生物科技，那个叫啥？", terms))
  assert.ok(!acceptableLine("还有个做血清的还是什么，就很上帝那个叫啥？", "还有个做血清的还是什么，就是尚德生物，那个叫啥？", none), "not a known term: new text")
  // A name may hold a numeral or a negation its misheard form did not.
  const named = correctionTerms({ hotwords: ["三星", "无锡"], scene: "" }, [])
  assert.ok(acceptableLine("下周跟山星谈。", "下周跟三星谈。", named))
  assert.ok(acceptableLine("我们在吴西有工厂。", "我们在无锡有工厂。", named))
})

test("a known term cannot be added to a line that did not have a misheard word for it", () => {
  const terms = correctionTerms({ hotwords: ["张明", "李华"], scene: "" }, [])
  assert.ok(!acceptableLine("好的，那就这样。", "好的，那就这样，张明、李华。", terms))
  assert.ok(!acceptableLine("那就这样定了。", "张明，那就这样定了。", terms))
})

test("a line that changes a number, adds content, adds a Latin word, reorders, summarizes or empties keeps its text", () => {
  const rejected: [string, string, string][] = [
    ["今年收入三亿。", "今年收入四亿。", "number changed"],
    ["投了20亿。", "投了二十亿。", "number rewritten"],
    ["现在器械不行。", "现在医疗器械行业整体都不行了。", "content added"],
    ["主要都是 bd 嘛。", "主要都是 BD 和 license-out。", "Latin word added"],
    ["先看收入再看利润。", "先看利润再看收入。", "reordered"],
    [
      "说话人那边的意思是这个项目今年先把产线建起来，然后明年再看市场的情况决定要不要扩产，资金这块他们自己能解决一部分。",
      "今年建产线，明年看市场再定扩产。",
      "summarized",
    ],
    ["啊。", "", "emptied"],
    ["嗯。", "。", "only punctuation left"],
    ["一样的。", "一样的。", "unchanged"],
    ["我不同意。", "我同意。", "negation dropped"],
    ["他们没有批准。", "他们有批准。", "negation dropped"],
    ["我不是很同意这个", "我是很同意", "negation dropped with a cut"],
    ["能交付吗？", "能交付。", "question made a statement"],
    ["我们明天交付。", "你们明天交付。", "person changed"],
    ["So I think we should um, the thing is, nobody knows it.", "Second option.", "English rewritten"],
    ["the cost is lower than the revenue", "revenue is lower than the cost", "English reordered"],
    ["我们会用 Python 和 Excel 和 Tableau 做分析和展示，然后再汇报。", "我们会做分析，然后汇报。", "most of the line cut"],
    ["长".repeat(1600), "长".repeat(1599), "too long to compare"],
  ]
  for (const [before, after, why] of rejected) assert.ok(!acceptableLine(before, after, none), why)
})

test("the reply is read leniently: fences, a number as text, and junk entries are tolerated; anything else gives no lines", () => {
  assert.deepEqual(parsePolish('```json\n{"lines":[{"n":"2","text":" 好的，\\n明白。 "},{"n":1.5,"text":"x"},{"text":"y"},{"n":3,"text":4}]}\n```'), [{ n: 2, text: "好的， 明白。" }])
  assert.equal(parsePolish("不是 JSON"), undefined)
  assert.equal(parsePolish('{"fixes":[]}'), undefined)
  assert.deepEqual(parsePolish('{"lines":[]}'), [])
})

test("lines are matched by number; a label left in front is taken off; a line outside the window or returned twice is ignored", () => {
  const window: Utterance[] = [
    { startMs: 0, endMs: 1000, text: "嗯，收入是，是三亿", speaker: "1" },
    { startMs: 1000, endMs: 2000, text: "对" },
  ]
  const accepted = acceptPolish(
    [
      { n: 1, text: "说话人 1：收入是三亿。" },
      { n: 2, text: "对。" },
      { n: 2, text: "对的。" },
      { n: 3, text: "多出来的" },
    ],
    window,
    none,
    "zh",
  )
  assert.deepEqual([...accepted.entries()].map(([u, text]) => [u.startMs, text]), [[0, "收入是三亿。"]])
})

test("the request puts the fixed prompt and the known terms first and numbers the lines with their speakers", () => {
  const terms = correctionTerms({ hotwords: ["蓝箭"], scene: "投后访谈" }, [])
  const [system, user] = buildPolishMessages(
    [
      { startMs: 0, endMs: 1000, text: "兰箭今年，今年收入三亿", speaker: "1" },
      { startMs: 1000, endMs: 2000, text: "嗯" },
    ],
    terms,
    "zh",
  )
  assert.match(system.content, /^You tidy one stretch of a meeting's speech-to-text transcript/)
  assert.match(user.content, /^Known terms:\n- 蓝箭\n\nAbout the meeting: 投后访谈\n\nTranscript:\n/)
  assert.match(user.content, /\n1\. 说话人 1：兰箭今年，今年收入三亿\n2\. 嗯$/)
})

// ---------------------------------------------------------------- usage and the request

const hi: ChatMessage[] = [{ role: "user", content: "hi" }]
const deepseek = (effort: LlmConfig["effort"]): LlmConfig => ({ preset: presetById("deepseek"), baseUrl: "https://api.deepseek.com", apiKey: "k", model: "deepseek-flash", temperature: 0.2, effort, headers: {}, inputLimit: 1000 })

test("a request can switch reasoning off for itself, which also lets DeepSeek be asked for JSON", () => {
  const body = chatRequestBody(deepseek("low"), hi, { json: true, effort: "off" })
  assert.equal(JSON.stringify(body), '{"model":"deepseek-flash","messages":[{"role":"user","content":"hi"}],"temperature":0.2,"stream":false,"thinking":{"type":"disabled"},"response_format":{"type":"json_object"}}')
})

test("usage is read from DeepSeek's and OpenAI's shapes, and is reported for each request, the retry without JSON included", async () => {
  assert.deepEqual(usageOf({ usage: { prompt_tokens: 900, prompt_cache_hit_tokens: 640, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 120 } } }), { input: 900, cached: 640, output: 300, reasoning: 120 })
  assert.deepEqual(usageOf({ usage: { prompt_tokens: 50, prompt_tokens_details: { cached_tokens: 10 }, completion_tokens: 5 } }), { input: 50, cached: 10, output: 5, reasoning: 0 })
  assert.equal(usageOf({ choices: [] }), undefined)

  const seen: LlmUsage[] = []
  const replies = [
    { status: 200, text: JSON.stringify({ choices: [{ message: { content: "" } }], usage: { prompt_tokens: 10, completion_tokens: 0 } }) },
    { status: 200, text: JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) },
  ]
  const text = await chat(deepseek("off"), hi, async () => replies.shift()!, { json: true, usage: (u) => seen.push(u) })
  assert.equal(text, "{}")
  assert.deepEqual(seen.map((u) => u.output), [0, 2])
})

test("a metered client tells both the meter and the caller", async () => {
  const meter: LlmUsage[] = []
  const caller: LlmUsage[] = []
  const usage = { input: 1, cached: 0, output: 2, reasoning: 0 }
  const client = metered({ problem: undefined, model: "m", target: "t", inputLimit: 1, complete: async (_m, o) => (o?.usage?.(usage), "ok") }, (u) => meter.push(u))
  assert.equal(await client.complete(hi, { usage: (u) => caller.push(u) }), "ok")
  assert.deepEqual([meter, caller], [[usage], [usage]])
})

// ---------------------------------------------------------------- the session

const lines: Utterance[] = [
  { startMs: 1000, endMs: 4000, text: "嗯，兰箭今年，今年收入预计三亿。" },
  { startMs: 5000, endMs: 8000, text: "对。" },
  { startMs: 9000, endMs: 12000, text: "张帆说产能那个还要扩。" },
]

const kind = (messages: ChatMessage[]) => {
  const system = messages[0].content
  if (system.startsWith("You tidy")) return "polish"
  if (system.startsWith("You check")) return "names"
  return system.startsWith("You keep a running overview") ? "overview" : "summary"
}
const SUMMARY = '{"title":"阶段","paragraphs":[{"topic":"收入","text":"收入三亿","t":"00:00:01"}],"todos":[],"open":[]}'
const TIDIED = '{"lines":[{"n":1,"text":"蓝箭今年收入预计三亿。"},{"n":3,"text":"张帆说产能还要扩，扩到十亿。"}]}'

function setup(cleanup: TranscriptCleanup, polish: () => string = () => TIDIED, note = "# 访谈\n\n```meeting-live\nid: m-1\n```\n", meta?: MeetingMeta) {
  const asked: { kind: string; messages: ChatMessage[]; options?: CompleteOptions }[] = []
  const files: Record<string, string> = {
    "m/原始转写.md": linkTranscript(lines.map((u) => utteranceLine(u, "访谈")).join(""), () => "访谈#^m-1-s0"),
    "访谈.md": note,
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
    settings: () => ({ ...DEFAULT_SETTINGS, hotwords: "蓝箭", transcriptCleanup: cleanup }),
    llmConsented: () => true,
    llm: () => ({
      problem: undefined,
      model: "fake",
      target: "fake",
      inputLimit: 1_000_000,
      complete: async (messages: ChatMessage[], options?: CompleteOptions) => {
        asked.push({ kind: kind(messages), messages, options })
        options?.usage?.({ input: 100, cached: 60, output: 10, reasoning: 0 })
        if (kind(messages) === "polish") return polish()
        if (kind(messages) === "names") return '{"fixes":[]}'
        return kind(messages) === "overview" ? '{"paragraphs":[],"todos":[],"open":[]}' : SUMMARY
      },
    }),
  } as unknown as SessionEnv
  const fresh = {
    id: "m-1",
    title: "访谈",
    notePath: "访谈.md",
    createdAt: "2026-11-12T14:30:00+08:00",
    summaries: [{ index: 1, startMs: 0, endMs: 300_000, trigger: "auto", status: "pending", attempts: 0, utterances: [1000, 5000, 9000] }],
    gaps: [],
    segments: [],
    lastCutoffMs: 300_000,
  } as unknown as MeetingMeta
  const session = new MeetingSession(env, "m", meta ?? fresh, files["m/原始转写.md"])
  return { session, asked, files, env }
}

test("a stage is tidied without reasoning before it is summarized; lines that fail the check keep their text; the original is kept", async () => {
  const { session, asked, files } = setup("polish")
  await session.runQueue()
  assert.deepEqual(asked.map((a) => a.kind).slice(0, 2), ["polish", "summary"])
  assert.equal(asked[0].options?.effort, "off")
  assert.equal(asked[0].options?.json, true)
  assert.equal(asked.filter((a) => a.kind === "names").length, 0, "names are corrected in the same request")
  // Line 3 added a figure, so it keeps its text.
  assert.deepEqual(session.utterances.map((u) => u.text), ["蓝箭今年收入预计三亿。", "对。", "张帆说产能那个还要扩。"])
  assert.match(asked[1].messages[1].content, /蓝箭今年收入预计三亿。/)
  assert.match(files["m/原始转写.md"], /^\[\[访谈#\^m-1-s\d\|00:00:01\]\] 蓝箭今年收入预计三亿。 \^t1000-4000$/m)
  assert.deepEqual(session.meta.recognized, { "t1000-4000": "嗯，兰箭今年，今年收入预计三亿。" })
  assert.equal(session.meta.summaries[0].cleaned, 1)
  assert.equal(session.cleanedLines, 1)
  assert.deepEqual(session.meta.usage?.cleanup, { requests: 1, input: 100, cached: 60, output: 10, reasoning: 0 })
  assert.equal(session.meta.usage?.summary?.requests, 1)
})

test("a checked stage is not sent again, also after a reload, and the recognized text can be restored with the tables applied", async () => {
  const first = setup("polish")
  await first.session.runQueue()
  first.session.meta.summaries[0].status = "pending"
  first.session.meta.summaries[0].attempts = 0

  // Reloaded: the transcript as written and meeting.json as saved; the note now has a pair for a name the recognizer got wrong.
  const meta = structuredClone(first.session.meta)
  const again = setup("polish", () => assert.fail("asked again"), "# 访谈\n\n兰箭→蓝箭科技\n", meta)
  again.files["m/原始转写.md"] = first.files["m/原始转写.md"]
  const session = new MeetingSession(again.env, "m", meta, again.files["m/原始转写.md"])
  await session.runQueue()
  assert.ok(!again.asked.some((a) => a.kind === "polish"))

  assert.equal(await session.restoreRecognized(), 1)
  assert.equal(session.utterances[0].text, "嗯，蓝箭科技今年，今年收入预计三亿。")
  assert.match(again.files["m/原始转写.md"], /\]\] 嗯，蓝箭科技今年，今年收入预计三亿。 \^t1000-4000$/m)
  assert.equal(session.meta.recognized, undefined)
  assert.equal(session.cleanedLines, 0)
  assert.equal(await session.restoreRecognized(), 0)
})

test("a pair the user wrote wins over the model's choice; a failed or unreadable reply leaves the text and the summary goes on", async () => {
  const paired = setup("polish", () => '{"lines":[{"n":1,"text":"蓝箭今年收入预计三亿。"}]}', "# 访谈\n\n蓝箭→蓝箭航天\n")
  await paired.session.runQueue()
  assert.equal(paired.session.utterances[0].text, "蓝箭航天今年收入预计三亿。")

  for (const reply of [() => "不是 JSON", () => assert.fail("网络中断")]) {
    const { session } = setup("polish", reply)
    await session.runQueue()
    assert.equal(session.utterances[0].text, "嗯，兰箭今年，今年收入预计三亿。")
    assert.equal(session.meta.summaries[0].status, "done")
    assert.equal(session.meta.summaries[0].attempts, 1)
    assert.equal(session.cleanedLines, 0)
  }
})

test("a long window is tidied in parts of at most 120 lines, numbered from 1 in each", async () => {
  const many = Array.from({ length: 130 }, (_, i): Utterance => ({ startMs: 1000 * (i + 1), endMs: 1000 * (i + 1) + 900, text: `嗯，第${i + 1}句。` }))
  const { session, asked } = setup("polish", () => '{"lines":[{"n":1,"text":"开头。"}]}')
  session.utterances = many
  session.meta.summaries[0].utterances = many.map((u) => u.startMs)
  await session.runQueue()
  const parts = asked.filter((a) => a.kind === "polish").map((a) => a.messages[1].content.split("\n").filter((l) => /^\d+\. /.test(l)).length)
  assert.deepEqual(parts, [120, 10])
})

test("set to off nothing is asked before the summary; set to names only the names check runs", async () => {
  const off = setup("off")
  await off.session.runQueue()
  assert.deepEqual(off.asked.map((a) => a.kind), ["summary", "overview"])
  const names = setup("names")
  await names.session.runQueue()
  assert.deepEqual(names.asked.map((a) => a.kind).slice(0, 2), ["names", "summary"])
  assert.equal(names.session.meta.summaries[0].cleaned, 0)
})

test("settings keep a known cleanup choice and fall back to tidying for anything else", () => {
  assert.equal(loadSettings({ transcriptCleanup: "names" }).settings.transcriptCleanup, "names")
  assert.equal(loadSettings({ transcriptCleanup: "aggressive" }).settings.transcriptCleanup, "polish")
  assert.equal(loadSettings({}).settings.transcriptCleanup, "polish")
})
