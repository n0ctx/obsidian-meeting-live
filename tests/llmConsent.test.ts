import assert from "node:assert/strict"
import { test } from "node:test"
import { withLlmConsent } from "../src/consent.ts"
import { MeetingSession } from "../src/meeting/session.ts"
import { stage, fakeSession, meetingMeta } from "./support/labelFixtures.ts"

const pending = () => {
  const meta = meetingMeta()
  meta.summaries = [stage(1, { status: "pending", content: undefined, utterances: [3200, 9100] })]
  meta.overview = undefined
  return meta
}
const settle = () => new Promise((r) => setImmediate(r))
const summaryJson = JSON.stringify({ title: "t", paragraphs: [{ topic: "a", text: "b", t: "00:00:03" }], todos: [], open: [] })

test("generating minutes for a meeting that is not recording sends nothing until the model service is agreed to", async () => {
  const blocked = fakeSession({ consented: false })
  await assert.rejects(() => blocked.session.generateMinutes("prompt", []), /agree|确认/)
  assert.equal(blocked.llmCalls.count, 0)
  assert.deepEqual(blocked.written, {})
  const allowed = fakeSession({ consented: true })
  await allowed.session.generateMinutes("prompt", [])
  assert.equal(allowed.llmCalls.count, 1)
})

test("an on-demand summary waits as pending until consent, then goes out once it is given", async () => {
  let consented = false
  const meta = meetingMeta()
  meta.summaries = []
  meta.overview = undefined
  const { session, llmCalls, env } = fakeSession({ meta, complete: async () => summaryJson })
  ;(env as { llmConsented: () => boolean }).llmConsented = () => consented
  assert.equal(session.summarizeNow(), true)
  await settle()
  assert.equal(llmCalls.count, 0, "nothing is sent before the user agrees")
  assert.equal(session.meta.summaries[0].status, "pending")
  consented = true
  await session.runQueue()
  assert.equal(session.meta.summaries[0].status, "done")
  assert.ok(llmCalls.count >= 1)
})

test("summaries still pending when a meeting is loaded are not sent without consent, and the queue does not spin", async () => {
  const { session, llmCalls } = fakeSession({ meta: pending(), consented: false })
  await Promise.race([session.runQueue(), new Promise((_, reject) => setTimeout(() => reject(new Error("the queue spins")), 1000))])
  assert.equal(llmCalls.count, 0)
  assert.equal(session.meta.summaries[0].status, "pending")
  assert.equal(session.llmConsented, false)
  // The overview is not merged either.
  const done = fakeSession({ consented: false })
  done.session.meta.overview = { stages: [] }
  await done.session.updateOverview()
  assert.equal(done.llmCalls.count, 0)
})

test("with consent the pending summary runs as before", async () => {
  const { session, llmCalls } = fakeSession({ meta: pending(), consented: true, complete: async () => summaryJson })
  await session.runQueue()
  assert.equal(session.meta.summaries[0].status, "done")
  assert.ok(llmCalls.count >= 1)
  assert.ok(session instanceof MeetingSession)
})

test("the dialogs ask only about the model service, and the action runs only after a yes", async () => {
  const asked: string[][] = []
  let ran = 0
  assert.equal(await withLlmConsent(async (kinds) => (asked.push(kinds), false), () => ran++), false)
  assert.equal(ran, 0)
  assert.equal(await withLlmConsent(async (kinds) => (asked.push(kinds), true), () => ran++), true)
  assert.equal(ran, 1)
  assert.deepEqual(asked, [["llm"], ["llm"]])
})
