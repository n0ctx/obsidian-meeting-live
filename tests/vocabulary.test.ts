import assert from "node:assert/strict"
import { test } from "node:test"
import { addsToTyped, asrContextFor } from "../src/asr/context.ts"
import { extractVocabulary, MAX_NOTE_WORDS } from "../src/asr/vocabulary.ts"

/** A post-investment interview note as people write them: properties of the author's own naming, the card, a summary, free notes. */
const NOTE = `---
被投企业: "[[青柠科技|青柠]]"
访谈对象:
  - 周明远
  - "[[郑书禾]]"
类型: 投后访谈
date: 2026-11-09
tags: [投后, 半导体]
轮次: B+
估值: 12
官网: https://example.com
aliases: [青柠半导体]
已归档: false
备注: 先看产能，再看客户。
---

## 会议

\`\`\`meeting-live
id: m-20261109-abc123
\`\`\`

%% meeting-live-summary m-20261109-abc123 %%
### 阶段摘要
- [[韩道明]] 说 HBM 产能吃紧 [[Meetings/青柠/原始转写#^t1-2|00:01]]
%% /meeting-live-summary m-20261109-abc123 %%

参会：[[孟星澜]]、财务总监。客户包括蓝箭，不展开。
- [ ] 跟进股东名册
- [x] 发送 [资料清单]
==不能超募== #重点
GPU 交付延期，ESOP 池子 10%，通过 SPV 持股。AI 和 IT 不算缩写。
参考《集成电路产业白皮书》
![[产能图.png]]
[[Meetings/青柠/原始转写|原始转写]]
兰箭→蓝箭
- 甲木 -> 甲沐
[[兰箭→蓝箭]]
`

test("a note gives its title, any property's short values, links, 《》 titles and acronyms, in that order", () => {
  const v = extractVocabulary(NOTE, "2026年11月09日青柠科技", { ignoreLinksUnder: ["Meetings"] })
  assert.deepEqual(v.hotwords, ["青柠科技", "青柠", "周明远", "郑书禾", "B+", "青柠半导体", "孟星澜", "集成电路产业白皮书", "GPU", "ESOP", "SPV"])
  assert.deepEqual(v.scene, ["投后访谈"])
})

test("what is not marked as a name is not taken: free text, tags, to-dos, highlights, two-letter acronyms, the summary and the card", () => {
  const words = new Set(extractVocabulary(NOTE, "2026-11-09 青柠科技").hotwords)
  for (const absent of ["蓝箭", "兰箭→蓝箭", "财务总监", "股东名册", "资料清单", "不能超募", "重点", "AI", "IT", "韩道明", "HBM", "产能图", "原始转写", "投后", "半导体", "先看产能，再看客户。"]) {
    assert.ok(!words.has(absent), `${absent} was taken`)
  }
  assert.ok(![...words].some((w) => /meeting|abc123|产能图/.test(w)), [...words].join("|"))
})

test("the title loses a leading date and counts only when it is not just an occasion word", () => {
  assert.deepEqual(extractVocabulary("", "20261109 甲乙资本").hotwords, ["甲乙资本"])
  assert.deepEqual(extractVocabulary("", "2026-11-09 访谈").hotwords, [])
  assert.deepEqual(extractVocabulary("", "2026年11月9日会议").hotwords, [])
  assert.deepEqual(extractVocabulary("", "这是一个超过十二个字的很长很长的笔记标题").hotwords, [])
})

test("only whole lines written as 错→对 are pairs; one inside a link is not", () => {
  assert.deepEqual(extractVocabulary(NOTE, "x").corrections, [
    { from: "兰箭", to: "蓝箭" },
    { from: "甲木", to: "甲沐" },
  ])
})

test("pairs inside the summary region or the card are not the user's", () => {
  const note = "```meeting-live\nid: m-1\n兰箭→蓝箭\n```\n%% meeting-live-summary m-1 %%\n丙→丁\n%% /meeting-live-summary m-1 %%\n"
  assert.deepEqual(extractVocabulary(note, "x").corrections, [])
})

test("a note saved with CRLF line ends keeps its summary region out; brackets, comments and occasion links give nothing", () => {
  const note = "---\r\npeople: [[[夏远]], [[王允执]]]\r\n---\r\n%% meeting-live-summary m-1 %%\r\n[[关羽]] 《坏书名》 ESOP\r\n%% /meeting-live-summary m-1 %%\r\n[[会议]] [[J.Smith]] ![[图.png]]\r\n%% 兰箭→蓝箭 %%\r\n```\r\n甲→乙\r\n```\r\n"
  const v = extractVocabulary(note, "11月9日 青柠科技")
  assert.deepEqual(v.hotwords, ["青柠科技", "夏远", "王允执", "J.Smith"])
  assert.deepEqual(v.corrections, [])
})

test("the note gives at most 40 words", () => {
  const links = Array.from({ length: 60 }, (_, i) => `[[名字${i}]]`).join(" ")
  const v = extractVocabulary(links, "标题甲")
  assert.equal(v.hotwords.length, MAX_NOTE_WORDS)
  assert.equal(v.hotwords[0], "标题甲")
})

test("the context puts the typed hotwords first; declined, it is the typed hotwords alone", () => {
  const v = extractVocabulary(NOTE, "2026年11月09日青柠科技")
  const settings = { hotwords: "甲乙资本\n青柠", meetingContext: "半导体行业的投后访谈" }
  const agreed = asrContextFor(settings, v, true)
  assert.deepEqual(agreed.hotwords.slice(0, 3), ["甲乙资本", "青柠", "青柠科技"])
  assert.equal(agreed.scene, "半导体行业的投后访谈；投后访谈")
  assert.deepEqual(asrContextFor(settings, v, false), { hotwords: ["甲乙资本", "青柠"] })
  // Nothing beyond the typed hotwords means nothing to ask about.
  assert.equal(addsToTyped({ hotwords: "青柠科技", meetingContext: " " }, extractVocabulary("", "青柠科技")), false)
  assert.equal(addsToTyped(settings, undefined), true)
})
