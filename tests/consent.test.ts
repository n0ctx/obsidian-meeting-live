import assert from "node:assert/strict"
import { test } from "node:test"
import { contextDestination, destinations, ensureConsentFor, ensureContextConsent, liveIsLocal, needsConsent, seedConsent, type Destination } from "../src/consent.ts"
import { tr } from "../src/i18n/index.ts"
import { isLoopbackHost } from "../src/url.ts"
import { loadSettings, storedSettings } from "../src/settings.ts"
import { withAccount, volcAndDeepseek } from "./support/accounts.ts"

/** The account of a service in settings made of a Volcengine and a DeepSeek account. */
const account = (settings: ReturnType<typeof loadSettings>["settings"], service: string) => settings.accounts.find((a) => a.service === service)!

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
  const settings = volcAndDeepseek()
  assert.deepEqual(destinations(settings), [
    { kind: "live", name: "火山引擎", host: "openspeech.bytedance.com" },
    { kind: "file", name: "火山引擎", host: "openspeech.bytedance.com" },
    { kind: "llm", name: "api.deepseek.com", host: "api.deepseek.com", detail: "deepseek-flash" },
  ])
  account(settings, "deepseek").options.baseUrl = ""
  account(settings, "volc").options.endpoint = "nonsense"
  assert.deepEqual(destinations(settings).map((d) => d.kind), ["file"])
  // With no account in a role there is nowhere to send to, so nothing is listed.
  assert.deepEqual(destinations(loadSettings(null).settings), [])
})

test("a new install is asked once; saying yes records every destination and stops the questions", async () => {
  const settings = volcAndDeepseek()
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
  const settings = volcAndDeepseek()
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
  const deepseek = account(settings, "deepseek")
  deepseek.options.baseUrl = "https://api.deepseek.com/v1"
  assert.equal(await ensureConsentFor(settings, never, noSave), true)

  deepseek.options.baseUrl = "https://api.example.com/v1/chat/completions"
  const yes = asker()
  assert.equal(await ensureConsentFor(settings, yes.ask, noSave), true)
  assert.equal(yes.asked.length, 1)
  assert.deepEqual(yes.asked[0].find((d) => d.kind === "llm"), { kind: "llm", name: "api.example.com", host: "api.example.com", detail: "deepseek-flash" })
  assert.ok(settings.consent.includes("llm:api.example.com"))
  // Old agreements stay, so going back is not a new question.
  deepseek.options.baseUrl = "https://api.deepseek.com"
  assert.equal(await ensureConsentFor(settings, never, noSave), true)
})

test("a change of the live endpoint asks again", async () => {
  const { settings } = loadSettings(authorData())
  account(settings, "volc").options.endpoint = "wss://asr.example.com/stream"
  const yes = asker()
  assert.equal(await ensureConsentFor(settings, yes.ask, noSave), true)
  assert.equal(yes.asked.length, 1)
})

test("agreeing to send text to a host does not cover sending audio to it", () => {
  const settings = volcAndDeepseek()
  account(settings, "volc").options.endpoint = "wss://api.example.com/stream"
  account(settings, "deepseek").options.baseUrl = "https://api.example.com/v1"
  settings.consent = ["llm:api.example.com", "file:openspeech.bytedance.com"]
  assert.equal(needsConsent(settings), true)
  settings.consent.push("live:api.example.com")
  assert.equal(needsConsent(settings), false)
})

test("a flow that sends data to some destinations asks about those and records only those", async () => {
  const settings = volcAndDeepseek()
  assert.equal(needsConsent(settings, ["file", "llm"]), true)
  const yes = asker()
  assert.equal(await ensureConsentFor(settings, yes.ask, noSave, ["file", "llm"]), true)
  assert.deepEqual(yes.asked[0].map((d) => d.kind), ["file", "llm"])
  assert.deepEqual(settings.consent, ["file:openspeech.bytedance.com", "llm:api.deepseek.com"])
  // Live audio was not part of that agreement, so starting a recording still asks.
  assert.equal(needsConsent(settings), true)
  assert.equal(needsConsent(settings, ["file"]), false)
  assert.equal(await ensureConsentFor(settings, never, noSave, ["file", "llm"]), true)
})

test("the author, who agreed under 1.0.1, is not asked before recording to notes", async () => {
  const { settings } = loadSettings(authorData())
  assert.equal(await ensureConsentFor(settings, never, noSave, ["file", "llm"]), true)
})

test("the new services are asked about per destination: a region or a model service on another host asks again, and a Volcengine and DeepSeek user is not asked anything new", async () => {
  const volcUser = loadSettings(authorData()).settings
  assert.equal(needsConsent(volcUser), false, "the 1.0.1 yes still covers everything that user sends")

  const settings = loadSettings(null).settings
  const dashscope = withAccount(settings, "dashscope", { region: "cn" })
  const assemblyai = withAccount(settings, "assemblyai")
  withAccount(settings, "deepseek")
  settings.roles.live = dashscope.id
  settings.roles.file = assemblyai.id
  settings.roles.llm.account = account(settings, "deepseek").id
  settings.roles.llm.model = "deepseek-flash"
  const first = asker()
  assert.equal(await ensureConsentFor(settings, first.ask, noSave), true)
  assert.deepEqual(first.asked[0].map((d) => [d.kind, d.host]), [["live", "dashscope.aliyuncs.com"], ["file", "api.assemblyai.com"], ["llm", "api.deepseek.com"]])
  assert.equal(needsConsent(settings), false)

  // The same service in another region is another destination.
  dashscope.options.region = "intl"
  assemblyai.options.region = "eu"
  assert.equal(needsConsent(settings, ["live"]), true)
  assert.equal(needsConsent(settings, ["file"]), true)
  const second = asker()
  await ensureConsentFor(settings, second.ask, noSave, ["live"])
  assert.deepEqual(second.asked[0].map((d) => d.host), ["dashscope-intl.aliyuncs.com"], "only the destinations of the asked kinds are listed")
  assert.equal(needsConsent(settings, ["live"]), false)
  assert.equal(needsConsent(settings, ["file"]), true, "the file destination was not part of that question")

  // A model service preset on another host asks about the LLM only.
  account(settings, "deepseek").options.baseUrl = "https://api.moonshot.cn/v1"
  const third = asker()
  await ensureConsentFor(settings, third.ask, noSave, ["llm"])
  assert.deepEqual(third.asked[0].map((d) => d.host), ["api.moonshot.cn"])
})


test("a recognizer on this machine is still listed and agreed to, but marked as not leaving it; a LAN address is not", async () => {
  const settings = loadSettings(null).settings
  withAccount(settings, "sherpa")
  assert.deepEqual(destinations(settings).find((d) => d.kind === "live"), { kind: "live", name: "本地识别（sherpa-onnx）", host: "127.0.0.1:6006", local: true })
  assert.equal(liveIsLocal(settings), true)
  assert.equal(needsConsent(settings, ["live"]), true, "agreement is still asked for")
  const yes = asker()
  assert.equal(await ensureConsentFor(settings, yes.ask, noSave, ["live"]), true)
  assert.deepEqual(settings.consent, ["live:127.0.0.1:6006"])
  assert.equal(await ensureConsentFor(settings, never, noSave, ["live"]), true)

  // Moving the recognizer to another machine is a new destination that leaves this computer, so it asks again.
  const sherpa = account(settings, "sherpa")
  sherpa.options.endpoint = "ws://192.168.1.20:6006"
  assert.equal(liveIsLocal(settings), false)
  assert.equal(destinations(settings).find((d) => d.kind === "live")?.local, undefined)
  assert.equal(needsConsent(settings, ["live"]), true)
  for (const endpoint of ["ws://localhost:6006", "ws://[::1]:6006", "ws://127.0.0.5:6006"]) {
    sherpa.options.endpoint = endpoint
    assert.equal(liveIsLocal(settings), true, endpoint)
  }
  for (const host of ["127.0.0.1:6006", "localhost", "[::1]:6006", "127.1.2.3"]) assert.equal(isLoopbackHost(host), true, host)
  for (const host of ["192.168.1.20", "10.0.0.5:6006", "mac.local", "api.deepgram.com", "127.example.com"]) assert.equal(isLoopbackHost(host), false, host)
})

test("the privacy texts say audio stays on this machine for a local recognizer and keep saying it is streamed otherwise", () => {
  for (const lang of ["zh", "en"] as const) {
    assert.match(tr(lang, "card.privacyLocal", "X"), lang === "zh" ? /不会离开这台电脑/ : /does not leave this computer/)
    assert.doesNotMatch(tr(lang, "card.privacy", "X"), lang === "zh" ? /不会离开/ : /not leave/)
    assert.match(tr(lang, "settings.privacy.bodyLocal", "X"), lang === "zh" ? /不会离开这台电脑/ : /does not leave this computer/)
    assert.match(tr(lang, "consent.live.localText", "X", "127.0.0.1:6006"), /127\.0\.0\.1:6006/)
  }
})

test("agreeing to the audio does not agree to the speech context: it has its own key per host, never seeded from 1.0.x", async () => {
  const { settings } = loadSettings(authorData())
  assert.ok(settings.consent.includes("live:openspeech.bytedance.com"))
  assert.ok(seedConsent(settings).every((key) => !key.startsWith("asr-context:")))
  assert.deepEqual(contextDestination(settings, "live"), { kind: "asr-context", name: "火山引擎", host: "openspeech.bytedance.com", role: "live" })
  const yes = asker()
  assert.equal(await ensureContextConsent(settings, "live", (d) => yes.ask([d]), noSave, new Set()), true)
  assert.equal(yes.asked.length, 1)
  assert.ok(settings.consent.includes("asr-context:openspeech.bytedance.com"))
  // The file recognizer is on the same host, so its context is agreed to as well; asking about everything never lists it.
  assert.equal(await ensureContextConsent(settings, "file", never, noSave, new Set()), true)
  assert.ok(destinations(settings).every((d) => d.kind !== "asr-context"))
})

test("declining the speech context saves nothing and is not asked again while the plugin runs", async () => {
  const settings = volcAndDeepseek()
  settings.consent = ["live:openspeech.bytedance.com", "file:openspeech.bytedance.com", "llm:api.deepseek.com"]
  const declined = new Set<string>()
  const no = asker(false)
  let saved = 0
  assert.equal(await ensureContextConsent(settings, "live", (d) => no.ask([d]), async () => void saved++, declined), false)
  assert.equal(await ensureContextConsent(settings, "live", never, noSave, declined), false)
  assert.equal(no.asked.length, 1)
  assert.equal(saved, 0)
  assert.ok(!settings.consent.some((key) => key.startsWith("asr-context:")))
  // A recognizer that reads no context has nothing to ask about.
  const deepgram = withAccount(settings, "deepgram")
  settings.roles.live = deepgram.id
  assert.equal(contextDestination(settings, "live"), undefined)
  assert.equal(await ensureContextConsent(settings, "live", never, noSave, new Set()), false)
})
