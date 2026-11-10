import assert from "node:assert/strict"
import { test } from "node:test"
import { languageHint } from "../src/asr/language.ts"
import { accountsFor } from "../src/accounts/roles.ts"
import { DEFAULT_SETTINGS, SETTINGS_VERSION, loadSettings, storedSettings } from "../src/settings.ts"
import { withAccount } from "./support/accounts.ts"

/** The shape of the author's data.json under 1.0.1, including keys no code reads any more. The prompts are placeholders. */
const authorData = () => ({
  folder: "Meetings",
  audioFormat: "ogg",
  deviceId: "",
  voiceProcessing: false,
  volcEndpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
  volcResourceId: "volc.bigasr.sauc.duration",
  volcAppId: "",
  volcApiKeySecret: "volc-api-key",
  volcAccessTokenSecret: "",
  volcEndWindowMs: 600,
  fileAsrResourceId: "volc.seedasr.auc",
  hotwords: "某某科技\n某某资本",
  llmProvider: "compatible",
  chatgptModel: "gpt-5",
  chatgptEffort: "low",
  transcriptShare: true,
  llmBaseUrl: "https://api.deepseek.com",
  llmModel: "deepseek-flash",
  llmEffort: "low",
  llmTemperature: 0.2,
  llmApiKeySecret: "deepseek-api-key",
  autoSummary: true,
  summaryIntervalMin: 5,
  summaryFocus: "PLACEHOLDER-FOCUS: figures and decisions.",
  minutesPrompt: "PLACEHOLDER-MINUTES: short formal minutes.",
  consentAccepted: true,
})

const DEAD_KEYS = ["llmProvider", "chatgptModel", "chatgptEffort", "transcriptShare"]

test("the author's 1.0.1 settings become a Volcengine account and a DeepSeek account, and every role points at them", () => {
  const { settings } = loadSettings(authorData())
  assert.equal(settings.version, SETTINGS_VERSION)
  assert.deepEqual(settings.accounts.map((a) => [a.id, a.service, a.apiKeySecret]), [["volc", "volc", "volc-api-key"], ["deepseek", "deepseek", "deepseek-api-key"]])
  const [volc, deepseek] = settings.accounts
  assert.deepEqual(volc.options, {
    endpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
    resourceId: "volc.bigasr.sauc.duration",
    appId: "",
    accessTokenSecret: "",
    endWindowMs: 600,
    fileResourceId: "volc.seedasr.auc",
    speakers: false,
    boostingTableId: "",
    correctTableId: "",
  })
  assert.deepEqual(deepseek.options, { baseUrl: "https://api.deepseek.com" })
  assert.deepEqual(deepseek.llm, { temperature: 0.2, effort: "low", inputLimit: 0, headers: "" })
  assert.deepEqual(settings.roles, { live: "volc", file: "volc", llm: { account: "deepseek", model: "deepseek-flash" } })
  // Everything outside the accounts is read as before, and the prompts the user wrote are kept.
  assert.equal(settings.hotwords, "某某科技\n某某资本")
  assert.equal(settings.summaryIntervalMin, 5)
  assert.equal(settings.summaryFocus, "PLACEHOLDER-FOCUS: figures and decisions.")
  assert.equal(settings.minutesPrompt, "PLACEHOLDER-MINUTES: short formal minutes.")
  assert.equal(settings.noteLanguage, "zh", "notes written by 1.0.1 are Chinese")
  assert.equal(accountsFor(settings.accounts, "live").length, 1)
})

test("1.0.1 settings with no prompt of their own get the current defaults, and with no key or custom address become no account", () => {
  const { settings } = loadSettings({ volcApiKeySecret: "k", llmBaseUrl: "https://api.deepseek.com" })
  assert.equal(settings.summaryFocus, DEFAULT_SETTINGS.summaryFocus)
  assert.equal(settings.minutesPrompt, DEFAULT_SETTINGS.minutesPrompt)
  // The DeepSeek address is the default and no key was given: nothing to carry over, and nothing pretends to work.
  assert.deepEqual(settings.accounts.map((a) => a.service), ["volc"])
  assert.deepEqual(settings.roles.llm, { account: "", model: "" })
  // An address the user chose is a decision even without a key, as a local server needs none.
  const local = loadSettings({ llmBaseUrl: "http://10.0.0.5:8000/v1", llmModel: "qwen" }).settings
  assert.deepEqual(local.accounts.map((a) => [a.service, a.options.baseUrl]), [["custom", "http://10.0.0.5:8000/v1"]])
  assert.deepEqual(local.roles.llm, { account: "custom", model: "qwen" })
})

test("what is saved keeps the 1.0.1 keys exactly as found, the LLM ones too, and drops the dead ones", () => {
  const original = authorData()
  const loaded = loadSettings(original)
  // The user changes the resources in the new settings page.
  loaded.settings.accounts[0].options.resourceId = "volc.seedasr.sauc.duration"
  loaded.settings.accounts[0].options.fileResourceId = "volc.bigasr.auc"
  loaded.settings.accounts[1].llm.effort = "high"
  loaded.settings.roles.llm.model = "deepseek-v4-pro"
  const saved = storedSettings(loaded.settings, loaded.legacy)

  // 1.0.1 keeps finding what it wrote, so a downgrade still runs.
  for (const key of ["volcResourceId", "fileAsrResourceId", "volcApiKeySecret", "volcEndWindowMs", "consentAccepted", "llmBaseUrl", "llmModel", "llmEffort", "llmTemperature", "llmApiKeySecret"]) {
    assert.deepEqual(saved[key], (original as Record<string, unknown>)[key], key)
  }
  assert.equal(Array.isArray(saved.consent), true)
  assert.equal((saved.accounts as { options: { resourceId: string } }[])[0].options.resourceId, "volc.seedasr.sauc.duration")
  for (const dead of DEAD_KEYS) assert.equal(dead in saved, false, dead)
  // No secret is ever written, only the ids the accounts name.
  assert.equal(JSON.stringify(saved).includes("key-value"), false)
  // Everything 1.0.1 reads is still there.
  for (const key of Object.keys(original)) if (!DEAD_KEYS.includes(key)) assert.ok(key in saved, key)
})

test("only data of an older shape is flagged for writing back", () => {
  assert.equal(loadSettings(authorData()).migrated, true)
  assert.equal(loadSettings(null).migrated, false)
  assert.equal(loadSettings({ version: 2, noteLanguage: "en" }).migrated, true, "the development shape is older too")
  const first = loadSettings(authorData())
  assert.equal(loadSettings(JSON.parse(JSON.stringify(storedSettings(first.settings, first.legacy)))).migrated, false)
})

test("saved settings load back unchanged, and loading twice changes nothing", () => {
  const first = loadSettings(authorData())
  const saved = JSON.parse(JSON.stringify(storedSettings(first.settings, first.legacy)))
  const second = loadSettings(saved)
  assert.deepEqual(second.settings, first.settings)
  assert.deepEqual(second.legacy, first.legacy)
  assert.deepEqual(JSON.parse(JSON.stringify(storedSettings(second.settings, second.legacy))), saved)
})

test("current settings win over leftover legacy keys, which are carried along untouched", () => {
  const first = loadSettings(authorData())
  const saved = JSON.parse(JSON.stringify(storedSettings(first.settings, first.legacy)))
  saved.accounts[0].options.resourceId = "volc.seedasr.sauc.duration"
  saved.accounts[1].apiKeySecret = "other-key"
  const { settings, legacy } = loadSettings(saved)
  assert.equal(settings.accounts[0].options.resourceId, "volc.seedasr.sauc.duration")
  // The account says which key it uses; the stale flat key is not read again.
  assert.equal(settings.accounts[1].apiKeySecret, "other-key")
  assert.equal(legacy.volcResourceId, "volc.bigasr.sauc.duration")
  assert.equal(legacy.llmApiKeySecret, "deepseek-api-key")
})

test("a fresh install has no account, writes no legacy keys, and never shares objects with the defaults", () => {
  const { settings, legacy } = loadSettings(null)
  assert.deepEqual(settings, DEFAULT_SETTINGS)
  assert.deepEqual(legacy, {})
  assert.deepEqual(settings.accounts, [])
  assert.deepEqual(settings.roles, { live: "", file: "", llm: { account: "", model: "" } })
  settings.roles.llm.model = "changed"
  withAccount(settings, "volc")
  assert.equal(DEFAULT_SETTINGS.roles.llm.model, "")
  assert.equal(DEFAULT_SETTINGS.accounts.length, 0)
  assert.equal(loadSettings(undefined).settings.roles.llm.model, "")
  assert.deepEqual(loadSettings("junk").settings, DEFAULT_SETTINGS)
})

test("values of the wrong type fall back to their defaults", () => {
  const { settings } = loadSettings({ folder: 3, autoSummary: "yes", volcApiKeySecret: "k", volcEndWindowMs: "800", volcResourceId: null, summaryIntervalMin: 10 })
  assert.equal(settings.folder, DEFAULT_SETTINGS.folder)
  assert.equal(settings.autoSummary, true)
  assert.equal(settings.accounts[0].options.endWindowMs, 800)
  assert.equal(settings.accounts[0].options.resourceId, "volc.seedasr.sauc.duration")
  assert.equal(settings.summaryIntervalMin, 10)
  // The same goes for what an account stores.
  const odd = loadSettings({ version: SETTINGS_VERSION, accounts: [{ id: "a", service: "deepgram", name: 5, apiKeySecret: null, options: { model: 4, diarize: "yes", endpoint: "wss://x/listen" }, llm: { temperature: "hot", effort: "extreme" } }, { id: "a", service: "deepgram" }, { id: "b", service: "no-such-service" }, "junk"], roles: { live: "a", file: "a", llm: { account: "a", model: 3 } } }).settings
  assert.deepEqual(odd.accounts.map((a) => a.id), ["a"], "an unknown service and a repeated id are dropped")
  assert.deepEqual(odd.accounts[0].options, { endpoint: "wss://x/listen", model: "nova-3", diarize: false })
  assert.deepEqual([odd.accounts[0].name, odd.accounts[0].apiKeySecret, odd.accounts[0].llm.temperature, odd.accounts[0].llm.effort], ["", "", 0.2, "low"])
  assert.deepEqual(odd.roles, { live: "a", file: "a", llm: { account: "", model: "" } }, "an account that cannot be the language model is not one")
})

test("a role that points at a missing account, or at one that cannot do the job, is cleared on load", () => {
  const stored = { version: SETTINGS_VERSION, accounts: [{ id: "dg", service: "deepgram" }, { id: "ds", service: "deepseek" }], roles: { live: "ds", file: "gone", llm: { account: "ds", model: "m" } } }
  const { settings } = loadSettings(stored)
  assert.deepEqual(settings.roles, { live: "", file: "", llm: { account: "ds", model: "m" } })
})

test("the recognition language defaults to auto, keeps a valid choice, and rejects an unknown one", () => {
  assert.equal(loadSettings(null).settings.asrLanguage, "auto")
  assert.equal(loadSettings(authorData()).settings.asrLanguage, "auto")
  assert.equal(loadSettings({ version: 2, asrLanguage: "zh" }).settings.asrLanguage, "zh")
  assert.equal(loadSettings({ version: 2, asrLanguage: "klingon" }).settings.asrLanguage, "auto")
  assert.equal(loadSettings({ version: 2, asrLanguage: 3 }).settings.asrLanguage, "auto")
})

test("auto leaves the language to the service, anything else is passed on as its ISO code", () => {
  assert.equal(languageHint("auto"), undefined)
  assert.equal(languageHint("zh"), "zh")
})

test("settings saved before the meeting background and the corrections existed load with both empty, and keep them once set", () => {
  const { settings } = loadSettings(authorData())
  assert.deepEqual([settings.meetingContext, settings.corrections], ["", ""])
  const saved = JSON.parse(JSON.stringify({ ...settings, meetingContext: "投后访谈", corrections: "兰箭→蓝箭" }))
  assert.deepEqual([loadSettings(saved).settings.meetingContext, loadSettings(saved).settings.corrections], ["投后访谈", "兰箭→蓝箭"])
})
