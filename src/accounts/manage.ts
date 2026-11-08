// Adding and removing accounts, and keeping the roles pointing at accounts that exist.
import { presetOfService, serviceDef, type ServiceDef } from "./services.ts"
import { DEFAULT_LLM_OPTIONS, type Account, type AccountSettings, type Role, ROLES, accountById, roleAccountId } from "./account.ts"
import { accountRoles, accountsFor } from "./roles.ts"

/** A readable id no other account has: the service's id, then service-2, service-3 ... */
export function newAccountId(accounts: readonly Account[], service: string): string {
  for (let n = 1; ; n++) {
    const id = n === 1 ? service : `${service}-${n}`
    if (!accounts.some((a) => a.id === id)) return id
  }
}

/** The SecretStorage id a key typed into the plugin is kept under. Lowercase letters, digits and dashes only, as SecretStorage requires. */
export const secretIdFor = (accountId: string): string => `meeting-live-${accountId.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`

/** Whether the plugin made this secret id, and so may replace or clear it; ids the user chose (the ones 1.0.1 read) are left alone. */
export const isOwnSecret = (id: string): boolean => id.startsWith("meeting-live-")

export function createAccount(accounts: readonly Account[], def: ServiceDef, region: string, patch: { name?: string; options?: Record<string, unknown> } = {}): Account {
  const id = newAccountId(accounts, def.id)
  return {
    id,
    service: def.id,
    name: patch.name?.trim() ?? "",
    apiKeySecret: "",
    options: { ...def.options(region), ...patch.options },
    llm: { ...DEFAULT_LLM_OPTIONS },
  }
}

/** The model a language-model account starts with: its preset's suggestion. */
export function defaultModel(account: Account): string {
  const def = serviceDef(account.service)
  return (def && presetOfService(def, account.options)?.model) ?? ""
}

function assign(settings: AccountSettings, role: Role, account: Account | undefined): void {
  if (role === "llm") {
    settings.roles.llm = { account: account?.id ?? "", model: account ? defaultModel(account) : "" }
  } else settings.roles[role] = account?.id ?? ""
}

/** Adds an account and puts it in every role that has no account yet and that it can do: one key, set up, nothing more to choose. */
export function addAccount(settings: AccountSettings, account: Account): void {
  settings.accounts.push(account)
  const can = accountRoles(account)
  for (const role of ROLES) if (can[role] && !roleAccountId(settings.roles, role)) assign(settings, role, account)
}

/** Removes an account. Roles that pointed at it go to the next account able to do them, or become empty. */
export function removeAccount(settings: AccountSettings, id: string): Account | undefined {
  const account = accountById(settings.accounts, id)
  if (!account) return undefined
  settings.accounts = settings.accounts.filter((a) => a.id !== id)
  for (const role of ROLES) if (roleAccountId(settings.roles, role) === id) assign(settings, role, accountsFor(settings.accounts, role)[0])
  return account
}

/** Points the language-model role at an account, with that account's suggested model. */
export const chooseLlmAccount = (settings: AccountSettings, account: Account | undefined): void => assign(settings, "llm", account)
