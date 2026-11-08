import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_SETTINGS, loadSettings, storedSettings } from "../src/settings.ts"

/** The shape of the author's data.json under 1.0.1, including keys no code reads any more. */
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
  llmTemperature: 0.2,
  llmEffort: "low",
  llmApiKeySecret: "deepseek-api-key",
  autoSummary: true,
  summaryIntervalMin: 5,
  consentAccepted: true,
})

test("the author's 1.0.1 settings migrate to the nested shape without losing anything", () => {
  const { settings } = loadSettings(authorData())
  assert.equal(settings.version, 2)
  assert.equal(settings.liveProvider, "volc")
  assert.equal(settings.fileProvider, "volc")
  assert.deepEqual(settings.providers.volc, {
    endpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
    resourceId: "volc.bigasr.sauc.duration",
    appId: "",
    apiKeySecret: "volc-api-key",
    accessTokenSecret: "",
    endWindowMs: 600,
    fileResourceId: "volc.seedasr.auc",
  })
  assert.equal(settings.llmApiKeySecret, "deepseek-api-key")
  assert.equal(settings.hotwords, "某某科技\n某某资本")
  assert.equal(settings.summaryIntervalMin, 5)
  // Not in the file, so the current default applies.
  assert.equal(settings.summaryFocus, DEFAULT_SETTINGS.summaryFocus)
})

test("what is saved keeps the 1.0.1 keys exactly as found and drops the dead ones", () => {
  const original = authorData()
  const loaded = loadSettings(original)
  // The user changes the resource in the new settings page.
  loaded.settings.providers.volc.resourceId = "volc.seedasr.sauc.duration"
  loaded.settings.providers.volc.fileResourceId = "volc.bigasr.auc"
  const saved = storedSettings(loaded.settings, loaded.legacy)

  assert.equal(saved.volcResourceId, "volc.bigasr.sauc.duration")
  assert.equal(saved.fileAsrResourceId, "volc.seedasr.auc")
  assert.equal(saved.volcApiKeySecret, "volc-api-key")
  assert.equal(saved.consentAccepted, true)
  assert.equal(Array.isArray(saved.consent), true)
  assert.equal(saved.volcEndWindowMs, 600)
  assert.equal((saved.providers as { volc: { resourceId: string } }).volc.resourceId, "volc.seedasr.sauc.duration")
  for (const dead of ["llmProvider", "chatgptModel", "chatgptEffort", "transcriptShare"]) assert.equal(dead in saved, false, dead)
  // Everything 1.0.1 reads is still there with its old value, except where the new version owns the setting.
  for (const key of Object.keys(original)) {
    if (["llmProvider", "chatgptModel", "chatgptEffort", "transcriptShare"].includes(key)) continue
    assert.ok(key in saved, key)
  }
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
  const saved = { ...authorData(), version: 2, providers: { volc: { resourceId: "volc.seedasr.sauc.duration" } } }
  const { settings, legacy } = loadSettings(saved)
  assert.equal(settings.providers.volc.resourceId, "volc.seedasr.sauc.duration")
  // A key missing from the nested object is the default, not the stale flat value.
  assert.equal(settings.providers.volc.apiKeySecret, "")
  assert.equal(legacy.volcResourceId, "volc.bigasr.sauc.duration")
})

test("a fresh install gets the defaults, writes no legacy keys, and never shares objects with them", () => {
  const { settings, legacy } = loadSettings(null)
  assert.deepEqual(settings, DEFAULT_SETTINGS)
  assert.deepEqual(legacy, {})
  settings.providers.volc.appId = "changed"
  assert.equal(DEFAULT_SETTINGS.providers.volc.appId, "")
  assert.equal(loadSettings(undefined).settings.providers.volc.appId, "")
  assert.deepEqual(loadSettings("junk").settings, DEFAULT_SETTINGS)
})

test("values of the wrong type fall back to their defaults", () => {
  const { settings } = loadSettings({ folder: 3, autoSummary: "yes", volcEndWindowMs: "800", volcResourceId: null, summaryIntervalMin: 10 })
  assert.equal(settings.folder, DEFAULT_SETTINGS.folder)
  assert.equal(settings.autoSummary, true)
  assert.equal(settings.providers.volc.endWindowMs, 800)
  assert.equal(settings.providers.volc.resourceId, DEFAULT_SETTINGS.providers.volc.resourceId)
  assert.equal(settings.summaryIntervalMin, 10)
})
