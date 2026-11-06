import assert from "node:assert/strict"
import { test } from "node:test"
import { applyEdit, placeSummary, summaryRegion } from "../src/meeting/noteSummary.ts"

const note = (after: string) => `# 周会\n\n\`\`\`meeting-live\nid: m-1\n\`\`\`${after}`
const place = (content: string, body: string, id = "m-1") => {
  const edit = placeSummary(content, id, body)
  return edit ? applyEdit(content, edit) : undefined
}

test("the first summary goes right below the meeting block, before the notes that follow it", () => {
  assert.equal(place(note("\n速记\n"), "## AI 阶段摘要\n\n要点"), note(`\n\n${summaryRegion("m-1", "## AI 阶段摘要\n\n要点")}\n\n速记\n`))
  assert.equal(place(note("\n\n速记\n"), "要点"), note(`\n\n${summaryRegion("m-1", "要点")}\n\n速记\n`))
  assert.equal(place(note("\n"), "要点"), note(`\n\n${summaryRegion("m-1", "要点")}\n`))
  assert.equal(place(note(""), "要点"), note(`\n\n${summaryRegion("m-1", "要点")}`))
})

test("later summaries rewrite the region in place, wherever it has been moved", () => {
  const first = place(note("\n速记\n"), "第一版")!
  const moved = first.replace(`\n\n${summaryRegion("m-1", "第一版")}`, "") + `\n${summaryRegion("m-1", "第一版")}\n`
  const updated = place(moved, "第二版")!
  assert.equal(updated, moved.replace("第一版", "第二版"))
  assert.equal(placeSummary(updated, "m-1", "第二版"), undefined)
})

test("nothing is written without a summary, without the block, or for another meeting", () => {
  assert.equal(placeSummary(note("\n"), "m-1", ""), undefined)
  assert.equal(placeSummary("# 周会\n\n正文\n", "m-1", "要点"), undefined)
  assert.equal(placeSummary(note("\n"), "m-2", "要点"), undefined)
  const both = `${note("\n")}\n\`\`\`meeting-live\nid: m-2\n\`\`\`\n`
  assert.match(place(both, "二号要点", "m-2")!, /id: m-2\n```\n\n%% meeting-live-summary m-2 [^\n]*%%\n二号要点\n\n%% \/meeting-live-summary m-2 %%\n$/)
})

test("to-dos ticked in the note stay ticked after a rewrite", () => {
  const first = place(note("\n"), "- [ ] 【待办】交方案\n- [ ] 【待办】补数据")!
  const ticked = first.replace("- [ ] 【待办】交方案", "- [x] 【待办】交方案")
  const next = place(ticked, "- [ ] 【待办】交方案\n- [ ] 【待办】补数据\n- [ ] 【待办】约下次")!
  assert.match(next, /- \[x\] 【待办】交方案\n- \[ \] 【待办】补数据\n- \[ \] 【待办】约下次/)
})
