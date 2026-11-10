// The names a meeting's note already marks as names, for the recognizer to favour, and the `错→对` pairs written in it.
// Only what every vault already uses to say "this is a name" counts: the title, property values, links, 《》 and acronyms. Free text
// is not split into words and no template's property names are assumed: a wrong hotword pulls ordinary speech towards it, so missing
// an unlinked company is better than sending 股东 or 估值. What the plugin writes into the note (its block, the summary region) and
// the transcript files are never read, so a name the recognizer got wrong cannot come back as a hotword.
import { stripMeetingBlocks } from "../llm/minutes.ts"
import { summaryRegions } from "../meeting/noteSummary.ts"
import { dedupe } from "./context.ts"
import { parseCorrection, type Correction } from "./corrections.ts"

export interface NoteVocabulary {
  /** In order: title, property values, links in the text, 《》 titles, acronyms; at most MAX_NOTE_WORDS. */
  hotwords: string[]
  /** Property values that say what kind of meeting it is (访谈, meeting), which describe the scene instead of naming anything. */
  scene: string[]
  /** `错→对` lines of the note's own text. */
  corrections: Correction[]
}

export interface VocabularyOptions {
  /** Folders of the plugin's own files (meetings, transcripts): links into them are not names. */
  ignoreLinksUnder?: string[]
}

export const MAX_NOTE_WORDS = 40

/** Words that name the kind of meeting. They go to the scene, never to the hotwords. */
const OCCASIONS = new Set(["会议", "访谈", "投后访谈", "投前访谈", "会谈", "座谈", "调研", "尽调", "路演", "例会", "周会", "meeting", "interview", "call"])
/** Properties Obsidian and publishing tools use for dates, classification and layout, which never name anyone. */
const SKIP_KEYS = new Set(["date", "tags", "tag", "cssclasses", "cssclass", "created", "updated", "modified", "publish", "permalink"])
const LEADING_DATE = /^(?:\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日|\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{8})[\s_\-—–·.]*/
/** Sentence punctuation, the arrow of a pair or a bracket: a value with one is a sentence, a correction or markup, not a name. */
const SENTENCE_MARK = /[。，,？?；;！!→[\]]/
const LINK = /(!?)\[\[([^[\]\n]+?)\]\]/g
/** Extensions of attachments Obsidian links to, which are files, not notes named after someone. */
const ATTACHMENT = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|heic|pdf|mp3|m4a|wav|ogg|opus|flac|webm|mp4|mov|mkv|canvas|base|excalidraw|docx?|xlsx?|pptx?|csv|zip|txt)$/i
const BOOK_TITLE = /《([^《》\n]{2,12})》/g
const ACRONYM = /(?<![A-Za-z0-9_])[A-Z]{3,8}(?![A-Za-z0-9_])/g
const RAW_TRANSCRIPT = /原始转写|raw transcript/i

const isOccasion = (text: string) => OCCASIONS.has(text.toLowerCase())
const length = (text: string) => [...text].length
const isTerm = (text: string) => length(text) >= 2 && length(text) <= 12 && !SENTENCE_MARK.test(text)

function frontmatter(note: string): { yaml: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(note)
  return match ? { yaml: match[1], body: note.slice(match[0].length) } : { yaml: "", body: note }
}

const unquote = (text: string) => text.trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim()

/** The values of each property, from `key: value`, `key: [a, b]` and `key:` followed by `- value` lines. Block scalars are skipped. */
function properties(yaml: string): { key: string; values: string[] }[] {
  const result: { key: string; values: string[] }[] = []
  let current: { key: string; values: string[] } | undefined
  let block = false
  for (const line of yaml.split(/\r?\n/)) {
    const entry = /^([^\s#][^:]*):(?:\s+(.*))?$/.exec(line)
    if (entry) {
      current = { key: entry[1].trim(), values: [] }
      result.push(current)
      const value = (entry[2] ?? "").trim()
      block = /^[|>][+-]?$/.test(value)
      if (!value || block) continue
      if (/^\[(?!\[)/.test(value) && value.endsWith("]")) current.values.push(...value.slice(1, -1).split(","))
      else current.values.push(value)
      continue
    }
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item && current && !block) current.values.push(item[1])
  }
  return result.map((p) => ({ key: p.key, values: p.values.map(unquote).filter(Boolean) }))
}

/** What a link shows: its alias, else the note name without folder or heading. Undefined for embeds, files and the plugin's own notes. */
function linkName(inner: string, embed: boolean, options: VocabularyOptions): string | undefined {
  if (embed) return undefined
  const [target, alias] = inner.split("|", 2).map((s) => s.trim())
  const path = target.split("#")[0].trim()
  if (ATTACHMENT.test(path) || RAW_TRANSCRIPT.test(path)) return undefined
  const folders = (options.ignoreLinksUnder ?? []).map((f) => f.replace(/^\/+|\/+$/g, "")).filter(Boolean)
  if (folders.some((folder) => path === folder || path.startsWith(`${folder}/`))) return undefined
  const name = alias || path.split("/").pop()!.replace(/\.md$/, "")
  return isTerm(name) && !isOccasion(name) ? name : undefined
}

function linkNames(text: string, options: VocabularyOptions): string[] {
  return [...text.matchAll(LINK)].map((m) => linkName(m[2], m[1] === "!", options)).filter((n): n is string => !!n)
}

const isScalar = (v: string) => /^[-+]?[\d.,\s%]+$/.test(v) || /^\d{4}[-/.]\d{1,2}/.test(v) || /:\/\/|^www\./i.test(v) || /^(true|false|yes|no|null)$/i.test(v)

/** The note's own text: without the meeting and job blocks and without the summary regions the plugin writes. */
export function userText(body: string): string {
  const lines = body.split("\n")
  const dropped = new Set<number>()
  for (const span of summaryRegions(lines)) for (let n = span.start; n <= span.end; n++) dropped.add(n)
  return stripMeetingBlocks(lines.filter((_, n) => !dropped.has(n)).join("\n"))
}

/** The text without code blocks, inline code and comments, which hold neither names nor pairs the user means. */
function withoutCode(text: string): string {
  return text
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "")
    .replace(/%%[\s\S]*?%%|<!--[\s\S]*?-->/g, "")
    .replace(/`[^`\n]*`/g, "")
}

/** Text a reader sees as prose: without links, addresses, highlights and tags, where 《》 and acronyms are looked for. */
function prose(text: string): string {
  return text
    .replace(LINK, "")
    .replace(/\]\([^)\n]*\)/g, "]")
    .replace(/https?:\/\/\S+|www\.\S+/g, "")
    .replace(/==[^=\n]+==/g, "")
    .replace(/(^|\s)#[^\s#]+/g, "$1")
}

export function extractVocabulary(note: string, title: string, options: VocabularyOptions = {}): NoteVocabulary {
  // A note written on Windows ends its lines with CRLF, which the summary markers' patterns would not match.
  const { yaml, body } = frontmatter(note.replace(/\r\n?/g, "\n"))
  const words: string[] = []
  const scene: string[] = []

  const name = title.replace(LEADING_DATE, "").trim()
  if (isTerm(name) && !isOccasion(name)) words.push(name)

  for (const { key, values } of properties(yaml)) {
    if (SKIP_KEYS.has(key.toLowerCase())) continue
    for (const value of values) {
      const linked = linkNames(value, options)
      if (linked.length || value.includes("[[")) words.push(...linked)
      else if (isScalar(value)) continue
      else if (isOccasion(value)) scene.push(value)
      else if (isTerm(value)) words.push(value)
    }
  }

  const text = withoutCode(userText(body))
  words.push(...linkNames(text, options))
  const plain = prose(text)
  words.push(...[...plain.matchAll(BOOK_TITLE)].map((m) => m[1].trim()).filter(isTerm))
  words.push(...[...plain.matchAll(ACRONYM)].map((m) => m[0]))

  const seen = new Set<string>()
  const corrections = text
    .split("\n")
    .map(parseCorrection)
    .filter((pair): pair is Correction => !!pair && !seen.has(pair.from) && !!seen.add(pair.from))
  return { hotwords: dedupe(words).slice(0, MAX_NOTE_WORDS), scene: dedupe(scene), corrections }
}
