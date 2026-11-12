// Before a stage is summarized, the same model tidies the stage's transcript lines: punctuation, filler, stutters and misheard
// words, the names among them. It returns only the lines it changed. Each changed line is checked here, not trusted to the prompt:
// numbers stay, Latin words stay or become a known term, and the line keeps most of what was said, in order. A line that fails
// keeps its text.
import type { Lang } from "../i18n/index.ts"
import { labelledText } from "../meeting/speakers.ts"
import type { Utterance } from "../meeting/types.ts"
import type { ChatMessage } from "./client.ts"
import type { CorrectionTerms } from "./correction.ts"
import { speakerCaution } from "./summary.ts"

const CONTRACT = `You tidy one stretch of a meeting's speech-to-text transcript so it reads cleanly, without changing what anyone said or how the conversation goes. The lines are numbered; some begin with a speaker label.

In each line you may:
- fix punctuation: add commas, full stops and question marks where the speech pauses, ends or asks, and remove ones the recognizer put in the middle of a sentence;
- delete filler: hesitation sounds (嗯, 啊, 呃, 哎, um, uh), verbal tics and swearing used as filler (他妈的, 你知道吧), and words such as 就是, 那个, 然后, like, you know where they carry no meaning;
- delete stutters, words said twice in a row, and false starts the speaker abandoned;
- fix words the recognizer clearly misheard, when the context leaves no doubt about the intended word; a misheard known term becomes the term exactly as listed;
- write abbreviations and Latin words in their usual case and spacing (bd → BD).

Never:
- change, add or drop a number, amount, date, unit or name, except a misheard known term;
- add words, explanations or anything the speaker did not say, and never summarize: everything said that carries meaning stays;
- change who says what, the person (I, we, you), a question into a statement, or how sure or how strong a judgment sounds;
- move text between lines, merge, split or drop lines. A line that is only a reply or a sound (对, 好, 嗯) stays as it is.
When unsure about a word, leave it.

Reply with JSON only: {"lines":[{"n":1,"text":""}]}, listing only the lines you changed, each with its whole new text and without the speaker label. Leave out the lines you did not change; an empty list when none needs it.`

/** The speaker label is not part of the line's text; the model sees it to tell people apart. */
const numbered = (utterances: Utterance[], lang: Lang) => utterances.map((u, i) => `${i + 1}. ${labelledText(u, lang)}`).join("\n")

/** The known terms go before the lines, so the system prompt and the terms are a prefix the service can serve from its cache. */
export function buildPolishMessages(utterances: Utterance[], terms: CorrectionTerms, lang: Lang): ChatMessage[] {
  const caution = speakerCaution(utterances)
  const user = [
    "Known terms:",
    terms.words.length ? terms.words.map((w) => `- ${w}`).join("\n") : "(none)",
    ...(terms.scene.trim() ? ["", `About the meeting: ${terms.scene.trim()}`] : []),
    "",
    "Transcript:",
    ...(caution ? [caution] : []),
    numbered(utterances, lang),
  ].join("\n")
  return [
    { role: "system", content: CONTRACT },
    { role: "user", content: user },
  ]
}

/** A line the model rewrote: `n` counts from 1 in the order the lines were sent. */
export interface PolishedLine {
  n: number
  text: string
}

/** The lines the model returned, before any check; undefined when the reply cannot be read, an empty list when it changed nothing. */
export function parsePolish(text: string): PolishedLine[] | undefined {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")
  const start = stripped.indexOf("{")
  const end = stripped.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  let data: unknown
  try {
    data = JSON.parse(stripped.slice(start, end + 1))
  } catch {
    return undefined
  }
  const lines = (data as { lines?: unknown }).lines
  if (!Array.isArray(lines)) return undefined
  return lines.flatMap((raw) => {
    const line = raw as { n?: unknown; text?: unknown }
    const n = typeof line.n === "string" ? Number(line.n) : line.n
    return typeof n === "number" && Number.isInteger(n) && typeof line.text === "string" ? [{ n, text: line.text.replace(/\s*\n\s*/g, " ").trim() }] : []
  })
}

/** What the length checks count: each Chinese character, each Latin word, each run of digits. */
const TOKEN = /[\u3400-\u9fff\uf900-\ufaff]|[A-Za-z]+|[0-9０-９]+/gu
const tokens = (text: string) => (text.match(TOKEN) ?? []).map((w) => w.toLowerCase())
const LATIN = /^[a-z]+$/
/** Past this many tokens a line is left as it is: comparing it would hold up the interface for little gain. */
const MAX_TOKENS = 1500

/** Digits and Chinese numerals in order, a run said twice in a row counted once: a stutter ("一个一个") may go, a number may not change. */
const NUMERALS = /[0-9０-９零〇一二两三四五六七八九十百千万亿]+/g
function numerals(text: string): string {
  const runs = text.match(NUMERALS) ?? []
  return runs.filter((run, i) => run !== runs[i - 1]).join("|")
}

/** Words that turn a statement around when they come or go: negations, and who is spoken of. */
const NEGATION = /[不没无非别未否]/
const PERSONS = [/[我咱俺]|\b(?:i|we|me|us|my|our)\b/i, /[你您]|\b(?:you|your)\b/i, /[他她它]|\b(?:he|she|they|him|her|them|his|their)\b/i]
const QUESTION = /[？?吗]/

/** Length of the longest common subsequence: how much of one line is still in the other, in order. */
function common(a: string[], b: string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0)
  for (const x of a) {
    const row = new Array<number>(b.length + 1).fill(0)
    for (let j = 0; j < b.length; j++) row[j + 1] = x === b[j] ? prev[j] + 1 : Math.max(prev[j + 1], row[j])
    prev = row
  }
  return prev[b.length]
}

/** Tokens a line may gain (a misheard word replaced); fewer for a line in Latin script, where a word is a whole token. */
const MAX_NEW = (before: string[]) => Math.max(before.filter((w) => LATIN.test(w)).length * 2 > before.length ? 1 : 2, Math.floor(before.length * 0.15))
/** Tokens a line may lose to filler and stutters. */
const MAX_CUT = (before: number) => Math.max(4, Math.floor(before * 0.4))
/** Latin words that may be dropped as filler; any other Latin word is a name or a term and stays. */
const FILLER = new Set(["um", "umm", "uh", "uhh", "erm", "er", "hmm", "mm", "ah", "oh", "like", "so", "well", "you", "know", "i", "mean", "actually", "basically", "right", "okay", "ok", "yeah", "kind", "sort", "of", "just"])

/**
 * Whether `after` may replace `before`: the checks a tidied line has to pass, whatever the model was told. The numbers stay; no
 * negation, question or person comes or goes; no Latin word appears that the line or a known term did not have, and none goes but
 * filler; and most of the line stays, in order. A known term the line now names must replace a misheard word, so a name can be
 * corrected but cannot be added to a line.
 */
export function acceptableLine(before: string, after: string, terms: CorrectionTerms): boolean {
  if (!after || after === before) return false
  const old = tokens(before)
  const next = tokens(after)
  if (old.length > MAX_TOKENS || next.length > MAX_TOKENS) return false
  // A line keeps something said: emptying it would drop it from the conversation.
  if (old.length > 0 && next.length === 0) return false
  // Known terms are compared apart: a name may hold a numeral (三星) or a negation (无锡) that its misheard form did not.
  const names = [...terms.words].sort((a, b) => b.length - a.length)
  const plain = (text: string) => names.reduce((rest, term) => rest.split(term).join(" "), text)
  const [was, now] = [plain(before), plain(after)]
  if (numerals(was) !== numerals(now)) return false
  if (NEGATION.test(was) !== NEGATION.test(now)) return false
  if (QUESTION.test(was) && !QUESTION.test(now)) return false
  if (PERSONS.some((person) => !person.test(was) && person.test(now))) return false
  const added = terms.words.filter((term) => after.includes(term) && !before.includes(term))
  const knownLatin = new Set(added.flatMap(tokens).filter((w) => LATIN.test(w)))
  const words = new Set(old.filter((w) => LATIN.test(w)))
  if (next.some((w) => LATIN.test(w) && !words.has(w) && !knownLatin.has(w))) return false
  const left = new Set(next)
  if (old.some((w) => LATIN.test(w) && !left.has(w) && !FILLER.has(w))) return false
  const kept = common(old, next)
  const cut = old.length - kept
  if (cut > MAX_CUT(old.length)) return false
  // Each known term needs something misheard taken out for it (山星 → 三星 takes out one character).
  if (cut < added.length) return false
  const termTokens = added.reduce((sum, term) => sum + tokens(term).length, 0)
  return next.length - kept <= MAX_NEW(old) + termTokens
}

/**
 * The tidied text of each line that may change, by utterance: the line exists, was returned once, keeps its text when the model left
 * the label in front, and passes acceptableLine. Everything else keeps its text, whatever the model said.
 */
export function acceptPolish(lines: PolishedLine[], utterances: Utterance[], terms: CorrectionTerms, lang: Lang): Map<Utterance, string> {
  const accepted = new Map<Utterance, string>()
  const returned = new Map<number, number>()
  for (const { n } of lines) returned.set(n, (returned.get(n) ?? 0) + 1)
  for (const { n, text } of lines) {
    const u = utterances[n - 1]
    if (!u || returned.get(n) !== 1) continue
    const label = labelledText({ ...u, text: "" }, lang)
    const after = u.speaker && label && text.startsWith(label) ? text.slice(label.length).trim() : text
    if (acceptableLine(u.text, after, terms)) accepted.set(u, after)
  }
  return accepted
}
