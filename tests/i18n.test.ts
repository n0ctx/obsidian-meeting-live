import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { DICTIONARIES, langOf, t, tr, uiLang } from "../src/i18n/index.ts"
import { setLanguage } from "./support/obsidian.ts"

afterEach(() => setLanguage("zh-CN"))

const HAN = new RegExp("[\\u3400-\\u9fff\\uf900-\\ufaff]")
/** Names of a language in that language, which are the same in every interface language. */
const ENDONYMS = new Set(["settings.noteLanguage.zh"])
/** Messages that compute with their arguments (a month number picks a name), so text samples say nothing about them. */
const COMPUTES = new Set(["format.shortDateTime"])
const keys = (lang: "zh" | "en") => Object.keys(DICTIONARIES[lang]).sort()
/** Distinct text for each argument of a message, so what each language does with them can be compared. */
const sample = (message: (...args: string[]) => string) => message(...Array.from({ length: message.length }, (_, i) => `«${i}»`))

test("both languages have the same keys, none of them empty", () => {
  assert.deepEqual(keys("en"), keys("zh"))
  for (const lang of ["zh", "en"] as const) {
    for (const [key, message] of Object.entries(DICTIONARIES[lang])) {
      const text = typeof message === "function" ? sample(message as (...args: string[]) => string) : message
      assert.ok(typeof text === "string" && text.trim() !== "", `${lang} ${key} is empty`)
    }
  }
})

test("a message takes the same arguments in both languages, and English has no Chinese in it", () => {
  for (const key of keys("zh") as (keyof typeof DICTIONARIES.zh)[]) {
    const zh = DICTIONARIES.zh[key]
    const en = DICTIONARIES.en[key]
    assert.equal(typeof en, typeof zh, `${key} is a function in one language only`)
    if (typeof zh === "function" && typeof en === "function") {
      assert.equal((en as (...a: string[]) => string).length, zh.length, `${key} takes different arguments`)
      const used = (text: string) => [...text.matchAll(/«\d»/g)].map((m) => m[0]).sort()
      if (!COMPUTES.has(key)) assert.deepEqual(used(sample(en as (...a: string[]) => string)), used(sample(zh as (...a: string[]) => string)), `${key} shows different values`)
    }
    const text = typeof en === "function" ? sample(en as (...a: string[]) => string) : (en as string)
    if (!ENDONYMS.has(key)) assert.doesNotMatch(text, HAN, `${key} has Chinese in English`)
  }
})

test("any Chinese locale reads Chinese and every other language reads English", () => {
  for (const locale of ["zh", "zh-CN", "zh-TW", "ZH-hk"]) assert.equal(langOf(locale), "zh", locale)
  for (const locale of ["en", "en-GB", "ja", "ko", "de", "fr", "es", "pt-BR", "ru", "", "xzh"]) assert.equal(langOf(locale), "en", locale)
})

test("the interface language follows Obsidian's language", () => {
  setLanguage("zh-TW")
  assert.equal(uiLang(), "zh")
  assert.equal(t("asr.cancelled"), "已取消")
  setLanguage("ja")
  assert.equal(uiLang(), "en")
  assert.equal(t("asr.cancelled"), "Cancelled")
  assert.equal(t("asr.part", 2, 3, "boom"), "Part 2/3: boom")
  assert.equal(tr("zh", "asr.part", 2, 3, "boom"), "第 2/3 段：boom")
})
