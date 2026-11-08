// An account seen as a language model: the preset that shapes its requests and the settings that tune them.
import type { LlmConfig } from "../llm/client.ts"
import { parseHeaders } from "../llm/presets.ts"
import type { Account } from "./account.ts"
import { presetOfService, serviceDef } from "./services.ts"

/** The configuration for talking to an account's language model, with the key and model given; undefined when its service has none. */
export function accountLlmConfig(account: Account, apiKey: string, model: string): LlmConfig | undefined {
  const def = serviceDef(account.service)
  const preset = def && presetOfService(def, account.options)
  if (!preset) return undefined
  return {
    preset,
    baseUrl: String(account.options.baseUrl ?? ""),
    apiKey,
    model,
    temperature: account.llm.temperature,
    effort: account.llm.effort,
    headers: preset.customHeaders ? parseHeaders(account.llm.headers) : {},
    inputLimit: account.llm.inputLimit > 0 ? account.llm.inputLimit : preset.inputTokens,
  }
}
