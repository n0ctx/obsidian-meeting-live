// Every speech-recognition provider the plugin knows. Adding one is a new folder under providers/ and a line here.
import { t, type Lang } from "../../i18n/index.ts"
import type { AsrConnect } from "../contract.ts"
import type { FileAsrProvider } from "../fileAsr.ts"
import { assemblyAiProvider } from "./assemblyai/index.ts"
import { dashScopeProvider } from "./dashscope/index.ts"
import { deepgramProvider } from "./deepgram/index.ts"
import { openAiCompatProvider } from "./openaiCompat/index.ts"
import { volcProvider } from "./volc/index.ts"
import type { AsrProvider, ProviderEnv } from "./types.ts"

export const ASR_PROVIDERS: readonly AsrProvider[] = [volcProvider, dashScopeProvider, assemblyAiProvider, deepgramProvider, openAiCompatProvider]

export function asrProvider(id: string): AsrProvider | undefined {
  return ASR_PROVIDERS.find((p) => p.id === id)
}

const unknownProblem = (id: string) => t("asr.unknownProvider", id)
const unsupportedProblem = (name: string, what: string) => t("asr.unsupported", name, what)

export interface ResolvedLive {
  id: string
  name: string
  connect: AsrConnect | null
  problem?: string
}

/** The live recognizer under the current settings. Resolve it afresh whenever a recording run starts. */
export function resolveLive(env: ProviderEnv): ResolvedLive {
  const id = env.settings.liveProvider
  const provider = asrProvider(id)
  if (!provider) return { id, name: id, connect: null, problem: unknownProblem(id) }
  if (!provider.live) return { id, name: provider.name, connect: null, problem: unsupportedProblem(provider.name, t("asr.role.live")) }
  return { id, name: provider.name, ...provider.live.resolve(env) }
}

/** The recorded-file recognizer under the current settings. */
export function resolveFile(env: ProviderEnv): FileAsrProvider {
  const id = env.settings.fileProvider
  const provider = asrProvider(id)
  if (provider?.file) return provider.file.resolve(env)
  const problem = provider ? unsupportedProblem(provider.name, t("asr.role.file")) : unknownProblem(id)
  return {
    id,
    name: provider?.name ?? id,
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
