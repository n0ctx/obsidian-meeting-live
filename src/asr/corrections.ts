// Exact replacements of misheard words, written as `错→对` or `错 -> 对`: in settings for every meeting, or in a meeting's note for that
// meeting. They change only the text of recognized sentences, never the time links or block ids of transcript lines.

export interface Correction {
  from: string
  to: string
}

const ARROW = /^(.+?)\s*(?:→|->)\s*(.+)$/
/** List markers and quote marks in front of a line, which are not part of the pair. */
const LINE_PREFIX = /^(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+)?/
/** Full stops, commas and the characters of links, tags and block ids: a side holding one is a sentence or markup, not a word. */
const NOT_A_WORD = /[。，,、；;：:！!？?[\]|#^`=→]|->/

function isWord(text: string): boolean {
  const length = [...text].length
  return length >= 1 && length <= 12 && !NOT_A_WORD.test(text)
}

/** The pair a line holds when the whole line, apart from a list marker, is `错→对`. */
export function parseCorrection(line: string): Correction | undefined {
  const match = ARROW.exec(line.trim().replace(LINE_PREFIX, "").trim())
  if (!match) return undefined
  const from = match[1].trim()
  const to = match[2].trim()
  return isWord(from) && isWord(to) && from !== to ? { from, to } : undefined
}

/** Every pair in a text, one per line; the first pair for a word wins. */
export function parseCorrections(text: string): Correction[] {
  const seen = new Set<string>()
  const result: Correction[] = []
  for (const line of text.split("\n")) {
    const pair = parseCorrection(line)
    if (!pair || seen.has(pair.from)) continue
    seen.add(pair.from)
    result.push(pair)
  }
  return result
}

const longestFirst = (pairs: Correction[]) => [...pairs].sort((a, b) => [...b.from].length - [...a.from].length)

/** The settings' table first, then the meeting's own pairs; within each, longer words before the shorter ones they may contain. */
export function correctionTables(settingsText: string, notePairs: Correction[]): Correction[][] {
  return [longestFirst(parseCorrections(settingsText)), longestFirst(notePairs)]
}

/**
 * Replaces `from` wherever it stands outside an occurrence of `to`, so `蓝箭→蓝箭科技` does not grow 蓝箭科技 into 蓝箭科技科技, and running
 * the same table over text it already corrected changes nothing.
 */
export function replaceWord(text: string, from: string, to: string): string {
  if (!text.includes(from)) return text
  if (!to.includes(from)) return text.split(from).join(to)
  return text
    .split(to)
    .map((part) => part.split(from).join(to))
    .join(to)
}

export function applyCorrections(text: string, tables: Correction[][]): string {
  let result = text
  for (const table of tables) for (const pair of table) result = replaceWord(result, pair.from, pair.to)
  return result
}
