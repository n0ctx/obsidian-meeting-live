// Consent is given per destination: where audio or text actually goes, by role and host.
// Changing a provider or an endpoint to a host the user has not agreed to asks again.
import { providerOf } from "./asr/providers/registry.ts"
import { accountLabel, roleAccount } from "./accounts/roles.ts"
import { chatCompletionsUrl } from "./llm/client.ts"
import type { MeetingLiveSettings } from "./settings.ts"
import { hostOf, isLoopbackHost } from "./url.ts"

export interface Destination {
  /**
   * What is sent: live audio, recorded files, meeting text, or the speech context (the settings' meeting background and the names
   * taken from the note) that goes with the audio. The last is asked about on its own, after the others: see contextDestination.
   */
  kind: "live" | "file" | "llm" | "asr-context"
  /** Display name of the provider; for the LLM, its host. */
  name: string
  host: string
  /** For the LLM, the model that reads the text. */
  detail?: string
  /** For the speech context, which recognizer it goes with. */
  role?: "live" | "file"
  /** The host is this machine (loopback): the data is still listed and agreed to, but it does not leave the computer. */
  local?: true
}

/** Where the plugin would send data under these settings. Destinations that cannot be resolved to a host are left out. */
export function destinations(settings: MeetingLiveSettings): Destination[] {
  const live = roleAccount(settings, "live")
  const file = roleAccount(settings, "file")
  const llm = roleAccount(settings, "llm")
  const llmHost = llm ? hostOf(chatCompletionsUrl(String(llm.options.baseUrl ?? ""))) : ""
  const list: Destination[] = [
    { kind: "live", name: live ? accountLabel(settings.accounts, live) : "", host: (live && providerOf(live)?.live?.host(live)) || "" },
    { kind: "file", name: file ? accountLabel(settings.accounts, file) : "", host: (file && providerOf(file)?.file?.host(file)) || "" },
    { kind: "llm", name: llmHost, host: llmHost, detail: settings.roles.llm.model.trim() || undefined },
  ]
  return list.filter((d) => d.host).map((d) => (isLoopbackHost(d.host) ? { ...d, local: true as const } : d))
}

/** Whether live audio stays on this machine under these settings. */
export const liveIsLocal = (settings: MeetingLiveSettings): boolean => destinations(settings).some((d) => d.kind === "live" && d.local)

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

/**
 * Where the speech context of a role would go: the host of its recognizer, when that recognizer reads a context at all. Agreeing to
 * the audio going there ("live:host") does not cover it: the note's names and the background are text the user wrote, so they have
 * their own key, "asr-context:host", one per host whichever role sends there. Not among `destinations`, so asking about everything
 * at the start of a recording never asks about it, and the agreement of 1.0.x never seeds it.
 */
export function contextDestination(settings: MeetingLiveSettings, role: "live" | "file"): Destination | undefined {
  const account = roleAccount(settings, role)
  const provider = account && providerOf(account)
  const service = role === "live" ? provider?.live : provider?.file
  if (!account || !service?.capabilities(account).context) return undefined
  const host = service.host(account)
  return host ? { kind: "asr-context", name: accountLabel(settings.accounts, account), host, role } : undefined
}

/**
 * Whether the speech context of a role may go with its audio, asking the user if they have not said. Declining is not an error: the
 * recording or upload goes ahead with the typed hotwords alone, and the refusal is kept in `declined` (for as long as the plugin runs),
 * so a paused meeting resumes without asking again.
 */
export async function ensureContextConsent(
  settings: MeetingLiveSettings,
  role: "live" | "file",
  ask: (destination: Destination) => Promise<boolean>,
  save: () => Promise<void>,
  declined: Set<string>,
): Promise<boolean> {
  const destination = contextDestination(settings, role)
  if (!destination) return false
  const key = destinationKey(destination)
  if (settings.consent.includes(key)) return true
  if (declined.has(key)) return false
  if (!(await ask(destination))) {
    declined.add(key)
    return false
  }
  settings.consent = [...settings.consent, key]
  await save()
  return true
}
