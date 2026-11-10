// What a recognizer is told about a meeting before it hears it: terms to favour and a sentence on what the meeting is about.
// Only Volcengine reads the scene and the note's terms (see LiveCapabilities.context); the others take the typed hotwords alone.

export interface AsrContext {
  /** Most important first: the streaming pass keeps only the front of the list. */
  hotwords: string[]
  /** What the user wrote about the meeting's field and people. Never recognizer output, which would turn a misheard name into a fact. */
  scene?: string
  boostingTableId?: string
  correctTableId?: string
}

/** Which request the corpus goes into; the streaming request and the recorded-file request have different limits. */
export type CorpusBudget = "live" | "file"

/**
 * Client-side caps, there to keep an oversized request from being refused, not to cut to what the server keeps.
 * The server cuts by itself, keeping the front: the streaming first pass keeps about 100 tokens of hotwords, the second pass
 * (enable_nonstream, which writes what is saved) takes up to 5000 words and 800 tokens of context:
 *   https://www.volcengine.com/docs/6561/2604976  (热词与上下文最佳实践)
 *   https://www.volcengine.com/docs/6561/1354869  (大模型流式语音识别 API)
 * Cutting the list to 100 tokens here would starve the second pass, so the live cap is far above that.
 * The recorded-file submit page has the same request.corpus.context string and its own limits: "热词总长度不得超过5000词（含context直传热词
 * 与热词表热词）" and "上下文最大支持上传500 tokens", and corpus does not combine with enable_auto_lang, which the file request does not set:
 *   https://docs.volcengine.com/docs/6561/2606791  (录音文件识别 提交任务)
 */
const LIMITS: Record<CorpusBudget, { words: number; contextTokens: number }> = {
  live: { words: 500, contextTokens: 800 },
  file: { words: 5000, contextTokens: 500 },
}

/** Hotwords as typed in settings: one per line, or separated by commas. Blank and repeated entries are dropped, the order kept. */
export function splitHotwords(text: string): string[] {
  return dedupe(text.split(/\n|,|，/))
}

export function dedupe(words: Iterable<string>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of words) {
    const word = raw.trim()
    if (!word || seen.has(word)) continue
    seen.add(word)
    result.push(word)
  }
  return result
}

/** A deliberately high token estimate: 1 for an ASCII character, 2 for anything else. Overestimating only sends a little less. */
export function estimateTokens(text: string): number {
  let tokens = 0
  for (const ch of text) tokens += ch.charCodeAt(0) < 0x80 ? 1 : 2
  return tokens
}

function fitTokens(text: string, limit: number): string {
  let used = 0
  let end = 0
  for (const ch of text) {
    used += ch.charCodeAt(0) < 0x80 ? 1 : 2
    if (used > limit) break
    end += ch.length
  }
  return text.slice(0, end).trim()
}

/**
 * request.corpus for the context, or undefined when there is nothing to send, so the request keeps the shape it has without one.
 * `context` is a JSON string, not an object; hotwords come before context_data, and the scene is the first (only) context_data entry.
 * Table ids sit on corpus itself: their words are joined to the hotwords before the server cuts, so they do not get round the streaming limit.
 */
export function buildCorpus(ctx: AsrContext | undefined, budget: CorpusBudget): Record<string, unknown> | undefined {
  if (!ctx) return undefined
  const limit = LIMITS[budget]
  const words = dedupe(ctx.hotwords).slice(0, limit.words)
  const scene = fitTokens(ctx.scene?.trim() ?? "", limit.contextTokens)
  const inner: Record<string, unknown> = {}
  if (words.length) inner.hotwords = words.map((word) => ({ word }))
  if (scene) {
    inner.context_type = "dialog_ctx"
    inner.context_data = [{ text: scene }]
  }
  const corpus: Record<string, unknown> = {}
  if (ctx.boostingTableId?.trim()) corpus.boosting_table_id = ctx.boostingTableId.trim()
  if (ctx.correctTableId?.trim()) corpus.correct_table_id = ctx.correctTableId.trim()
  if (Object.keys(inner).length) corpus.context = JSON.stringify(inner)
  return Object.keys(corpus).length ? corpus : undefined
}
