// The recognition language the user picks once; each provider maps it to what its own service takes.

import { t, type Key } from "../i18n/index.ts"

export const ASR_LANGUAGES = ["auto", "zh", "en", "ja", "ko", "es", "fr", "de"] as const

export type AsrLanguage = (typeof ASR_LANGUAGES)[number]

export const isAsrLanguage = (value: unknown): value is AsrLanguage => (ASR_LANGUAGES as readonly unknown[]).includes(value)

const NAME_KEYS = { auto: "asrLang.auto", zh: "asrLang.zh", en: "asrLang.en", ja: "asrLang.ja", ko: "asrLang.ko", es: "asrLang.es", fr: "asrLang.fr", de: "asrLang.de" } as const satisfies Record<AsrLanguage, Key>

/** The language's name in the interface language, for the settings dropdown. */
export const asrLanguageName = (language: AsrLanguage): string => t(NAME_KEYS[language])

/** The ISO 639-1 code to send, or undefined to let the service detect the language. */
export function languageHint(language: AsrLanguage): string | undefined {
  return language === "auto" ? undefined : language
}
