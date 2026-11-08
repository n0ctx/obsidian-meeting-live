import assert from "node:assert/strict"
import { test } from "node:test"
import { destinations, needsConsent } from "../src/consent.ts"
import { chatRequestBody } from "../src/llm/client.ts"
import { SETTINGS_VERSION, llmConfig, loadSettings, storedSettings } from "../src/settings.ts"

/** The author's 1.0.1 shape with placeholder prompts: Volcengine 1.0 streaming and 2.0 files, DeepSeek with low effort, one accepted consent. */
const author101 = () => ({
  folder: "Meetings",
  audioFormat: "ogg",
  volcApiKeySecret: "volc-api-key",
  volcResourceId: "volc.bigasr.sauc.duration",
  fileAsrResourceId: "volc.seedasr.auc",
  llmBaseUrl: "https://api.deepseek.com",
  llmModel: "deepseek-flash",
  llmEffort: "low",
  llmTemperature: 0.2,
  llmApiKeySecret: "deepseek-api-key",
  consentAccepted: true,
  minutesPrompt: "PLACEHOLDER-MINUTES-PROMPT",
  summaryFocus: "PLACEHOLDER-SUMMARY-FOCUS",
})

const hi = [{ role: "user" as const, content: "hi" }]

test("1.0.1 author shape: roles point at the two accounts, nothing is re-entered, the prompts and the downgrade keys survive", () => {
  const first = loadSettings(author101())
  const { settings } = first
  assert.deepEqual(settings.roles, { live: "volc", file: "volc", llm: { account: "deepseek", model: "deepseek-flash" } })
  const [volc, deepseek] = settings.accounts
  assert.equal(volc.apiKeySecret, "volc-api-key")
  assert.equal(volc.options.resourceId, "volc.bigasr.sauc.duration", "the 1.0 resource is kept, not moved to 2.0")
  assert.equal(volc.options.fileResourceId, "volc.seedasr.auc")
  assert.deepEqual([deepseek.apiKeySecret, deepseek.llm.effort, deepseek.llm.temperature], ["deepseek-api-key", "low", 0.2])
  assert.equal(settings.minutesPrompt, "PLACEHOLDER-MINUTES-PROMPT")
  assert.equal(settings.summaryFocus, "PLACEHOLDER-SUMMARY-FOCUS")

  const saved = storedSettings(settings, first.legacy)
  for (const [key, value] of Object.entries(author101())) if (key.startsWith("volc") || key.startsWith("llm") || key === "consentAccepted" || key === "fileAsrResourceId") assert.equal(saved[key], value, key)
  assert.equal(saved.version, SETTINGS_VERSION)
})

test("1.0.1 author shape: the DeepSeek request body is byte-identical to what 1.0.1 sent", () => {
  const config = llmConfig({ getSecret: () => "k" }, loadSettings(author101()).settings)
  assert.equal(config.apiKey, "k")
  assert.equal(JSON.stringify(chatRequestBody(config, hi)), '{"model":"deepseek-flash","messages":[{"role":"user","content":"hi"}],"temperature":0.2,"stream":false,"reasoning_effort":"low","thinking":{"type":"enabled"}}')
})

test("1.0.1 author shape: consent is not asked again, before or after a save", () => {
  const { settings, legacy } = loadSettings(author101())
  assert.deepEqual(settings.consent, ["live:openspeech.bytedance.com", "file:openspeech.bytedance.com", "llm:api.deepseek.com"])
  assert.equal(needsConsent(settings), false)
  const again = loadSettings(JSON.parse(JSON.stringify(storedSettings(settings, legacy)))).settings
  assert.equal(needsConsent(again), false)
  assert.deepEqual(destinations(again).map((d) => d.host), ["openspeech.bytedance.com", "openspeech.bytedance.com", "api.deepseek.com"])
  // Pointing an account at a host nobody agreed to does ask.
  again.accounts[1].options.baseUrl = "https://api.example.com/v1"
  assert.equal(needsConsent(again, ["llm"]), true)
  assert.equal(needsConsent(again, ["live", "file"]), false)
})

test("a development-build (version 2) file migrates: speech accounts, the model account, and what each role used", () => {
  const v2 = {
    version: 2,
    folder: "Notes",
    noteLanguage: "en",
    liveProvider: "dashscope",
    fileProvider: "openai-compat",
    asrLanguage: "zh",
    hotwords: "Alpha",
    providers: {
      volc: { apiKeySecret: "volc-key", resourceId: "volc.seedasr.sauc.duration" },
      dashscope: { region: "intl", apiKeySecret: "ds-key", model: "fun-asr-realtime" },
      openaiCompat: { baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo", apiKeySecret: "groq-key" },
      sherpa: { endpoint: "ws://127.0.0.1:6006" },
    },
    llmPreset: "qwen-intl",
    llmBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    llmModel: "qwen-plus",
    llmApiKeySecret: "ds-key",
    llmInputLimit: 50_000,
    consent: ["live:dashscope-intl.aliyuncs.com"],
  }
  const { settings } = loadSettings(v2)
  assert.deepEqual(settings.accounts.map((a) => [a.id, a.service, a.apiKeySecret]), [["volc", "volc", "volc-key"], ["dashscope", "dashscope", "ds-key"], ["groq", "groq", "groq-key"]])
  // The Qwen key is the DashScope key, so one account serves speech and the model.
  assert.deepEqual(settings.roles, { live: "dashscope", file: "groq", llm: { account: "dashscope", model: "qwen-plus" } })
  assert.equal(settings.accounts[1].llm.inputLimit, 50_000)
  assert.deepEqual([settings.accounts[1].options.region, settings.accounts[1].options.model], ["intl", "fun-asr-realtime"])
  assert.deepEqual([settings.accounts[2].options.baseUrl, settings.accounts[2].options.model], ["https://api.groq.com/openai/v1", "whisper-large-v3-turbo"])
  assert.deepEqual([settings.folder, settings.noteLanguage, settings.asrLanguage, settings.hotwords], ["Notes", "en", "zh", "Alpha"])
  assert.deepEqual(settings.consent, ["live:dashscope-intl.aliyuncs.com"], "what was agreed to is kept as it was")
  assert.equal(llmConfig({ getSecret: () => "k" }, settings).preset.id, "qwen-intl")
  // Written back, it reads back the same and is no longer flagged.
  const saved = JSON.parse(JSON.stringify(storedSettings(settings, {})))
  assert.equal(loadSettings(saved).migrated, false)
  assert.deepEqual(loadSettings(saved).settings, settings)
})

test("a development-build file with a service chosen but no key still keeps the choice, and a default section makes no account", () => {
  const { settings } = loadSettings({ version: 2, liveProvider: "deepgram", fileProvider: "deepgram", providers: { deepgram: { model: "nova-2" }, sherpa: {}, whisperLocal: {} } })
  assert.deepEqual(settings.accounts.map((a) => a.service), ["deepgram"])
  assert.deepEqual([settings.roles.live, settings.roles.file], ["deepgram", "deepgram"])
  const same = loadSettings({ version: 2, providers: {} }).settings
  assert.deepEqual(same.accounts, [])
})

test("the same key at the same service is one account, but a different key or region is another", () => {
  const split = loadSettings({ version: 2, liveProvider: "dashscope", providers: { dashscope: { region: "cn", apiKeySecret: "a" } }, llmBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", llmApiKeySecret: "b", llmModel: "qwen-plus" }).settings
  assert.deepEqual(split.accounts.map((a) => [a.service, a.apiKeySecret]), [["dashscope", "a"], ["dashscope", "b"]])
  const otherRegion = loadSettings({ version: 2, liveProvider: "dashscope", providers: { dashscope: { region: "intl", apiKeySecret: "a" } }, llmBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", llmApiKeySecret: "a", llmModel: "qwen-plus" }).settings
  assert.equal(otherRegion.accounts.length, 2)
})

test("migrating never turns the old settings into secrets or changes the key ids", () => {
  const { settings } = loadSettings(author101())
  const json = JSON.stringify(settings)
  assert.ok(json.includes("volc-api-key") && json.includes("deepseek-api-key"), "only the ids are kept")
  assert.equal(/"apiKey":/.test(json), false)
})
