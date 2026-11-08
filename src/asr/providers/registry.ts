// Every speech-recognition provider the plugin knows. Adding one is a new folder under providers/ and a line here.
import type { AsrConnect } from "../contract.ts"
import type { FileAsrProvider } from "../fileAsr.ts"
import { openAiCompatProvider } from "./openaiCompat/index.ts"
import { volcProvider } from "./volc/index.ts"
import type { AsrProvider, ProviderEnv } from "./types.ts"

export const ASR_PROVIDERS: readonly AsrProvider[] = [volcProvider, openAiCompatProvider]

export function asrProvider(id: string): AsrProvider | undefined {
  return ASR_PROVIDERS.find((p) => p.id === id)
}

const unknownProblem = (id: string) => `未知的语音识别服务「${id}」，请在设置中重新选择`
const unsupportedProblem = (name: string, what: string) => `${name}不支持${what}，请在设置中重新选择`

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
  if (!provider.live) return { id, name: provider.name, connect: null, problem: unsupportedProblem(provider.name, "实时识别") }
  return { id, name: provider.name, ...provider.live.resolve(env) }
}

/** The recorded-file recognizer under the current settings. */
export function resolveFile(env: ProviderEnv): FileAsrProvider {
  const id = env.settings.fileProvider
  const provider = asrProvider(id)
  if (provider?.file) return provider.file.resolve(env)
  const problem = provider ? unsupportedProblem(provider.name, "录音文件识别") : unknownProblem(id)
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

/** Providers that can do the job, for the settings page's choices. */
export const liveProviders = (): AsrProvider[] => ASR_PROVIDERS.filter((p) => p.live)
export const fileProviders = (): AsrProvider[] => ASR_PROVIDERS.filter((p) => p.file)
