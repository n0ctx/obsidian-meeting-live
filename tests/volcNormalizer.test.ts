import assert from "node:assert/strict"
import { test } from "node:test"
import { VolcNormalizer, utterancesOf, volcResultSink } from "../src/asr/providers/volc/normalize.ts"
import type { AsrUpdate } from "../src/asr/contract.ts"

const payload = (utterances: unknown[]) => ({ result: { text: "", utterances } })

test("utterances are read from both result shapes and junk is ignored", () => {
  assert.deepEqual(utterancesOf({ result: { utterances: [{ text: "a" }, null, 3] } }), [{ text: "a" }])
  assert.deepEqual(utterancesOf({ result: [{ utterances: [{ text: "a" }] }, { utterances: [{ text: "b" }] }] }), [{ text: "a" }, { text: "b" }])
  assert.deepEqual(utterancesOf(null), [])
  assert.deepEqual(utterancesOf({ result: { text: "" } }), [])
})

test("definite maps to final, text is trimmed, blanks are dropped, end never precedes start", () => {
  const update = new VolcNormalizer().update(
    payload([
      { text: " 好的 ", start_time: 100, end_time: 500, definite: true },
      { text: "  ", start_time: 600, end_time: 700, definite: true },
      { text: "后面", start_time: 800, end_time: 300, definite: false },
    ]),
    false,
  )
  assert.deepEqual(update.utterances, [
    { text: "好的", startMs: 100, endMs: 500, final: true },
    { text: "后面", startMs: 800, endMs: 800, final: false },
  ])
  assert.equal(update.keepInterims, false)
})

test("a missing start_time falls back to the first word, then to the previous utterance's end", () => {
  const update = new VolcNormalizer().update(
    payload([
      { text: "一", end_time: 400, definite: true, words: [{ start_time: 120 }] },
      { text: "二", end_time: 900, definite: true },
    ]),
    false,
  )
  assert.deepEqual(update.utterances.map((u) => [u.startMs, u.endMs]), [[120, 400], [400, 900]])
})

test("a result without utterances keeps what is in progress; the end of stream does not", () => {
  const n = new VolcNormalizer()
  assert.equal(n.update({ result: { text: "" } }, false).keepInterims, true)
  assert.equal(n.update({ result: { text: "" } }, true).keepInterims, false)
  // A blank-only result still says the in-progress text is gone.
  assert.equal(n.update(payload([{ text: "", start_time: 0, end_time: 0 }]), false).keepInterims, false)
})

test("an unconfirmed utterance the service moved past is promoted to final, one still in progress is not", () => {
  const n = new VolcNormalizer()
  n.update(payload([{ text: "第一句还在说", start_time: 1000, end_time: 9000, definite: false }]), false)
  // The later sentence starts at 9200: the first one ended 8 s earlier and was never confirmed.
  const moved = n.update(payload([{ text: "第二句", start_time: 9200, end_time: 9800, definite: true }]), false)
  assert.deepEqual(moved.utterances.map((u) => [u.text, u.final]), [["第一句还在说", true], ["第二句", true]])

  const m = new VolcNormalizer()
  m.update(payload([{ text: "第一句", start_time: 1000, end_time: 3000, definite: false }]), false)
  // The next one starts while the first still has more than a second to run: it is still in progress.
  const kept = m.update(payload([{ text: "开场。", start_time: 1500, end_time: 2500, definite: true }]), false)
  assert.deepEqual(kept.utterances.map((u) => u.text), ["开场。"])
})

test("a promoted utterance is not promoted twice", () => {
  const n = new VolcNormalizer()
  n.update(payload([{ text: "A", start_time: 0, end_time: 500, definite: false }]), false)
  const first = n.update(payload([{ text: "B", start_time: 5000, end_time: 5500, definite: false }]), false)
  assert.equal(first.utterances.filter((u) => u.final).length, 1)
  const second = n.update(payload([{ text: "B", start_time: 5000, end_time: 6000, definite: false }]), false)
  assert.equal(second.utterances.filter((u) => u.final).length, 0)
})

test("the sink forwards each payload with its end-of-stream flag", () => {
  const seen: [AsrUpdate, boolean][] = []
  const feed = volcResultSink({ onResult: (u, last) => seen.push([u, last]) })
  feed(payload([{ text: "好", start_time: 0, end_time: 100, definite: true }]), false)
  feed(null, true)
  assert.equal(seen[0][0].utterances[0].text, "好")
  assert.equal(seen[0][1], false)
  assert.deepEqual(seen[1], [{ utterances: [], keepInterims: false }, true])
})
