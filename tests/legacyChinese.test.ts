// Output of 1.0.1 for a fixed meeting, kept exactly: labels written in Chinese must not drift, because opening a note
// rewrites its summary region whenever the text differs, and these labels are what older notes already contain.
import assert from "node:assert/strict"
import { test } from "node:test"
import { renderInterviewRecord } from "../src/asr/fileAsr.ts"
import { placeSummary } from "../src/meeting/noteSummary.ts"
import { gapLine, transcriptHeader, utteranceLine } from "../src/meeting/transcriptFormat.ts"
import { formatShortDateTime } from "../src/meeting/types.ts"
import { fakeSession, meetingMeta } from "./support/labelFixtures.ts"

const NOTE_SUMMARY = [
  "## AI 阶段摘要",
  "",
  "> [!caution] AI 生成，可能有遗漏或误读，以原始转写和录音为准。==高亮==的数字在转写里没有找到，请核对。",
  "",
  "### 会议概览 · 截至 00:30",
  "",
  "- **预算**：收入 3 亿，毛利 ==40%==。 [[Meetings/周会/周会 原始转写#^t3200-5600|00:03]]",
  "",
  "**待办**",
  "- [ ] 交方案 ¥==500万== [[Meetings/周会/周会 原始转写#^t9100-9900|00:09]]",
  "",
  "### 阶段 1",
  "",
  "**预算** [[Meetings/周会/周会 原始转写#^t3200-5600|00:03]]",
  "收入 3 亿，毛利 ==40%==。 ^m-20261027-abc123-s1",
  "",
  "**待办**",
  "- [ ] 交方案 ¥==500万== [[Meetings/周会/周会 原始转写#^t9100-9900|00:09]] ^m-20261027-abc123-t9100",
  "- [ ] 补数据 [[Meetings/周会/周会 原始转写#^t9100-9900|00:09]]",
  "",
  "**未决**",
  "- 是否扩招 [[Meetings/周会/周会 原始转写#^t3200-5600|00:03]]",
  "",
  "### 阶段 2",
  "",
  "本阶段没有可提炼的实质内容。 ^m-20261027-abc123-s2",
  "",
  "### 阶段 3",
  "",
  "模型原文 ^m-20261027-abc123-s3",
  "",
  "### 渠道",
  "",
  "渠道进展顺利。 [[Meetings/周会/周会 原始转写#^t20000-21000|00:20]] ^m-20261027-abc123-s4",
  "",
].join("\n")

const NOTE_SUMMARY_EMPTY_STAGE = [
  "## AI 阶段摘要",
  "",
  "> [!caution] AI 生成，可能有遗漏或误读，以原始转写和录音为准。==高亮==的数字在转写里没有找到，请核对。",
  "",
  "### 会议概览 · 截至 00:30",
  "",
  "- **预算**：收入 3 亿，毛利 ==40%==。 [[Meetings/周会/周会 原始转写#^t3200-5600|00:03]]",
  "",
  "**待办**",
  "- [ ] 交方案 ¥==500万== [[Meetings/周会/周会 原始转写#^t9100-9900|00:09]]",
  "",
  "### 阶段 2",
  "",
  "本阶段没有可提炼的实质内容。 ^m-20261027-abc123-s2",
  "",
].join("\n")

const MINUTES = [
  "---",
  "meeting: m-20261027-abc123",
  "type: meeting-minutes",
  "note: \"[[Daily/周会]]\"",
  "date: 2026-10-27",
  "transcript: \"[[Meetings/周会/周会 原始转写]]\"",
  "model: deepseek-flash",
  "generated: <time>",
  "---",
  "",
  "# 周会 纪要",
  "",
  "> [!caution] 本纪要由 AI 根据原始转写整理，发布前请对照转写与录音核实关键事实与数字。",
  "",
  "正文",
  "",
].join("\n")

const INTERVIEW_WITH_SPEAKERS = [
  "# 访谈",
  "",
  "## 访谈记录 · 访谈.mp3",
  "",
  "![[a/访谈.mp3]]",
  "",
  "> [!info] 火山引擎录音文件识别原始转写（volc.seedasr.auc）",
  "> 时长 00:00:10 · 2 位说话人 · 2 句 · 转写于 2026-10-27 14:30",
  "> 说话人编号由声音自动区分，不代表身份，请按实际人物替换。",
  "> 录音较长，分 2 段分别识别，说话人编号在各段之间不一定对应同一个人。",
  "",
  "**说话人 1** `00:00:00`",
  "您好。",
  "",
  "**说话人 2** `00:00:02`",
  "收入3亿。",
  "",
].join("\n")

const INTERVIEW_PLAIN = [
  "## 访谈记录 · 访谈.mp3",
  "",
  "> [!info] 火山引擎录音文件识别原始转写（volc.seedasr.auc）",
  "> 时长 00:00:10 · 2 句 · 转写于 2026-10-27 14:30",
  "",
  "`00:00:00`",
  "您好。收入3亿。",
  "",
].join("\n")

const record = { durationMs: 10000, text: "t", utterances: [{ text: "您好。", startMs: 0, endMs: 2000, speaker: "1" }, { text: "收入3亿。", startMs: 2500, endMs: 9500, speaker: "2" }], chunks: 2 }
const info = { title: "访谈", source: "访谈.mp3", vaultPath: "a/访谈.mp3", transcribedAt: "2026-10-27 14:30", provider: "火山引擎", model: "volc.seedasr.auc" }

test("the note summary reads as 1.0.1 wrote it", () => {
  assert.equal(fakeSession().session.noteSummary().markdown, NOTE_SUMMARY)
  const meta = meetingMeta()
  meta.summaries = meta.summaries.slice(1, 2)
  assert.equal(fakeSession({ meta }).session.noteSummary().markdown, NOTE_SUMMARY_EMPTY_STAGE)
})

test("the summary region markers read as 1.0.1 wrote them", () => {
  const edit = placeSummary("```meeting-live\nid: m-1\n```\n", "m-1", "要点")!
  assert.equal(edit.text, "\n\n%% meeting-live-summary m-1 · 由 Meeting Live 自动更新，此区域内的修改会被覆盖 %%\n要点\n\n%% /meeting-live-summary m-1 %%")
})

test("transcript header, gap lines and short dates read as 1.0.1 wrote them", () => {
  assert.equal(
    transcriptHeader({ id: "m-1", notePath: "Daily/周会.md", createdAt: "2026-10-27T14:30:00+08:00" }, "火山引擎"),
    "---\nmeeting: m-1\ntype: meeting-transcript\nnote: \"[[Daily/周会]]\"\ndate: 2026-10-27\n---\n\n> [!info] 由火山引擎实时语音识别生成的原始转写，按录音时间轴记录。时间点链接回会议笔记中对应的 AI 摘要；转写文字不会被改写。\n\n",
  )
  assert.equal(gapLine({ startMs: 6000, endMs: 9000, reason: "网络中断" }), "> [!warning] 转写缺口 00:00:06 – 00:00:09：网络中断。录音已保存，可回放该时段。\n\n")
  assert.equal(utteranceLine({ startMs: 3200, endMs: 5600, text: "收入 3 亿" }), "[00:00:03] 收入 3 亿 ^t3200-5600\n\n")
  assert.equal(formatShortDateTime(new Date(2026, 9, 27, 14, 30)), "10月27日 14:30")
})

test("the minutes document reads as 1.0.1 wrote it", async () => {
  const { session, written } = fakeSession()
  await session.generateMinutes("p", [])
  assert.equal(Object.values(written)[0].replace(/generated: .*/, "generated: <time>"), MINUTES)
  assert.deepEqual(Object.keys(written), ["Meetings/周会/周会 正式纪要.md"])
})

test("interview records read as 1.0.1 wrote them", () => {
  assert.equal(renderInterviewRecord(record, info, true), INTERVIEW_WITH_SPEAKERS)
  assert.equal(renderInterviewRecord({ ...record, chunks: undefined, utterances: record.utterances.map((u) => ({ ...u, speaker: undefined })) }, { ...info, vaultPath: undefined }, false), INTERVIEW_PLAIN)
})
