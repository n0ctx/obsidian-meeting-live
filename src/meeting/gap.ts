import { tr, uiLang, type Key, type Lang } from "../i18n/index.ts"
import type { GapCode, TranscriptGap } from "./types.ts"

const KEYS = { overflow: "gap.overflow", disconnected: "gap.disconnected", unconfigured: "gap.unconfigured" } as const satisfies Record<GapCode, Key>

/** A gap with its reason worded in the interface language, which is what the meeting data keeps for older readers. */
export function newGap(startMs: number, endMs: number, code: GapCode): TranscriptGap {
  return { startMs, endMs, reason: tr(uiLang(), KEYS[code]), code }
}

/** Why a stretch was not transcribed, in `lang`. Gaps stored before reasons had codes keep the words they were stored with. */
export function gapReason(gap: Pick<TranscriptGap, "reason" | "code">, lang: Lang = uiLang()): string {
  return gap.code ? tr(lang, KEYS[gap.code]) : gap.reason
}
