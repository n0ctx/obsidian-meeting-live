// Reads accounts and roles out of stored settings. Whatever is missing or of the wrong type gets the service's default,
// and an account of a service this version does not have is dropped.
import { DEFAULT_LLM_OPTIONS, EMPTY_ROLES, type Account, type LlmOptions, type Roles, ROLES } from "./account.ts"
import { accountRoles } from "./roles.ts"
import { regionOf, serviceDef, type ServiceDef } from "./services.ts"

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

const EFFORTS: readonly unknown[] = ["off", "low", "medium", "high"]

export function readLlmOptions(raw: unknown): LlmOptions {
  const stored = record(raw)
  const result = { ...DEFAULT_LLM_OPTIONS }
  if (typeof stored.temperature === "number" && Number.isFinite(stored.temperature)) result.temperature = stored.temperature
  if (EFFORTS.includes(stored.effort)) result.effort = stored.effort as LlmOptions["effort"]
  if (typeof stored.inputLimit === "number" && Number.isFinite(stored.inputLimit)) result.inputLimit = stored.inputLimit
  if (typeof stored.headers === "string") result.headers = stored.headers
  return result
}

/** A service's options as stored: the keys the service has, each of the right type, the rest at the service's defaults. */
export function readOptions(def: ServiceDef, raw: unknown): Record<string, unknown> {
  const stored = record(raw)
  const defaults = def.options(regionOf(def, stored))
  const result: Record<string, unknown> = { ...defaults }
  for (const key of Object.keys(defaults)) if (typeof stored[key] === typeof defaults[key]) result[key] = stored[key]
  if (def.regions) result.region = regionOf(def, stored)
  return result
}

export function readAccounts(raw: unknown): Account[] {
  const accounts: Account[] = []
  for (const entry of Array.isArray(raw) ? raw : []) {
    const stored = record(entry)
    const def = typeof stored.service === "string" ? serviceDef(stored.service) : undefined
    if (!def || typeof stored.id !== "string" || !stored.id || accounts.some((a) => a.id === stored.id)) continue
    accounts.push({
      id: stored.id,
      service: def.id,
      name: typeof stored.name === "string" ? stored.name : "",
      apiKeySecret: typeof stored.apiKeySecret === "string" ? stored.apiKeySecret : "",
      options: readOptions(def, stored.options),
      llm: readLlmOptions(stored.llm),
    })
  }
  return accounts
}

/** Roles as stored, keeping only those that point at an account that exists and can do the job. */
export function readRoles(raw: unknown, accounts: readonly Account[]): Roles {
  const stored = record(raw)
  const roles: Roles = structuredClone(EMPTY_ROLES)
  const serving = (id: unknown, role: (typeof ROLES)[number]) => (typeof id === "string" ? accounts.find((a) => a.id === id && accountRoles(a)[role]) : undefined)
  if (serving(stored.live, "live")) roles.live = stored.live as string
  if (serving(stored.file, "file")) roles.file = stored.file as string
  const llm = record(stored.llm)
  if (serving(llm.account, "llm")) roles.llm = { account: llm.account as string, model: typeof llm.model === "string" ? llm.model : "" }
  return roles
}
