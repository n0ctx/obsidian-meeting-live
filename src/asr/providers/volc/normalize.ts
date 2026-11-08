// Turns Volcengine streaming ASR results into the neutral contract, including the quirks of the service.
import { speakerId } from "../../../meeting/speakers.ts"
import type { AsrConnectionHandlers, AsrUpdate, AsrUtterance } from "../../contract.ts"

interface RawUtterance {
  text?: unknown
  start_time?: unknown
  end_time?: unknown
  definite?: unknown
  words?: { start_time?: unknown }[]
  /** The streaming speaker-separation page says utterances carry `speaker_id`; the file API puts `speaker` in `additions`, so every spelling is read. */
  speaker_id?: unknown
  speaker?: unknown
  additions?: { speaker_id?: unknown; speaker?: unknown }
}

/** The speaker of an utterance as an id a transcript line can hold: a number or a short alphanumeric label as sent, else the digits it ends with. */
function speakerOf(item: RawUtterance): string | undefined {
  for (const raw of [item.speaker_id, item.additions?.speaker_id, item.additions?.speaker, item.speaker]) {
    const text = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : typeof raw === "string" ? raw.trim() : ""
    const id = speakerId(text) ?? /(\d+)$/.exec(text)?.[1]
    if (id) return id
  }
  return undefined
}

/** The first utterance of a connection arrives without start_time; fall back to its first word, then the previous utterance. */
function startOf(item: RawUtterance, previousEnd: number): number {
  const direct = Number(item.start_time)
  if (item.start_time !== undefined && Number.isFinite(direct)) return direct
  const word = Number(Array.isArray(item.words) ? item.words[0]?.start_time : undefined)
  return Number.isFinite(word) ? word : previousEnd
}

export function utterancesOf(data: unknown): RawUtterance[] {
  if (!data || typeof data !== "object") return []
  const result = (data as { result?: unknown }).result
  const list = Array.isArray(result) ? result.flatMap((r) => (r as { utterances?: unknown }).utterances ?? []) : (result as { utterances?: unknown } | undefined)?.utterances
  return Array.isArray(list) ? list.filter((u): u is RawUtterance => !!u && typeof u === "object") : []
}

/** Remembers the unconfirmed utterances of one connection, so it must not outlive that connection. */
export class VolcNormalizer {
  private interims: AsrUtterance[] = []

  update(data: unknown, last: boolean): AsrUpdate {
    const raw = utterancesOf(data)
    const parsed: AsrUtterance[] = []
    let previousEnd = 0
    for (const item of raw) {
      const text = typeof item.text === "string" ? item.text.trim() : ""
      const start = startOf(item, previousEnd)
      const end = Number(item.end_time)
      if (Number.isFinite(end)) previousEnd = end
      if (!text) continue
      const speaker = speakerOf(item)
      parsed.push({ text, startMs: start, endMs: Number.isFinite(end) && end >= start ? end : start, final: item.definite === true, ...(speaker ? { speaker } : {}) })
    }
    // The service sometimes moves on from an utterance without ever confirming it; the text is kept as it stood.
    const latestStart = Math.max(...parsed.map((u) => u.startMs))
    const movedPast = this.interims.filter((u) => u.startMs < latestStart && u.endMs - 1000 <= latestStart).map((u) => ({ ...u, final: true }))
    // A result with no utterances (the handshake reply, an ack) says nothing about what is in progress.
    const keepInterims = raw.length === 0 && !last
    if (!keepInterims) this.interims = parsed.filter((u) => !u.final)
    return { utterances: [...movedPast, ...parsed], keepInterims }
  }
}

/** Feeds raw result payloads of one Volcengine connection to neutral handlers. */
export function volcResultSink(handlers: Pick<AsrConnectionHandlers, "onResult">): (data: unknown, last: boolean) => void {
  const normalizer = new VolcNormalizer()
  return (data, last) => handlers.onResult(normalizer.update(data, last), last)
}
