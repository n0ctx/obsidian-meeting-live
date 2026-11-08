// Checking a pasted key. Where the service documents a call that costs nothing (a model list, an authentication test), the check runs by itself
// as soon as the key is pasted. Where it does not, nothing is called until the user presses Test, and the page says that Test may count as usage.
import { assemblyAiEndpoints } from "../asr/providers/assemblyai/settings.ts"
import { deepgramFileUrlOf } from "../asr/providers/deepgram/settings.ts"
import { detectVolcResource } from "../asr/providers/volc/detect.ts"
import { volcConfig } from "../asr/providers/volc/settings.ts"
import type { HandshakeResult, VolcConfig } from "../asr/providers/volc/live.ts"
import { providerOf } from "../asr/providers/registry.ts"
import { assemblyAiSettingsOf } from "../asr/providers/assemblyai/index.ts"
import { deepgramSettingsOf } from "../asr/providers/deepgram/index.ts"
import { volcSettingsOf } from "../asr/providers/volc/index.ts"
import { runLiveTest, type LiveTestOutcome } from "../asr/providers/liveTest.ts"
import { t } from "../i18n/index.ts"
import { chat, type HttpGet, type HttpPost } from "../llm/client.ts"
import { listModels } from "../llm/models.ts"
import type { SecretReader } from "../secrets.ts"
import type { MeetingLiveSettings } from "../settings.ts"
import type { Account } from "./account.ts"
import { accountLlmConfig } from "./llm.ts"
import { defaultModel } from "./manage.ts"
import { serviceDef } from "./services.ts"

export type CheckResult =
  /** The key works. `models` is what the service listed, `resourceId` the Volcengine resource that was found to work, `note` something to tell the user. */
  | { state: "ok"; models?: string[]; resourceId?: string; note?: string }
  /** It does not, with the reason in plain words. */
  | { state: "failed"; message: string }
  /** The service has no free check: ask the user to press Test. */
  | { state: "manual" }

export interface CheckDeps {
  get: HttpGet
  post: HttpPost
  /** What a recognizer on this computer says to a second of silence. */
  liveTest: (account: Account, key: string) => Promise<LiveTestOutcome>
  volcHandshake: (config: VolcConfig) => Promise<HandshakeResult>
  /** Where other secrets of an account (a Volcengine old-console access token) are read from. */
  secrets: SecretReader
  settings: MeetingLiveSettings
}

const originOf = (url: string): string => {
  try {
    return new URL(url.trim()).origin
  } catch {
    return ""
  }
}

const rejected = (status: number): CheckResult => ({ state: "failed", message: t("check.rejected", status) })
const unreachable = (message: string): CheckResult => ({ state: "failed", message: t("check.unreachable", message) })

/** A GET with the key that answers 2xx for a good key, 401/403 for a bad one, and anything else for a service that has no such call. */
async function authCall(get: HttpGet, url: string, headers: Record<string, string>): Promise<CheckResult> {
  try {
    const response = await get(url, headers)
    if (response.status >= 200 && response.status < 300) return { state: "ok" }
    if (response.status === 401 || response.status === 403) return rejected(response.status)
    if (response.status === 404 || response.status === 405) return { state: "manual" }
    return { state: "failed", message: t("check.status", response.status) }
  } catch (error) {
    return unreachable((error as Error).message)
  }
}

/** Where a local server answers, whatever it answers: the plugin's own check of a Whisper server, which has no key to test. */
async function reachable(get: HttpGet, url: string): Promise<CheckResult> {
  try {
    await get(url, {})
    return { state: "ok", note: t("check.reachable") }
  } catch (error) {
    return unreachable((error as Error).message)
  }
}

/** The check that costs nothing, or `manual` when the service documents none. */
export async function freeCheck(account: Account, key: string, deps: CheckDeps): Promise<CheckResult> {
  const def = serviceDef(account.service)
  if (!def) return { state: "manual" }
  const llm = accountLlmConfig(account, key, "")
  if (llm && def.presets) {
    const outcome = await listModels(llm.preset.id, llm, deps.get)
    if (outcome.state === "ok") return { state: "ok", models: outcome.models }
    if (outcome.state === "rejected") return rejected(outcome.status)
    if (outcome.state === "failed") return outcome.status ? { state: "failed", message: t("check.status", outcome.status) } : unreachable(outcome.message)
    // A local server with no list is still a server: say whether it answers.
    return def.keyless ? reachable(deps.get, String(account.options.baseUrl)) : { state: "manual" }
  }
  switch (def.id) {
    case "deepgram": {
      // "A quick test to see if your key is validating correctly": https://developers.deepgram.com/guides/fundamentals/authenticating
      const origin = originOf(deepgramFileUrlOf(deepgramSettingsOf(account)))
      return origin ? authCall(deps.get, `${origin}/v1/auth/token`, { Authorization: `Token ${key}` }) : { state: "failed", message: t("check.badAddress") }
    }
    case "assemblyai":
      // Listing one transcript is a read: https://www.assemblyai.com/docs/api-reference/transcripts/list
      return authCall(deps.get, `${assemblyAiEndpoints(assemblyAiSettingsOf(account)).api}/v2/transcript?limit=1`, { Authorization: key })
    case "sherpa": {
      const outcome = await deps.liveTest(account, key)
      return outcome.ok ? { state: "ok" } : { state: "failed", message: outcome.message ?? t("check.unreachable", "") }
    }
    case "whisper-local":
      return reachable(deps.get, String(account.options.baseUrl))
    default:
      return { state: "manual" }
  }
}

const TYPED_KEY = "typed-key"

/** The check the user asks for when there is no free one. It may count as usage, which the page says beside the button. */
export async function paidCheck(account: Account, key: string, deps: CheckDeps, model = defaultModel(account)): Promise<CheckResult> {
  const def = serviceDef(account.service)
  if (def?.id === "volc") {
    // The typed key stands for the account's own; any other secret (the old console's access token) is read from storage.
    const secrets: SecretReader = { getSecret: (id) => (id === TYPED_KEY ? key : deps.secrets.getSecret(id)) }
    const config = volcConfig(secrets, { ...volcSettingsOf(account), apiKeySecret: key ? TYPED_KEY : "" }, "")
    const found = await detectVolcResource(config, deps.volcHandshake)
    if (found.state === "ok") return { state: "ok", resourceId: found.resourceId, note: t("check.volcResource", found.resourceId) }
    if (found.state === "unreachable") return unreachable(found.message)
    return { state: "failed", message: t("check.volcRefused", found.status) }
  }
  const llm = accountLlmConfig(account, key, model)
  if (llm) {
    try {
      const reply = await chat(llm, [{ role: "user", content: "Reply with only the two letters: OK" }], deps.post)
      return { state: "ok", note: t("check.llmReply", reply.slice(0, 40)) }
    } catch (error) {
      return { state: "failed", message: (error as Error).message }
    }
  }
  const provider = providerOf(account)
  if (provider?.live) {
    const outcome = await deps.liveTest(account, key)
    return outcome.ok ? { state: "ok" } : { state: "failed", message: outcome.message ?? "" }
  }
  return { state: "manual" }
}

/** Runs a recognizer's connector against a second of silence; what the Test of a speech service does. */
export async function liveTestOf(account: Account, key: string, settings: MeetingLiveSettings): Promise<LiveTestOutcome> {
  const provider = providerOf(account)
  if (!provider?.live) return { ok: false, message: t("asr.unsupported", account.service, t("asr.role.live")) }
  const resolved = provider.live.resolve({ secrets: { getSecret: () => key }, settings, account })
  if (!resolved.connect) return { ok: false, message: resolved.problem }
  return runLiveTest(resolved.connect, provider.live.pacing(account))
}
