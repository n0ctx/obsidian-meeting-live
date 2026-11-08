// An account is one login at one service: a key (kept in SecretStorage, never here) and that service's own settings.
// Roles (live transcription, recorded files, language model) each point at an account that can serve them.
import type { CompatibleEffort } from "../llm/client.ts"

/** The three jobs an account can be picked for. */
export type Role = "live" | "file" | "llm"

export const ROLES: readonly Role[] = ["live", "file", "llm"]

/** How requests to the language model are tuned; only read for accounts whose service has a language model. */
export interface LlmOptions {
  temperature: number
  effort: CompatibleEffort
  /** Most a request may carry, in estimated tokens; 0 uses the preset's default. */
  inputLimit: number
  /** Extra request headers as "Name: value" lines, for presets that allow them. Not for secrets: data.json is not secret storage. */
  headers: string
}

export const DEFAULT_LLM_OPTIONS: LlmOptions = { temperature: 0.2, effort: "low", inputLimit: 0, headers: "" }

export interface Account {
  /** Stable within the settings; roles refer to it. */
  id: string
  /** Id of the service in the catalog (src/accounts/services.ts). */
  service: string
  /** What the user calls it; empty shows the service's name. */
  name: string
  /** SecretStorage id of the key; empty for services that need none. */
  apiKeySecret: string
  /** The service's own settings (endpoints, model names, region ...), filled with the service's defaults. */
  options: Record<string, unknown>
  llm: LlmOptions
}

/** Which account serves each role. An empty id means none is chosen. */
export interface Roles {
  live: string
  file: string
  llm: { account: string; model: string }
}

export const EMPTY_ROLES: Roles = { live: "", file: "", llm: { account: "", model: "" } }

/** The shape a provider's settings reader takes: the account's options with its key. */
export const sectionOf = (account: Account): Record<string, unknown> => ({ ...account.options, apiKeySecret: account.apiKeySecret })

export const accountById = (accounts: readonly Account[], id: string): Account | undefined => (id ? accounts.find((a) => a.id === id) : undefined)

export const roleAccountId = (roles: Roles, role: Role): string => (role === "llm" ? roles.llm.account : roles[role])

/** The part of the settings that holds accounts and the roles they are picked for. */
export interface AccountSettings {
  accounts: Account[]
  roles: Roles
}
