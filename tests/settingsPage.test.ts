import assert from "node:assert/strict"
import { test } from "node:test"
import { MeetingLiveSettingTab, type SettingsHost } from "../src/settingsTab.ts"
import { loadSettings, type MeetingLiveSettings } from "../src/settings.ts"
import { setLanguage, settingRows, type FakeEl } from "./support/obsidian.ts"
import { withAccount } from "./support/accounts.ts"

/** The page as Obsidian would draw it, with inert controls: what is on it is what a person would see. */
function page(settings: MeetingLiveSettings, open: (tab: MeetingLiveSettingTab) => void = () => undefined) {
  const host: SettingsHost = { settings, saveSettings: async () => undefined, get: async () => ({ status: 404, text: "" }), post: async () => ({ status: 404, text: "" }) }
  const app = { secretStorage: { getSecret: () => null, setSecret: () => undefined } }
  const tab = new MeetingLiveSettingTab(app as never, host as never)
  open(tab)
  tab.display()
  const el = tab.containerEl as unknown as FakeEl
  return { tab, rows: settingRows(el).map((row) => row.name), count: settingRows(el).length }
}

const author = () =>
  loadSettings({ volcApiKeySecret: "volc-api-key", volcResourceId: "volc.bigasr.sauc.duration", fileAsrResourceId: "volc.seedasr.auc", llmBaseUrl: "https://api.deepseek.com", llmModel: "deepseek-flash", llmEffort: "low", llmTemperature: 0.2, llmApiKeySecret: "deepseek-api-key", consentAccepted: true }).settings

test("a fresh install shows at most 12 rows with everything advanced collapsed, and the first of them adds an account", () => {
  setLanguage("zh-CN")
  const { count, rows } = page(loadSettings(null).settings)
  assert.ok(count <= 12, `${count} rows: ${rows.join(" | ")}`)
  assert.equal(rows[0], "添加账号")
  assert.ok(!rows.includes("语言模型"), "no role pickers before there is an account to pick")
  assert.ok(!rows.includes("录音格式") && !rows.includes("语音增强"), "recording format and voice processing are under Advanced")
})

test("the migrated 1.0.1 configuration stays within about 15 rows, with its two accounts and the three role pickers", () => {
  setLanguage("en")
  const { count, rows } = page(author())
  assert.ok(count <= 16, `${count} rows: ${rows.join(" | ")}`)
  assert.deepEqual(rows.filter((r) => ["Live transcription", "Recorded files", "Language model", "Model"].includes(r)), ["Live transcription", "Recorded files", "Language model", "Model"])
  assert.equal(rows.filter((r) => r === "Volcengine" || r === "DeepSeek").length, 2)
  setLanguage("zh-CN")
})

test("the add form shows only when asked for, on a fresh install too", () => {
  const settings = author()
  const closed = page(settings).count
  const form = page(settings, (tab) => (tab.addFormOpen = true))
  assert.ok(form.count > closed - 1 && form.rows.includes("API Key"), "the form has a key field")
  assert.ok(form.rows.includes("服务"))
  // A fresh install landing on the form (the card's Add account link) shows it at once.
  const landed = page(loadSettings(null).settings, (tab) => (tab.addFormOpen = true))
  assert.ok(landed.rows.includes("API Key") && landed.rows.includes("服务"))
  assert.ok(landed.count <= 14, `${landed.count}`)
})

test("role pickers appear only once an account exists, and the model row only with a language-model account", () => {
  const settings = loadSettings(null).settings
  withAccount(settings, "deepgram", { key: "dg" })
  const { rows } = page(settings)
  assert.ok(rows.includes("实时转写") && rows.includes("录音文件转写") && rows.includes("语言模型"))
  assert.ok(!rows.includes("模型"), "Deepgram has no language model")
})

test("both languages draw the same page", () => {
  const counts = ["zh-CN", "en"].map((lang) => {
    setLanguage(lang)
    return [loadSettings(null).settings, author()].map((settings) => page(settings).count)
  })
  setLanguage("zh-CN")
  assert.deepEqual(counts[0], counts[1])
})
