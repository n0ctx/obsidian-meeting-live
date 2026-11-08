// Recognizing a recording that had to be cut into pieces, whatever the provider: pieces go up one after another and
// their times are moved to where each piece sits in the recording.
import type { AudioChunk } from "../audio/transcode.ts"
import { assertCoverage, transcribeFile, type FileAsrCall, type FileAsrProvider, type FileAsrResult } from "./fileAsr.ts"

export interface ChunkedCall extends FileAsrCall {
  /** A piece is about to go up; index counts from 0. */
  onPart?: (index: number, total: number) => void
}

/** Results of the leading pieces recognized so far, in order, so a retry can pick up where a failure stopped it. */
export type ChunkResults = FileAsrResult[]

/**
 * Recognizes the pieces in order and joins the results. `done` holds results of the leading pieces already recognized
 * (a retry passes what the failed attempt left); each new result is appended to it, so it survives a failure part-way.
 * Every piece must pass the same checks as a whole recording: one that comes back empty or truncated stops the job
 * rather than leaving a silent hole in the transcript.
 */
export async function transcribeChunks(provider: FileAsrProvider, chunks: AudioChunk[], call: ChunkedCall, done: ChunkResults = []): Promise<FileAsrResult> {
  for (let i = done.length; i < chunks.length; i++) {
    call.onPart?.(i, chunks.length)
    try {
      done.push(await transcribeFile(provider, chunks[i], call))
    } catch (error) {
      if (chunks.length === 1) throw error
      throw new Error(`第 ${i + 1}/${chunks.length} 段：${(error as Error).message}`)
    }
  }
  const merged = mergeChunks(done.slice(0, chunks.length), chunks)
  assertCoverage(merged)
  return merged
}

export function mergeChunks(results: FileAsrResult[], chunks: Pick<AudioChunk, "offsetMs">[]): FileAsrResult {
  if (results.length === 1) return results[0]
  const utterances = results.flatMap((r, i) => r.utterances.map((u) => ({ ...u, startMs: u.startMs + chunks[i].offsetMs, endMs: u.endMs + chunks[i].offsetMs })))
  // The duration is known only if every piece reported its own; otherwise the coverage ratio would compare against a guess.
  const last = results.length - 1
  const known = results.every((r) => r.durationMs > 0)
  return {
    durationMs: known ? chunks[last].offsetMs + results[last].durationMs : 0,
    utterances,
    text: results.map((r) => r.text).filter(Boolean).join("\n"),
    chunks: results.length,
  }
}
