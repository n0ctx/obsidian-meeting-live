// Every speech-recognition provider the plugin knows. Adding one is a new folder under providers/ and a line here.
import { accountById, type Account } from "../../accounts/account.ts"
import { accountLabel } from "../../accounts/roles.ts"
import { serviceDef } from "../../accounts/services.ts"
import { t, type Lang } from "../../i18n/index.ts"
import { CAUTIOUS_LIVE_PACING, type AsrConnect, type LivePacing } from "../contract.ts"
import type { FileAsrProvider } from "../fileAsr.ts"
import { assemblyAiProvider } from "./assemblyai/index.ts"
import { dashScopeProvider } from "./dashscope/index.ts"
import { deepgramProvider } from "./deepgram/index.ts"
import { openAiCompatProvider } from "./openaiCompat/index.ts"
import { sherpaProvider } from "./sherpa/index.ts"
import { whisperLocalProvider } from "./whisperLocal/index.ts"
import { volcProvider } from "./volc/index.ts"
import type { AsrProvider, ProviderEnv } from "./types.ts"

export const ASR_PROVIDERS: readonly AsrProvider[] = [volcProvider, dashScopeProvider, assemblyAiProvider, deepgramProvider, openAiCompatProvider, sherpaProvider, whisperLocalProvider]

export function asrProvider(id: string): AsrProvider | undefined {
  return ASR_PROVIDERS.find((p) => p.id === id)
}

/** The speech adapter behind an account's service. */
export function providerOf(account: Account): AsrProvider | undefined {
  const adapter = serviceDef(account.service)?.asr
  return adapter ? asrProvider(adapter) : undefined
}

/** What resolving a role needs: the settings name the account, so the caller does not pass one. */
export type ResolveEnv = Omit<ProviderEnv, "account">

const unknownProblem = (id: string) => t("asr.unknownProvider", id)
const unsupportedProblem = (name: string, what: string) => t("asr.unsupported", name, what)

export interface ResolvedLive {
  id: string
  name: string
  connect: AsrConnect | null
  /** How fast this recognizer takes audio; the streamer sends no faster. */
  pacing: LivePacing
  problem?: string
}

/** The live recognizer under the current settings. Resolve it afresh whenever a recording run starts. */
export function resolveLive(env: ResolveEnv): ResolvedLive {
  const { accounts, roles } = env.settings
  const account = accountById(accounts, roles.live)
  if (!account) return { id: "", name: "", connect: null, pacing: CAUTIOUS_LIVE_PACING, problem: t("asr.noAccount") }
  const provider = providerOf(account)
  if (!provider) return { id: account.service, name: account.service, connect: null, pacing: CAUTIOUS_LIVE_PACING, problem: unknownProblem(account.service) }
  const name = accountLabel(accounts, account)
  if (!provider.live) return { id: provider.id, name, connect: null, pacing: CAUTIOUS_LIVE_PACING, problem: unsupportedProblem(name, t("asr.role.live")) }
  return { id: provider.id, name, pacing: provider.live.pacing(account), ...provider.live.resolve({ ...env, account }) }
}

/** The recorded-file recognizer under the current settings. */
export function resolveFile(env: ResolveEnv): FileAsrProvider {
  const { accounts, roles } = env.settings
  const account = accountById(accounts, roles.file)
  const provider = account ? providerOf(account) : undefined
  if (account && provider?.file) return provider.file.resolve({ ...env, account })
  const problem = !account ? t("asr.noAccount") : provider ? unsupportedProblem(accountLabel(accounts, account), t("asr.role.file")) : unknownProblem(account.service)
  return {
    id: provider?.id ?? account?.service ?? "",
    name: provider?.name ?? account?.service ?? "",
    host: "",
    model: "",
    capabilities: { language: false, diarization: false, fileSizeLimit: 0 },
    directFormats: {},
    problem,
    transcribe: () => Promise.reject(new Error(problem)),
  }
}

/** A provider's display name in `lang`, or its id when no such provider is known. */
export function providerNameIn(id: string, lang: Lang): string {
  const provider = asrProvider(id)
  return provider ? (provider.nameIn?.(lang) ?? provider.name) : id
}

/** Providers that can do the job, for the settings page's choices. */
export const liveProviders = (): AsrProvider[] => ASR_PROVIDERS.filter((p) => p.live)
export const fileProviders = (): AsrProvider[] => ASR_PROVIDERS.filter((p) => p.file)
