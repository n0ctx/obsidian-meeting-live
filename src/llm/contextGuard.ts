// Keeps a minutes request within the model's input limit. A transcript that is too long is condensed part by part
// with the existing stage-summary prompt (map); the notes are then written from those parts (reduce). The timestamps
// the summaries cite stay on the lines, so the notes can still point back into the transcript.
import type { Utterance } from "../meeting/types.ts"
import type { ChatMessage, LlmClient } from "./client.ts"
import { buildMinutesMessages, type MinutesInput } from "./minutes.ts"
import { buildSummaryMessages, parseSummary, summaryUtterances } from "./summary.ts"

const CJK = /[⺀-鿿가-힯豈-﫿︰-﹏＀-￯]/g

/**
 * Rough token count without a tokenizer, leaning high: a CJK character counts as a token, other text as 3.3 characters.
 * Overestimating only makes the guard act early, which is the safe side.
 */
export function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0
  return Math.ceil(cjk + (text.length - cjk) * 0.3)
}

export const messagesTokens = (messages: ChatMessage[]): number => messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0)

/** Condensing more than this many times in a row means the limit is too small for the material. */
const MAX_ROUNDS = 3
/** Share of the room left after the fixed parts that one part may fill, leaving space for the reply's own text. */
const PART_SHARE = 0.8
/** Wording the stage-summary request adds around the transcript. */
const WRAPPER_TOKENS = 150
const MIN_PART_TOKENS = 200

export interface GuardOptions {
  /** The user's summary focus, which the condensing step uses as the stage summaries do. */
  focus: string
  onProgress?: (text: string) => void
}

const tooSmall = (limit: number) => new Error(`输入上限（约 ${limit.toLocaleString()} tokens）太小，装不下提示词和手动笔记，无法分段整理。请在设置中调高输入上限，或减少手动笔记`)

/** Sequential groups of utterances of at most `budget` estimated tokens; a group always holds at least one. */
function parts(utterances: Utterance[], budget: number): Utterance[][] {
  const groups: Utterance[][] = []
  let used = Infinity
  for (const u of utterances) {
    const size = estimateTokens(u.text) + 12
    if (used + size > budget) {
      groups.push([])
      used = 0
    }
    groups[groups.length - 1].push(u)
    used += size
  }
  return groups
}

/** One part of the transcript as a few timestamped lines. A reply that cannot be parsed is kept whole at the part's start. */
async function condensePart(llm: LlmClient, input: MinutesInput, part: Utterance[], options: GuardOptions): Promise<Utterance[]> {
  const window = { startMs: part[0].startMs, endMs: part[part.length - 1].endMs }
  const text = await llm.complete(buildSummaryMessages(input.title, options.focus, window, part, [], undefined), { json: true })
  const content = parseSummary(text, part)
  return content ? summaryUtterances(content, window.startMs) : [{ startMs: window.startMs, endMs: window.startMs, text: text.trim() }]
}

/** Writes the minutes, condensing the transcript first when the request would exceed the model's input limit. */
export async function writeMinutes(llm: LlmClient, prompt: string, input: MinutesInput, options: GuardOptions): Promise<string> {
  const limit = llm.inputLimit
  const build = (utterances: Utterance[], summaries: MinutesInput["summaries"], condensed: boolean) => buildMinutesMessages(prompt, { ...input, utterances, summaries, condensed })
  let utterances = input.utterances
  let summaries = input.summaries
  let condensed = false
  if (messagesTokens(build(utterances, summaries, false)) <= limit) return llm.complete(build(utterances, summaries, false))

  // What every request carries whatever happens to the transcript: the prompt and the manual notes, plus room for the condensed text.
  const fixed = messagesTokens(build([], [], true))
  const system = messagesTokens(buildSummaryMessages(input.title, options.focus, { startMs: 0, endMs: 0 }, [], [], undefined))
  const budget = Math.floor((limit - system - WRAPPER_TOKENS) * PART_SHARE)
  if (fixed + MIN_PART_TOKENS > limit || budget < MIN_PART_TOKENS) throw tooSmall(limit)

  let rounds = 0
  while (messagesTokens(build(utterances, summaries, condensed)) > limit) {
    // The stage summaries are only for cross-checking and the condensed parts cover the same ground: they go first.
    if (summaries.length && condensed) {
      summaries = []
      continue
    }
    if (rounds++ >= MAX_ROUNDS) throw new Error(`转写太长：压缩 ${MAX_ROUNDS} 次后仍超过输入上限（约 ${limit.toLocaleString()} tokens）。请在设置中调高输入上限，或换用上下文更长的模型`)
    const groups = parts(utterances, budget)
    const next: Utterance[] = []
    for (const [i, part] of groups.entries()) {
      options.onProgress?.(`正在分段压缩转写（${i + 1}/${groups.length}）`)
      next.push(...(await condensePart(llm, input, part, options)))
    }
    utterances = next
    condensed = true
  }
  options.onProgress?.("正在根据压缩后的内容撰写纪要")
  return llm.complete(build(utterances, summaries, condensed))
}
