// The recognition language the user picks once; each provider maps it to what its own service takes.

export const ASR_LANGUAGES = [
  { id: "auto", name: "自动检测" },
  { id: "zh", name: "中文" },
  { id: "en", name: "English" },
  { id: "ja", name: "日本語" },
  { id: "ko", name: "한국어" },
  { id: "es", name: "Español" },
  { id: "fr", name: "Français" },
  { id: "de", name: "Deutsch" },
] as const

export type AsrLanguage = (typeof ASR_LANGUAGES)[number]["id"]

export const isAsrLanguage = (value: unknown): value is AsrLanguage => ASR_LANGUAGES.some((l) => l.id === value)

/** The ISO 639-1 code to send, or undefined to let the service detect the language. */
export function languageHint(language: AsrLanguage): string | undefined {
  return language === "auto" ? undefined : language
}
