import assert from "node:assert/strict"
import { test } from "node:test"
import { appendJobBlock, hasJobBlock, parseJobBlock, placeJobResult, removeJobBlock } from "../src/asr/jobBlock.ts"
import { stripMeetingBlocks } from "../src/llm/minutes.ts"

const id = "j-abc-12"

test("block is appended, parsed, and found only by its own id", () => {
  const note = appendJobBlock("## 速记\n- 一行\n", id, "访谈.m4a")
  assert.equal(note, "## 速记\n- 一行\n\n```meeting-live-job\nid: j-abc-12\nfile: 访谈.m4a\n```\n")
  assert.deepEqual(parseJobBlock("id: j-abc-12\nfile: 访谈.m4a"), { id, file: "访谈.m4a" })
  assert.ok(hasJobBlock(note, id))
  assert.ok(!hasJobBlock(note, "j-other"))
  assert.equal(appendJobBlock("", id, "a.mp3"), "```meeting-live-job\nid: j-abc-12\nfile: a.mp3\n```\n")
})

test("result replaces the block in place and keeps text written after it", () => {
  const note = appendJobBlock("## 速记\n- 一行", id, "a.mp3") + "\n- 等待时又写了一行\n"
  assert.equal(placeJobResult(note, id, "## 记录\n正文\n", "# 标题"), "## 速记\n- 一行\n\n## 记录\n正文\n\n- 等待时又写了一行\n")
})

test("empty note gets a heading; a removed block falls back to appending", () => {
  assert.equal(placeJobResult(appendJobBlock("", id, "a.mp3"), id, "正文", "# 标题"), "# 标题\n\n正文\n")
  assert.equal(placeJobResult("## 速记\n", id, "正文", "# 标题"), "## 速记\n\n正文\n")
  assert.equal(placeJobResult("", id, "正文", "# 标题"), "# 标题\n\n正文\n")
})

test("other jobs' blocks are untouched and removal tidies blank lines", () => {
  const two = appendJobBlock(appendJobBlock("前文", "j-one", "a.mp3"), id, "b.mp3")
  const removed = removeJobBlock(two, id)
  assert.ok(hasJobBlock(removed, "j-one"))
  assert.ok(!hasJobBlock(removed, id))
  assert.doesNotMatch(removed, /\n{3,}/)
})

test("job blocks are not sent to the model as manual notes", () => {
  assert.equal(stripMeetingBlocks(appendJobBlock("## 速记\n- 一行", id, "a.mp3")), "## 速记\n- 一行")
})
