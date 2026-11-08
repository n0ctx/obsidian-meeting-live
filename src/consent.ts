// Consent is given per destination: where audio or text actually goes, by role and host.
// Changing a provider or an endpoint to a host the user has not agreed to asks again.
import { asrProvider } from "./asr/providers/registry.ts"
import { chatCompletionsUrl } from "./llm/client.ts"
import type { MeetingLiveSettings } from "./settings.ts"
import { hostOf } from "./url.ts"

export interface Destination {
  /** What is sent: live audio, recorded files, or meeting text. */
  kind: "live" | "file" | "llm"
  /** Display name of the provider; for the LLM, its host. */
  name: string
  host: string
  /** For the LLM, the model that reads the text. */
  detail?: string
}

/** Where the plugin would send data under these settings. Destinations that cannot be resolved to a host are left out. */
export function destinations(settings: MeetingLiveSettings): Destination[] {
  const live = asrProvider(settings.liveProvider)
  const file = asrProvider(settings.fileProvider)
  const llmHost = hostOf(chatCompletionsUrl(settings.llmBaseUrl))
  const list: Destination[] = [
    { kind: "live", name: live?.name ?? settings.liveProvider, host: live?.live?.host(settings) ?? "" },
    { kind: "file", name: file?.name ?? settings.fileProvider, host: file?.file?.host(settings) ?? "" },
    { kind: "llm", name: llmHost, host: llmHost, detail: settings.llmModel.trim() || undefined },
  ]
  return list.filter((d) => d.host)
}

export function destinationKey(d: Pick<Destination, "kind" | "host">): string {
  return `${d.kind}:${d.host.toLowerCase()}`
}

/** What a user who accepted the single consent of 1.0.x agreed to: the destinations configured then. */
export function seedConsent(settings: MeetingLiveSettings): string[] {
  return destinations(settings).map(destinationKey)
}

/** Destinations of the given kinds (all by default); a flow that sends data to only some of them asks about only those. */
function relevant(settings: MeetingLiveSettings, kinds?: Destination["kind"][]): Destination[] {
  return destinations(settings).filter((d) => !kinds || kinds.includes(d.kind))
}

export function needsConsent(settings: MeetingLiveSettings, kinds?: Destination["kind"][]): boolean {
  return relevant(settings, kinds).some((d) => !settings.consent.includes(destinationKey(d)))
}

/**
 * True when every destination of the given kinds (all by default) has been agreed to, asking first if one has not.
 * The question lists all of those destinations; accepting records them all.
 */
/** Runs `action` once the user has agreed to where the model service is, asking first if its host is new. False when they declined. */
export async function withLlmConsent(ensure: (kinds: Destination["kind"][]) => Promise<boolean>, action: () => unknown): Promise<boolean> {
  if (!(await ensure(["llm"]))) return false
  await action()
  return true
}

export async function ensureConsentFor(settings: MeetingLiveSettings, ask: (destinations: Destination[]) => Promise<boolean>, save: () => Promise<void>, kinds?: Destination["kind"][]): Promise<boolean> {
  if (!needsConsent(settings, kinds)) return true
  const current = relevant(settings, kinds)
  if (!(await ask(current))) return false
  settings.consent = [...new Set([...settings.consent, ...current.map(destinationKey)])]
  await save()
  return true
}
