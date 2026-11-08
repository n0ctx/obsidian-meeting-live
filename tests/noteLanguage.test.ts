import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { providerNameIn } from "../src/asr/providers/registry.ts"
import { renderInterviewRecord, speakerUtterances } from "../src/asr/fileAsr.ts"
import { appendJobBlock, hasJobBlock, newJobId, placeJobResult } from "../src/asr/jobBlock.ts"
import { resolveNoteLang } from "../src/i18n/index.ts"
import { stripMeetingBlocks } from "../src/llm/minutes.ts"
import { noteLang, transcriptFolder } from "../src/meeting/labels.ts"
import { SUMMARY_MARKER_LINE, applyEdit, placeSummary, summaryRegion } from "../src/meeting/noteSummary.ts"
import { gapLine, linkTranscript, parseTranscript, transcriptHeader, utteranceLine } from "../src/meeting/transcriptFormat.ts"
import { formatShortDateTime } from "../src/meeting/types.ts"
import { loadSettings } from "../src/settings.ts"
import { fakeSession } from "./support/labelFixtures.ts"
import { setLanguage } from "./support/obsidian.ts"

afterEach(() => setLanguage("zh-CN"))

const HAN = new RegExp("[\\u3400-\\u9fff\\uf900-\\ufaff]")
const ID = "m-20261027-abc123"
/** The start of a region as 1.0.1 wrote it. */
const LEGACY_START = `%% meeting-live-summary ${ID} · 由 Meeting Live 自动更新，此区域内的修改会被覆盖 %%`
const count = (text: string, part: string) => text.split(part).length - 1

test("an upgrade keeps writing Chinese, a fresh install follows the interface, and a stored choice is kept", () => {
  assert.equal(loadSettings({}).settings.noteLanguage, "auto")
  const upgraded = loadSettings({ folder: "Meetings", llmBaseUrl: "https://api.deepseek.com" })
  assert.equal(upgraded.settings.noteLanguage, "zh")
  assert.equal(upgraded.migrated, true, "the decision is written back")
  assert.equal(loadSettings({ version: 2, folder: "Meetings", noteLanguage: "en", llmPreset: "deepseek" }).settings.noteLanguage, "en")
  assert.equal(loadSettings({ version: 2, folder: "Meetings", noteLanguage: "auto", llmPreset: "deepseek" }).settings.noteLanguage, "auto")
  assert.equal(loadSettings({ version: 2, noteLanguage: "fr", llmPreset: "deepseek" }).settings.noteLanguage, "auto")
})

test("the note language is the interface language when automatic, and the chosen one otherwise", () => {
  setLanguage("ja")
  assert.equal(resolveNoteLang("auto"), "en")
  assert.equal(resolveNoteLang("zh"), "zh")
  setLanguage("zh-TW")
  assert.equal(resolveNoteLang("auto"), "zh")
  assert.equal(resolveNoteLang("en"), "en")
  assert.equal(noteLang({ noteLanguage: "auto" }), "zh")
  // The interface and the notes are independent.
  assert.equal(fakeSession({ settings: { noteLanguage: "en" } }).session.noteLang, "en")
})

test("the summary in English has English labels and keeps what the model wrote", () => {
  setLanguage("zh-CN")
  const { session } = fakeSession({ settings: { noteLanguage: "en" } })
  const md = session.noteSummary().markdown
  for (const label of ["## AI stage summary", "> [!caution] AI-generated", "### Meeting overview · up to 00:30", "**To-do**", "**Open questions**", "### Stage 1", "### Stage 2", "### Stage 3", "This stage had nothing substantial to summarize."]) {
    assert.ok(md.includes(label), `missing ${label}`)
  }
  assert.match(md, /==Highlighted== figures were not found/)
  assert.match(md, /\*\*预算\*\*: 收入 3 亿/, "the topic separator follows the language")
  assert.match(md, /### 渠道\n/, "a title the model gave stays as it is")
  // None of the plugin's Chinese labels is left; what Chinese remains is the model's own text.
  for (const label of ["待办", "未决", "阶段", "会议概览", "截至", "AI 生成", "高亮", "没有可提炼"]) assert.ok(!md.includes(label), `${label} is still there`)
})

test("transcript header, gap lines, provider names and dates follow the language they are asked in", () => {
  const meta = { id: "m-1", notePath: "Daily/a.md", createdAt: "2026-10-27T14:30:00+08:00" }
  assert.equal(providerNameIn("volc", "en"), "Volcengine")
  assert.equal(providerNameIn("volc", "zh"), "火山引擎")
  assert.equal(providerNameIn("openai-compat", "en"), "OpenAI-compatible")
  const header = transcriptHeader(meta, providerNameIn("volc", "en"), "en")
  assert.match(header, /> \[!info\] Raw transcript produced by Volcengine live speech recognition/)
  assert.doesNotMatch(header, HAN)
  const gap = { startMs: 6000, endMs: 9000, reason: "网络中断", code: "overflow" as const }
  assert.equal(gapLine(gap, "en"), "> [!warning] Transcript gap 00:00:06 – 00:00:09: The network was down for longer than the buffer holds; this stretch could not be transcribed. The recording is saved and that stretch can be played back.\n\n")
  assert.match(gapLine(gap, "zh"), /转写缺口 00:00:06 – 00:00:09：网络中断超过缓冲时长，该时段未能转写。录音已保存/)
  // A gap recorded by 1.0.1 has no code and keeps its stored reason.
  assert.match(gapLine({ startMs: 0, endMs: 1000, reason: "网络中断" }, "en"), /: 网络中断\. The recording is saved/)
  assert.equal(formatShortDateTime(new Date(2026, 9, 27, 14, 30), "en"), "Oct 27, 14:30")
  assert.equal(formatShortDateTime(new Date(2026, 9, 27, 14, 30), "zh"), "10月27日 14:30")
})

test("interview records and speaker labels in English", () => {
  const result = { durationMs: 10000, text: "t", utterances: [{ text: "Hello.", startMs: 0, endMs: 2000, speaker: "1" }, { text: "Revenue is 3 billion.", startMs: 2500, endMs: 9500, speaker: "2" }], chunks: 2 }
  const md = renderInterviewRecord(result, { title: "Interview", source: "a.mp3", transcribedAt: "2026-10-27 14:30", lang: "en", provider: "Volcengine", model: "volc.seedasr.auc" }, true)
  assert.doesNotMatch(md, HAN)
  for (const part of ["## Interview notes · a.mp3", "> [!info] Raw transcript from Volcengine file recognition (volc.seedasr.auc)", "Duration 00:00:10 · 2 speakers · 2 sentences · Transcribed 2026-10-27 14:30", "> Speaker numbers are told apart by voice", "recognized in 2 parts", "**Speaker 1** `00:00:00`"]) {
    assert.ok(md.includes(part), `missing ${part}`)
  }
  assert.equal(speakerUtterances(result, "en")[1].text, "Speaker 2: Revenue is 3 billion.")
  assert.equal(speakerUtterances(result, "zh")[1].text, "说话人2：Revenue is 3 billion.")
})

test("the transcript folder keeps an existing one, whichever name it has, and names a new one in the note language", () => {
  const exists = (...folders: string[]) => (path: string) => folders.includes(path)
  assert.equal(transcriptFolder("Meetings", "zh", exists()), "Meetings/录音转写")
  assert.equal(transcriptFolder("Meetings", "en", exists()), "Meetings/Recording transcripts")
  // Files already in the Chinese folder stay where they are when the notes switch to English, and the other way round.
  assert.equal(transcriptFolder("Meetings", "en", exists("Meetings/录音转写")), "Meetings/录音转写")
  assert.equal(transcriptFolder("Meetings", "zh", exists("Meetings/Recording transcripts")), "Meetings/Recording transcripts")
  assert.equal(transcriptFolder("Meetings", "en", exists("Meetings/录音转写", "Meetings/Recording transcripts")), "Meetings/Recording transcripts")
  assert.equal(transcriptFolder("Notes/会议", "zh", exists("Notes/会议/录音转写")), "Notes/会议/录音转写")
})

// ---------------------------------------------------------------- notes and transcripts written by 1.0.1 still read

test("a transcript written by 1.0.1 in Chinese parses, links and gains English lines without losing any", () => {
  const legacy =
    "---\nmeeting: m-1\ntype: meeting-transcript\nnote: \"[[Daily/周会]]\"\ndate: 2026-10-27\n---\n\n> [!info] 由火山引擎实时语音识别生成的原始转写，按录音时间轴记录。时间点链接回会议笔记中对应的 AI 摘要；转写文字不会被改写。\n\n" +
    "![[Meetings/周会/audio/周会 录音 01.ogg]]\n\n" +
    "[00:00:03] 收入 3 亿，毛利 40% ^t3200-5600\n\n" +
    "> [!warning] 转写缺口 00:00:06 – 00:00:09：网络中断。录音已保存，可回放该时段。\n\n" +
    "[[Daily/周会#^m-1-s1|00:00:09]] 讨论预算 ^t9100-9900\n\n"
  const expected = [
    { startMs: 3200, endMs: 5600, text: "收入 3 亿，毛利 40%" },
    { startMs: 9100, endMs: 9900, text: "讨论预算" },
  ]
  assert.deepEqual(parseTranscript(legacy), expected)
  // New English lines appended to it, as happens after the language is switched, read the same.
  const mixed = legacy + gapLine({ startMs: 12000, endMs: 13000, reason: "x", code: "unconfigured" }, "en") + utteranceLine({ startMs: 14000, endMs: 15000, text: "next" })
  assert.deepEqual(parseTranscript(mixed), [...expected, { startMs: 14000, endMs: 15000, text: "next" }])
  // Linking back to the summary works on both and leaves the labels alone.
  const linked = linkTranscript(mixed, () => "Daily/周会")
  assert.equal(count(linked, "[[Daily/周会|"), 3)
  assert.ok(linked.includes("转写缺口 00:00:06"))
  assert.ok(linked.includes("Transcript gap 00:00:12"))
  // A session loads it as it always did.
  const { session } = fakeSession({ transcript: legacy })
  assert.deepEqual(session.utterances, expected)
})

test("the in-note job bar and the result placed over it do not depend on any label", () => {
  const id = newJobId()
  const note = appendJobBlock("## 速记\n- 李总\n", id, "访谈.mp3")
  assert.ok(hasJobBlock(note, id))
  const zh = placeJobResult(note, id, "## 访谈记录 · 访谈.mp3\n\n正文", "# 访谈")
  assert.equal(zh, "## 速记\n- 李总\n\n## 访谈记录 · 访谈.mp3\n\n正文\n")
  assert.equal(stripMeetingBlocks(`正文\n\n\`\`\`meeting-live\nid: ${ID}\n\`\`\`\n\n\`\`\`meeting-live-job\nid: ${id}\n\`\`\`\n`), "正文")
})

test("a note holding a 1.0.1 summary region gets one region back in English, with ticked to-dos still ticked", () => {
  const legacyRegion = `${LEGACY_START}\n## AI 阶段摘要\n\n### 阶段 1\n\n**待办**\n- [x] 交方案 ¥==500万== [[Meetings/周会/周会 原始转写#^t9100-9900|00:09]] ^${ID}-t9100\n- [ ] 补数据 [[Meetings/周会/周会 原始转写#^t9100-9900|00:09]]\n\n%% /meeting-live-summary ${ID} %%`
  const note = `# 周会\n\n\`\`\`meeting-live\nid: ${ID}\n\`\`\`\n\n${legacyRegion}\n\n我的速记\n`
  const { session } = fakeSession({ settings: { noteLanguage: "en" } })
  const edit = placeSummary(note, ID, session.noteSummary().markdown, "en")!
  const next = applyEdit(note, edit)
  assert.equal(count(next, `%% meeting-live-summary ${ID}`), 1, "one start marker")
  assert.equal(count(next, `%% /meeting-live-summary ${ID} %%`), 1, "one end marker")
  assert.ok(next.includes(`%% meeting-live-summary ${ID} · Maintained by Meeting Live; edits inside this region are overwritten %%`))
  assert.ok(!next.includes("由 Meeting Live 自动更新"))
  assert.match(next, /- \[x\] 交方案 .*00:09\]\]/, "the ticked to-do stays ticked")
  assert.match(next, /- \[ \] 补数据/)
  assert.ok(next.endsWith("\n\n我的速记\n"), "text around the region is untouched")
  assert.ok(next.includes("**To-do**") && !next.includes("**待办**"))
})

test("switching the note language back and forth never duplicates the region or loses a tick", async () => {
  const { session, note, settings } = fakeSession({ settings: { noteLanguage: "zh" } })
  await session.publishSummary()
  const first = note.text
  assert.equal(count(first, "%% meeting-live-summary "), 1)
  assert.ok(first.includes("**待办**") && first.includes("## AI 阶段摘要"))
  // The user ticks a to-do in the note.
  note.text = note.text.replace("- [ ] 交方案", "- [x] 交方案")
  settings.noteLanguage = "en"
  await session.publishSummary()
  assert.equal(count(note.text, "%% meeting-live-summary "), 1)
  assert.equal(count(note.text, "%% /meeting-live-summary "), 1)
  assert.match(note.text, /\*\*To-do\*\*\n- \[x\] 交方案/)
  assert.ok(!note.text.includes("**待办**"))
  settings.noteLanguage = "zh"
  await session.publishSummary()
  assert.equal(note.text, first.replace("- [ ] 交方案", "- [x] 交方案"), "back in Chinese it reads exactly as the first time, with the tick")
  // Publishing again changes nothing.
  const before = note.text
  await session.publishSummary()
  assert.equal(note.text, before)
})

test("a to-do ticked while the highlight sat beside the currency symbol stays ticked now that the symbol is inside it", () => {
  const link = "[[Meetings/周会/周会 原始转写#^t9100-9900|00:09]]"
  const written = `${LEGACY_START}\n## AI 阶段摘要\n\n**待办**\n- [x] 交方案 ¥==500万== ${link} ^${ID}-t9100\n- [ ] 补数据 ${link}\n\n%% /meeting-live-summary ${ID} %%`
  const note = `\`\`\`meeting-live\nid: ${ID}\n\`\`\`\n\n${written}\n`
  const body = `## AI 阶段摘要\n\n**待办**\n- [ ] 交方案 ==¥500万== ${link} ^${ID}-t9100\n- [ ] 补数据 ${link}`
  const next = applyEdit(note, placeSummary(note, ID, body, "zh")!)
  assert.match(next, /- \[x\] 交方案 ==¥500万== /)
  assert.match(next, /- \[ \] 补数据/)
  assert.equal(count(next, "%% meeting-live-summary "), 1)
})

test("Live Preview recognizes the region markers of every version and language, and the end marker alone", () => {
  const start = (suffix: string) => `%% meeting-live-summary ${ID} · ${suffix} %%`
  assert.ok(SUMMARY_MARKER_LINE.test(LEGACY_START), "1.0.1 start marker")
  assert.ok(SUMMARY_MARKER_LINE.test(start("Maintained by Meeting Live; edits inside this region are overwritten")), "English start marker")
  assert.ok(SUMMARY_MARKER_LINE.test(`${start("anything")}  `), "trailing spaces")
  const end = `%% /meeting-live-summary ${ID} %%`
  assert.equal(SUMMARY_MARKER_LINE.exec(end)?.[1], "/")
  assert.equal(SUMMARY_MARKER_LINE.exec(LEGACY_START)?.[1], "")
  for (const other of ["%% a comment %%", `%% meeting-live-summary x-1 · text %%`, `text %% meeting-live-summary ${ID} %%`]) assert.ok(!SUMMARY_MARKER_LINE.test(other), other)
  // The markers the plugin writes now, in either language, are what the pattern was made for.
  for (const lang of ["zh", "en"] as const) {
    const region = summaryRegion(ID, "body", lang).split("\n")
    assert.ok(SUMMARY_MARKER_LINE.test(region[0]) && SUMMARY_MARKER_LINE.test(region.at(-1)!))
  }
})

test("a folder setting with a trailing slash finds the existing transcript folder", () => {
  const exists = (...folders: string[]) => (path: string) => folders.includes(path)
  assert.equal(transcriptFolder("Meetings/", "en", exists("Meetings/录音转写")), "Meetings/录音转写")
  assert.equal(transcriptFolder("/Meetings//", "en", exists()), "Meetings/Recording transcripts")
  assert.equal(transcriptFolder("", "zh", exists()), "录音转写")
})
