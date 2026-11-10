// Before a stage is summarized, the same model is asked which words of its window were misheard names from the meeting's known
// terms. What it proposes is checked here, not trusted to the prompt: a fix must replace text that is in the window with one of the
// known terms, and must not change any number.
import type { AsrContext } from "../asr/context.ts"
import type { Correction } from "../asr/corrections.ts"
import type { Lang } from "../i18n/index.ts"
import type { Utterance } from "../meeting/types.ts"
import type { ChatMessage } from "./client.ts"
import { speakerCaution, transcriptLines } from "./summary.ts"

/** What a fix may correct towards: the hotwords, the scene, and the targets of the replacement tables. */
export interface CorrectionTerms {
  words: string[]
  scene: string
}

export function correctionTerms(context: AsrContext, tables: Correction[][]): CorrectionTerms {
  const words = [...new Set([...context.hotwords, ...tables.flat().map((pair) => pair.to)])]
  return { words, scene: context.scene ?? "" }
}

/** Nothing to correct towards, so nothing is asked. */
export const noTerms = (terms: CorrectionTerms) => terms.words.length === 0 && !terms.scene.trim()

const CONTRACT = `You check a meeting's speech-to-text transcript for proper nouns the recognizer misheard. You get the meeting's known terms (people, companies, products, abbreviations) and the transcript lines.

Report a fix only where a word in a line is a misrecognition of one of the known terms: it sounds alike or looks alike, and the term fits what is being said. "from" is the misheard text exactly as it appears in the line; "to" is the known term exactly as listed.

Rules:
- Never change numbers, amounts, dates, units or anything that is not a known term.
- Leave correct text alone. When unsure, leave it out.
- Reply with JSON only: {"fixes":[{"from":"","to":""}]}, with an empty list when nothing needs fixing.`

export function buildCorrectionMessages(utterances: Utterance[], terms: CorrectionTerms, lang: Lang): ChatMessage[] {
  const caution = speakerCaution(utterances)
  const user = [
    "Known terms:",
    terms.words.length ? terms.words.map((w) => `- ${w}`).join("\n") : "(none)",
    ...(terms.scene.trim() ? ["", `About the meeting: ${terms.scene.trim()}`] : []),
    "",
    "Transcript:",
    ...(caution ? [caution] : []),
    transcriptLines(utterances, lang),
  ].join("\n")
  return [
    { role: "system", content: CONTRACT },
    { role: "user", content: user },
  ]
}

/** The fixes the model proposed, before any check; an unreadable reply proposes none. */
export function parseFixes(text: string): Correction[] {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")
  const start = stripped.indexOf("{")
  const end = stripped.lastIndexOf("}")
  if (start < 0 || end <= start) return []
  let data: unknown
  try {
    data = JSON.parse(stripped.slice(start, end + 1))
  } catch {
    return []
  }
  const fixes = (data as { fixes?: unknown }).fixes
  if (!Array.isArray(fixes)) return []
  return fixes.flatMap((raw) => {
    const fix = raw as { from?: unknown; to?: unknown }
    return typeof fix.from === "string" && typeof fix.to === "string" ? [{ from: fix.from.trim(), to: fix.to.trim() }] : []
  })
}

/** Digits and Chinese numerals in order: a fix that changes them changes a number or an amount. */
const NUMERALS = /[0-9０-９零〇一二两三四五六七八九十百千万亿]+/g
const numerals = (text: string) => (text.match(NUMERALS) ?? []).join("|")

/**
 * The proposed fixes that may be applied, longest first: `from` stands in the window as it is, `to` is a known term (or appears in the
 * scene), both are short words, and no number changes. Everything else is dropped, whatever the model said.
 */
export function acceptFixes(fixes: Correction[], utterances: Utterance[], terms: CorrectionTerms): Correction[] {
  const window = utterances.map((u) => u.text).join("\n")
  const known = new Set(terms.words)
  const seen = new Set<string>()
  const accepted: Correction[] = []
  for (const { from, to } of fixes) {
    const short = [...from].length <= 12 && [...to].length <= 12
    if (!from || !to || from === to || !short || seen.has(from)) continue
    if (!window.includes(from)) continue
    if (!known.has(to) && !terms.scene.includes(to)) continue
    if (numerals(from) !== numerals(to)) continue
    seen.add(from)
    accepted.push({ from, to })
  }
  return accepted.sort((a, b) => [...b.from].length - [...a.from].length)
}
