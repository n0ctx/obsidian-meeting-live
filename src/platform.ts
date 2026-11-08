// Text that depends on the operating system, chosen from the dictionary by platform and language.
import { Platform } from "obsidian"
import { tr, uiLang, type Key, type Lang } from "./i18n/index.ts"

export type Os = "mac" | "win" | "linux"

export function currentOs(): Os {
  return Platform.isMacOS ? "mac" : Platform.isWin ? "win" : "linux"
}

const KEYS = {
  systemAudio: { mac: "hint.systemAudio.mac", win: "hint.systemAudio.win", linux: "hint.systemAudio.linux" },
  micDenied: { mac: "hint.micDenied.mac", win: "hint.micDenied.win", linux: "hint.micDenied.linux" },
  reveal: { mac: "hint.reveal.mac", win: "hint.reveal.win", linux: "hint.reveal.linux" },
} as const satisfies Record<string, Record<Os, Key>>

export type PlatformTopic = keyof typeof KEYS

/** The wording of a topic for an operating system (this one by default) in a language (the interface's by default). */
export function platformText(topic: PlatformTopic, os: Os = currentOs(), lang: Lang = uiLang()): string {
  return tr(lang, KEYS[topic][os])
}
