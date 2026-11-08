import assert from "node:assert/strict"
import { test } from "node:test"
import { applyEdit, placeSummary, summaryRegions } from "../src/meeting/noteSummary.ts"
import { markSummarySection, panelClasses } from "../src/ui/summaryPanel.ts"
import { fakeSession, meetingMeta, stage } from "./support/labelFixtures.ts"

const count = (text: string, part: string) => text.split(part).length - 1
const ID = "m-20261027-abc123"

/** A meeting with two stages, each with a to-do and a question of its own, and the overview over the first one. */
function twoStages(covered: number[]) {
  const meta = meetingMeta()
  const point = (text: string, t: number) => ({ text, t, unverified: [] })
  meta.summaries = [
    stage(1, { utterances: [3200], content: { title: "预算", paragraphs: [{ topic: "收入", text: "收入 3 亿。", t: 3200, unverified: [] }], todos: [point("交方案", 9100)], open: [point("是否扩招", 3200)] } }),
    stage(2, { utterances: [20000], content: { title: "渠道", paragraphs: [{ topic: "进展", text: "渠道进展顺利。", t: 20000, unverified: [] }], todos: [point("约客户", 20000)], open: [point("预算是否够", 20000)] } }),
  ]
  meta.overview = covered.length
    ? { stages: covered, content: { title: "", paragraphs: [{ topic: "预算", text: "收入 3 亿", t: 3200, unverified: [] }], todos: [point("交方案", 9100)], open: [point("是否扩招", 3200)] } }
    : undefined
  return meta
}

test("before an overview covers a stage the stage lists its own to-dos and questions; after, they are listed once under the overview", () => {
  const early = fakeSession({ meta: twoStages([]) }).session.noteSummary().markdown
  assert.equal(count(early, "交方案"), 1)
  assert.equal(count(early, "约客户"), 1)
  assert.equal(count(early, "是否扩招"), 1)
  assert.doesNotMatch(early.split("### ")[0], /待办/, "nothing above the first stage yet")

  const partly = fakeSession({ meta: twoStages([1]) }).session.noteSummary().markdown
  for (const text of ["交方案", "是否扩招", "约客户", "预算是否够"]) assert.equal(count(partly, text), 1, text)
  const [head, stage1, stage2] = partly.split(/^### /m)
  assert.match(head, /交方案[^]*是否扩招/, "stage 1's items sit under the overview")
  assert.doesNotMatch(stage1, /待办|未决/, "and not again under stage 1")
  assert.match(stage2, /#### 待办\n- \[ \] 约客户[^]*#### 未决\n- 预算是否够/, "stage 2 is not covered yet, so it lists its own")

  const late = fakeSession({ meta: twoStages([1, 2]) }).session.noteSummary().markdown
  assert.equal(count(late, "待办"), 1)
  assert.equal(count(late, "约客户"), 0, "an overview that left it out is the only list")
  assert.equal(count(late, "收入 3 亿。"), 1, "every stage paragraph stays")
  assert.equal(count(late, "渠道进展顺利。"), 1)
})

test("an overview that failed to merge a stage leaves that stage's own lists in place", () => {
  const meta = twoStages([1])
  meta.overview!.error = "网络中断"
  const md = fakeSession({ meta }).session.noteSummary().markdown
  assert.equal(count(md, "约客户"), 1)
})

test("every block id is written once, and every transcript line links to a block that exists", () => {
  for (const covered of [[], [1], [1, 2]]) {
    const { markdown, anchors } = fakeSession({ meta: twoStages(covered) }).session.noteSummary()
    const ids = [...markdown.matchAll(/ \^(m-[\w-]+)$/gm)].map((m) => m[1])
    assert.equal(new Set(ids).size, ids.length, `no id repeats (covered ${covered})`)
    for (const id of anchors.values()) assert.ok(ids.includes(id), `${id} is in the note (covered ${covered})`)
    for (const id of ids) assert.match(id, /^m-\d{8}-[a-z0-9]+-[st]\d+$/)
    // The overview's to-do is a link target: the time 9100 cites it, nothing else does.
    if (covered.includes(1)) assert.equal(anchors.get(9100), `${ID}-t9100`)
  }
})

test("a stage's own point keeps the link of a time that an overview line cites too", () => {
  const { markdown, anchors } = fakeSession({ meta: twoStages([1]) }).session.noteSummary()
  assert.equal(anchors.get(3200), `${ID}-s1`, "the stage paragraph, not the overview's question")
  assert.doesNotMatch(markdown.split("### ")[0], / \^m-/, "the overview's question at the same time has no id of its own")
})

test("a to-do ticked under a stage in the old layout stays ticked in the merged list, whichever id and time link it had", () => {
  const link = "[[Meetings/周会/周会 原始转写#^t9100-9900|00:09]]"
  const old = [
    `%% meeting-live-summary ${ID} · 由 Meeting Live 自动更新，此区域内的修改会被覆盖 %%`,
    "## AI 阶段摘要",
    "",
    "> [!caution] AI 生成，可能有遗漏或误读，以原始转写和录音为准。",
    "",
    "### 会议概览 · 截至 00:30",
    "",
    "**待办**",
    `- [ ] 交方案 ==¥500万== ${link}`,
    `- [ ] 补数据 [[Meetings/周会/周会 原始转写#^t3200-5600|00:03]]`,
    "",
    "### 阶段 1",
    "",
    "**待办**",
    `- [x] 交方案 ¥500万 ${link} ^${ID}-t9100`,
    `- [x] 补数据 [[Meetings/周会/周会 原始转写#^t9100-9900|00:09]] ^${ID}-t4000`,
    "",
    `%% /meeting-live-summary ${ID} %%`,
  ].join("\n")
  const note = `# 周会\n\n\`\`\`meeting-live\nid: ${ID}\n\`\`\`\n\n${old}\n\n速记\n`
  const next = applyEdit(note, placeSummary(note, ID, fakeSession().session.noteSummary().markdown)!)
  assert.match(next, /^- \[x\] 交方案 ==¥500万== .*\^m-20261027-abc123-t9100$/m)
  assert.match(next, /^- \[x\] 补数据 \[\[/m)
  assert.equal(count(next, "- [ ]"), 0)
  assert.equal(count(next, "- [x]"), 2, "listed once each")
  assert.ok(next.endsWith("\n\n速记\n"))
  assert.ok(!next.includes("[!caution]") && !next.includes("**待办**"), "rewritten into the new layout")
})

test("a to-do ticked in the earliest layout (bold figures, a leading 【待办】) stays ticked too", () => {
  const old = `%% meeting-live-summary ${ID} · 由 Meeting Live 自动更新，此区域内的修改会被覆盖 %%\n### 阶段 1 · 00:00:00 – 00:05:00 · 预算\n- [x] 【待办】交方案 ¥**500万** [[Meetings/周会/周会 原始转写#^t9100-9900|00:09]] ^${ID}-t9100\n\n%% /meeting-live-summary ${ID} %%`
  const note = `\`\`\`meeting-live\nid: ${ID}\n\`\`\`\n\n${old}\n`
  const next = applyEdit(note, placeSummary(note, ID, fakeSession().session.noteSummary().markdown)!)
  assert.match(next, /^- \[x\] 交方案 ==¥500万== /m)
})

test("a rewrite is stable: publishing the same summary again changes nothing, and ticks survive each time", async () => {
  const { session, note } = fakeSession({ meta: twoStages([1]) })
  await session.publishSummary()
  note.text = note.text.replace("- [ ] 交方案", "- [x] 交方案")
  const ticked = note.text
  await session.publishSummary()
  assert.equal(note.text, ticked)
  assert.equal(count(note.text, "- [x] 交方案"), 1)
})

test("regions are found by their markers, old wording and new, in the lines of a note", () => {
  const lines = [
    "# 周会",
    `%% meeting-live-summary ${ID} · 由 Meeting Live 自动更新，此区域内的修改会被覆盖 %%`,
    "## AI 阶段摘要",
    "",
    "正文",
    "",
    `%% /meeting-live-summary ${ID} %%`,
    "速记",
    "%% meeting-live-summary m-20261028-zzz999 %%",
    "",
    "头",
    "",
    "- 条目",
    "",
    "脚",
    "",
    "%% /meeting-live-summary m-20261028-zzz999 %%",
    "%% meeting-live-summary m-20261029-open00 %%",
    "没有结束标记",
  ]
  assert.deepEqual(summaryRegions(lines), [
    { start: 1, end: 6, first: 2, last: 4 },
    { start: 8, end: 16, first: 10, last: 14 },
  ])
  assert.deepEqual(summaryRegions([`%% meeting-live-summary ${ID} %%`, `%% /meeting-live-summary ${ID} %%`]), [{ start: 0, end: 1, first: 0, last: 0 }])
})

test("lines of a region say where they sit: markers and the blanks next to them fold away, the first and last text line close the panel, blanks are gaps", () => {
  const span = { start: 1, end: 9, first: 3, last: 7 }
  assert.deepEqual(panelClasses(span, 1, false), ["ml-sum-marker"])
  assert.deepEqual(panelClasses(span, 9, false), ["ml-sum-marker"])
  assert.deepEqual(panelClasses(span, 2, true), ["ml-sum-marker"], "the blank line under the start marker is not part of the panel")
  assert.deepEqual(panelClasses(span, 8, true), ["ml-sum-marker"], "nor the one above the end marker")
  assert.deepEqual(panelClasses(span, 5, true), ["ml-sum", "ml-sum-gap"])
  assert.deepEqual(panelClasses(span, 3, false), ["ml-sum", "ml-sum-first"])
  assert.deepEqual(panelClasses(span, 5, false), ["ml-sum"])
  assert.deepEqual(panelClasses(span, 7, false), ["ml-sum", "ml-sum-last"])
})

test("reading view marks each section by its lines, so a section rendered later or again gets the same classes", () => {
  const text = ["前", "", `%% meeting-live-summary ${ID} %%`, "", "头", "", "- 条目", "", "### 阶段 · 00:00–00:30", "", "脚", "", `%% /meeting-live-summary ${ID} %%`, "", "后"].join("\n")
  const classesOf = (lineStart: number, lineEnd = lineStart) => {
    const el = { classes: [] as string[], addClass(c: string) { this.classes.push(c) } }
    markSummarySection(el as unknown as HTMLElement, { getSectionInfo: () => ({ text, lineStart, lineEnd }) } as never)
    return el.classes
  }
  assert.deepEqual(classesOf(0), [], "before the region")
  assert.deepEqual(classesOf(2), ["ml-sum-marker"])
  assert.deepEqual(classesOf(4), ["ml-sum", "ml-sum-first"])
  assert.deepEqual(classesOf(6), ["ml-sum"])
  assert.deepEqual(classesOf(8), ["ml-sum"])
  assert.deepEqual(classesOf(10), ["ml-sum", "ml-sum-last"])
  assert.deepEqual(classesOf(12), ["ml-sum-marker"])
  assert.deepEqual(classesOf(14), [], "after the region")
  assert.deepEqual(classesOf(4), classesOf(4), "again, the same")
  // Embeds and previews give no section info.
  const el = { classes: [] as string[], addClass(c: string) { this.classes.push(c) } }
  markSummarySection(el as unknown as HTMLElement, { getSectionInfo: () => null } as never)
  assert.deepEqual(el.classes, [])
})
