import assert from "node:assert/strict"
import { test } from "node:test"
import { destinations, ensureConsentFor, needsConsent, type Destination } from "../src/consent.ts"
import { loadSettings, storedSettings } from "../src/settings.ts"

/** The author's 1.0.1 data.json, as far as consent and destinations are concerned. */
const authorData = () => ({
  volcResourceId: "volc.bigasr.sauc.duration",
  volcApiKeySecret: "volc-api-key",
  volcAppId: "",
  volcAccessTokenSecret: "",
  fileAsrResourceId: "volc.seedasr.auc",
  llmApiKeySecret: "deepseek-api-key",
  consentAccepted: true,
})

function asker(answer = true) {
  const asked: Destination[][] = []
  return { asked, ask: async (d: Destination[]) => (asked.push(d), answer) }
}

const never = async () => assert.fail("should not ask")
const noSave = async () => undefined

test("destinations name the live, file and LLM hosts under the current settings", () => {
  const { settings } = loadSettings(null)
  assert.deepEqual(destinations(settings), [
    { kind: "live", name: "火山引擎", host: "openspeech.bytedance.com" },
    { kind: "file", name: "火山引擎", host: "openspeech.bytedance.com" },
    { kind: "llm", name: "api.deepseek.com", host: "api.deepseek.com", detail: "deepseek-flash" },
  ])
  settings.llmBaseUrl = ""
  settings.providers.volc.endpoint = "nonsense"
  assert.deepEqual(destinations(settings).map((d) => d.kind), ["file"])
})

test("a new install is asked once; saying yes records every destination and stops the questions", async () => {
  const { settings } = loadSettings(null)
  const yes = asker()
  let saved = 0
  assert.equal(await ensureConsentFor(settings, yes.ask, async () => void saved++), true)
  assert.equal(yes.asked.length, 1)
  assert.deepEqual(yes.asked[0].map((d) => d.kind), ["live", "file", "llm"])
  assert.deepEqual(settings.consent, ["live:openspeech.bytedance.com", "file:openspeech.bytedance.com", "llm:api.deepseek.com"])
  assert.equal(saved, 1)
  assert.equal(await ensureConsentFor(settings, never, noSave), true)
})

test("declining records nothing and blocks the start", async () => {
  const { settings } = loadSettings(null)
  let saved = 0
  assert.equal(await ensureConsentFor(settings, asker(false).ask, async () => void saved++), false)
  assert.deepEqual(settings.consent, [])
  assert.equal(saved, 0)
  assert.equal(needsConsent(settings), true)
})

test("the author, who accepted the single consent of 1.0.1, is not asked again", async () => {
  const { settings } = loadSettings(authorData())
  assert.deepEqual(settings.consent, ["live:openspeech.bytedance.com", "file:openspeech.bytedance.com", "llm:api.deepseek.com"])
  assert.equal(await ensureConsentFor(settings, never, noSave), true)
})

test("a consent seeded from the author's data survives a save and a load", async () => {
  const first = loadSettings(authorData())
  const stored = JSON.parse(JSON.stringify(storedSettings(first.settings, first.legacy)))
  assert.equal(stored.consentAccepted, true)
  const second = loadSettings(stored)
  assert.deepEqual(second.settings.consent, first.settings.consent)
  assert.equal(await ensureConsentFor(second.settings, never, noSave), true)
})

test("someone who never accepted 1.0.1 gets no seeded consent", () => {
  assert.deepEqual(loadSettings({ ...authorData(), consentAccepted: false }).settings.consent, [])
  const { settings } = loadSettings({ ...authorData(), consentAccepted: "yes" })
  assert.deepEqual(settings.consent, [])
})

test("moving to a host the user has not agreed to asks again, and a different path on the same host does not", async () => {
  const { settings } = loadSettings(authorData())
  settings.llmBaseUrl = "https://api.deepseek.com/v1"
  assert.equal(await ensureConsentFor(settings, never, noSave), true)

  settings.llmBaseUrl = "https://api.example.com/v1/chat/completions"
  const yes = asker()
  assert.equal(await ensureConsentFor(settings, yes.ask, noSave), true)
  assert.equal(yes.asked.length, 1)
  assert.deepEqual(yes.asked[0].find((d) => d.kind === "llm"), { kind: "llm", name: "api.example.com", host: "api.example.com", detail: "deepseek-flash" })
  assert.ok(settings.consent.includes("llm:api.example.com"))
  // Old agreements stay, so going back is not a new question.
  settings.llmBaseUrl = "https://api.deepseek.com"
  assert.equal(await ensureConsentFor(settings, never, noSave), true)
})

test("a change of the live endpoint asks again", async () => {
  const { settings } = loadSettings(authorData())
  settings.providers.volc.endpoint = "wss://asr.example.com/stream"
  const yes = asker()
  assert.equal(await ensureConsentFor(settings, yes.ask, noSave), true)
  assert.equal(yes.asked.length, 1)
})

test("agreeing to send text to a host does not cover sending audio to it", () => {
  const { settings } = loadSettings(null)
  settings.providers.volc.endpoint = "wss://api.example.com/stream"
  settings.llmBaseUrl = "https://api.example.com/v1"
  settings.consent = ["llm:api.example.com", "file:openspeech.bytedance.com"]
  assert.equal(needsConsent(settings), true)
  settings.consent.push("live:api.example.com")
  assert.equal(needsConsent(settings), false)
})
