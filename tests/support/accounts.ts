// Settings fixtures that start from the accounts model: a fresh install has no account, so a test names the ones it needs.
import { addAccount, createAccount } from "../../src/accounts/manage.ts"
import type { Account } from "../../src/accounts/account.ts"
import { serviceDef } from "../../src/accounts/services.ts"
import { loadSettings, type MeetingLiveSettings } from "../../src/settings.ts"

export interface AccountPatch {
  region?: string
  /** SecretStorage id of the key. */
  key?: string
  name?: string
  options?: Record<string, unknown>
}

/** Adds an account of a service, which takes every role it can do and that is still empty, as it does in the settings page. */
export function withAccount(settings: MeetingLiveSettings, service: string, patch: AccountPatch = {}): Account {
  const def = serviceDef(service)
  if (!def) throw new Error(`no service ${service}`)
  const account = createAccount(settings.accounts, def, patch.region ?? (def.regions ? "cn" : ""), { name: patch.name, options: patch.options })
  account.apiKeySecret = patch.key ?? ""
  addAccount(settings, account)
  return account
}

/** The settings of someone who has a Volcengine key and a DeepSeek key, as the 1.0.1 defaults gave them everything else. */
export function volcAndDeepseek(patch: (settings: MeetingLiveSettings) => void = () => undefined): MeetingLiveSettings {
  const { settings } = loadSettings({ volcApiKeySecret: "volc-api-key", llmApiKeySecret: "deepseek-api-key" })
  patch(settings)
  return settings
}

/** A fresh install with one account of a service. */
export function withOne(service: string, patch: AccountPatch = {}): { settings: MeetingLiveSettings; account: Account } {
  const settings = loadSettings(null).settings
  return { settings, account: withAccount(settings, service, patch) }
}
