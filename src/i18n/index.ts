// Interface and note text in two languages, without a dependency. Chinese is the source of truth for the shape of the
// dictionary: English is typed against it, so a key missing from either language is a type error.
import { getLanguage } from "obsidian"
import { en } from "./en.ts"
import { zh, type Dictionary } from "./zh.ts"

export type Lang = "zh" | "en"
export type Key = keyof Dictionary

/** The arguments a message takes: none for plain text, the function's own for messages with values in them. */
type Args<K extends Key> = Dictionary[K] extends (...args: infer A) => string ? A : []

export const DICTIONARIES: Record<Lang, Dictionary> = { zh, en }

/** Any Chinese locale (zh, zh-TW, ...) reads Chinese; every other language reads English. */
export function langOf(locale: string): Lang {
  return /^zh/i.test(locale) ? "zh" : "en"
}

/** The language of Obsidian's own interface, read at each use so the plugin follows it. */
export function uiLang(): Lang {
  return langOf(getLanguage())
}

/** Which language the plugin writes into notes in: the interface language, or one fixed. */
export type NoteLanguage = "auto" | Lang

export const NOTE_LANGUAGES: readonly NoteLanguage[] = ["auto", "zh", "en"]

export const isNoteLanguage = (value: unknown): value is NoteLanguage => (NOTE_LANGUAGES as readonly unknown[]).includes(value)

export const resolveNoteLang = (preference: NoteLanguage): Lang => (preference === "auto" ? uiLang() : preference)

/** A message in a given language. */
export function tr<K extends Key>(lang: Lang, key: K, ...args: Args<K>): string {
  const message = DICTIONARIES[lang][key] as string | ((...values: unknown[]) => string)
  return typeof message === "function" ? message(...args) : message
}

/** A message in the interface language. */
export function t<K extends Key>(key: K, ...args: Args<K>): string {
  return tr(uiLang(), key, ...args)
}
