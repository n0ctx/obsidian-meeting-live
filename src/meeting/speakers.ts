// Speaker labels of live transcription. A label says who spoke by voice, not who the person is, so it is a short id
// ("1", "2", ...) that is worded and coloured only where it is shown.
import { tr, type Lang } from "../i18n/index.ts"
import type { Utterance } from "./types.ts"

/** What a speaker id may look like in a transcript line; anything else a recognizer sends is not stored. */
const SPEAKER_ID = /^[A-Za-z0-9]{1,8}$/

/** The id to keep for a recognizer's speaker label, or undefined when it cannot be written into a transcript line. */
export function speakerId(raw: string | undefined): string | undefined {
  return raw !== undefined && SPEAKER_ID.test(raw) ? raw : undefined
}

/** How many colours speakers cycle through; the card defines `--ml-speaker-1` … `--ml-speaker-N`. */
export const SPEAKER_COLORS = 6

/** The colour slot (1 … SPEAKER_COLORS) of a speaker: the same id always gets the same one, so colours are stable across reloads and reconnects. */
export function speakerColor(id: string): number {
  const n = /^\d+$/.test(id) ? Number(id) : [...id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0)
  return ((Math.max(n, 1) - 1) % SPEAKER_COLORS) + 1
}

/** "说话人 1" or "Speaker 1". */
export const speakerName = (lang: Lang, id: string): string => tr(lang, "speaker.name", id)

/** The utterance as a line of text with its speaker named in front, for the model and for plain-text copies. */
export function labelledText(u: Pick<Utterance, "text" | "speaker">, lang: Lang): string {
  return u.speaker ? tr(lang, "speaker.line", speakerName(lang, u.speaker), u.text) : u.text
}

export const hasSpeakers = (utterances: Pick<Utterance, "speaker">[]): boolean => utterances.some((u) => u.speaker)
