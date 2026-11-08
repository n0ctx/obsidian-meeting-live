// What an account can be picked for, and the names that tell accounts apart.
import { asrProvider } from "../asr/providers/registry.ts"
import { type Account, type AccountSettings, type Role, accountById, roleAccountId } from "./account.ts"
import { serviceDef, type ServiceDef } from "./services.ts"

export type RoleSet = Record<Role, boolean>

const NONE: RoleSet = { live: false, file: false, llm: false }

/** A service's roles follow from what is behind it: the speech adapter's live and file services, and a language-model preset. */
export function serviceRoles(def: ServiceDef): RoleSet {
  const provider = def.asr ? asrProvider(def.asr) : undefined
  return { live: !!provider?.live, file: !!provider?.file, llm: !!def.presets }
}

/** The roles an account's service can do; none for a service this version does not know. */
export function accountRoles(account: Account): RoleSet {
  const def = serviceDef(account.service)
  return def ? serviceRoles(def) : NONE
}

/** The accounts that can be picked for a role, in the order they were added. */
export const accountsFor = (accounts: readonly Account[], role: Role): Account[] => accounts.filter((a) => accountRoles(a)[role])

/** The account a role points at, if it is still there and can still do the job. */
export function roleAccount(settings: AccountSettings, role: Role): Account | undefined {
  const account = accountById(settings.accounts, roleAccountId(settings.roles, role))
  return account && accountRoles(account)[role] ? account : undefined
}

/** What an account is called in lists: its own name, else its service's; accounts that would read the same get a number. */
export function accountLabels(accounts: readonly Account[]): Map<string, string> {
  const base = accounts.map((a) => a.name.trim() || serviceDef(a.service)?.name || a.service)
  const seen = new Map<string, number>()
  const labels = new Map<string, string>()
  accounts.forEach((account, i) => {
    const n = (seen.get(base[i]) ?? 0) + 1
    seen.set(base[i], n)
    labels.set(account.id, base.filter((b) => b === base[i]).length > 1 ? `${base[i]} (${n})` : base[i])
  })
  return labels
}

export const accountLabel = (accounts: readonly Account[], account: Account): string => accountLabels(accounts).get(account.id) ?? account.id
