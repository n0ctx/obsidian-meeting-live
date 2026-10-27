import type { SummaryRecord, Utterance } from "./types.ts"

/** Time after a window boundary to let the recognizer confirm the last sentences. */
export const CUTOFF_GRACE_MS = 4000
/** Upper bound on waiting for a lagging recognizer before summarizing anyway. */
export const CUTOFF_MAX_WAIT_MS = 60_000

export function dueCutoff(timelineMs: number, lastCutoffMs: number, intervalMs: number, asrDeliveredMs: number, asrLive: boolean): number | undefined {
  const cutoff = lastCutoffMs + intervalMs
  if (timelineMs < cutoff + CUTOFF_GRACE_MS) return undefined
  if (asrLive && asrDeliveredMs < cutoff + 1000 && timelineMs < cutoff + CUTOFF_MAX_WAIT_MS) return undefined
  return cutoff
}

/** Final utterances before `beforeMs` that no summary has claimed yet, including late arrivals. */
export function uncovered(utterances: Utterance[], summaries: SummaryRecord[], beforeMs: number): Utterance[] {
  const claimed = new Set<number>()
  for (const s of summaries) for (const key of s.utterances) claimed.add(key)
  return utterances.filter((u) => u.startMs < beforeMs && !claimed.has(Math.round(u.startMs)))
}
