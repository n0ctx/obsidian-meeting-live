// What the plugin writes into notes is worded in the note language, which the user chooses apart from the interface language.
import { resolveNoteLang, tr, type Lang } from "../i18n/index.ts"
import type { MeetingLiveSettings } from "../settings.ts"

/** The language of text written into notes under these settings. */
export const noteLang = (settings: Pick<MeetingLiveSettings, "noteLanguage">): Lang => resolveNoteLang(settings.noteLanguage)

/**
 * The folder raw transcripts of recordings go to, inside the meeting data folder. A folder that already exists keeps being used,
 * under whichever name it has, so files are never split between two folders by a change of language; the one in `lang` wins
 * when both exist, and a new one is named in `lang`.
 */
export function transcriptFolder(root: string, lang: Lang, exists: (path: string) => boolean): string {
  const other: Lang = lang === "zh" ? "en" : "zh"
  // A folder setting written as "Meetings/" must find the same folder as "Meetings".
  const base = root.replace(/^\/+|\/+$/g, "")
  const candidates = [lang, other].map((l) => [base, tr(l, "note.transcriptFolder")].filter(Boolean).join("/"))
  return candidates.find(exists) ?? candidates[0]
}
