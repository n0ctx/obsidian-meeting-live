import type { Key } from "../i18n/index.ts"

const ASR_LABEL: Record<string, Key> = {
  live: "card.asr.live",
  connecting: "card.asr.connecting",
  reconnecting: "card.asr.reconnecting",
  failed: "card.asr.failed",
  disabled: "card.asr.disabled",
  idle: "card.asr.idle",
}

/** The chip on a recording card. A pause-then-text recognizer must not look like word-by-word streaming. */
export function asrChipLabel(afterPause: boolean, state: string, detail: string | undefined): Key | undefined {
  if (afterPause && state === "live") return detail === "recognizing" ? "card.asr.recognizing" : "card.asr.afterPause"
  return ASR_LABEL[state]
}

export const asrChipTone = (state: string): string => (state === "live" ? "ok" : state === "connecting" ? "busy" : state === "reconnecting" ? "warn" : state === "failed" ? "error" : state === "disabled" ? "off" : "idle")
