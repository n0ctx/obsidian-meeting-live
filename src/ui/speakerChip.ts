import type { Lang } from "../i18n/index.ts"
import { speakerColor, speakerName } from "../meeting/speakers.ts"

/** A small coloured label naming a speaker; the colour comes from the id alone, so it never changes during a meeting. */
export function speakerChip(parent: HTMLElement, speaker: string, lang: Lang): HTMLElement {
  return parent.createSpan({ cls: `ml-spk ml-spk-${speakerColor(speaker)}`, text: speakerName(lang, speaker), attr: { "data-speaker": speaker } })
}
