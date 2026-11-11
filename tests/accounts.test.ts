import assert from "node:assert/strict"
import { test } from "node:test"
import { ASR_PROVIDERS } from "../src/asr/providers/registry.ts"
import { addAccount, createAccount, isOwnSecret, newAccountId, removeAccount, secretIdFor } from "../src/accounts/manage.ts"
import { accountLabels, accountRoles, accountsFor, roleAccount, serviceRoles } from "../src/accounts/roles.ts"
import { SERVICES, presetOfService, serviceDef, serviceForPreset } from "../src/accounts/services.ts"
import { LLM_PRESETS } from "../src/llm/presets.ts"
import { loadSettings } from "../src/settings.ts"
import { withAccount } from "./support/accounts.ts"

const rolesOf = (service: string) => Object.entries(serviceRoles(serviceDef(service)!)).filter(([, can]) => can).map(([role]) => role)

test("each service offers the roles one key covers, and no more", () => {
  // The vendors whose single key covers several roles, from their documentation (see README).
  assert.deepEqual(rolesOf("dashscope"), ["live", "file", "llm"])
  assert.deepEqual(rolesOf("volc"), ["live", "file"])
  assert.deepEqual(rolesOf("deepgram"), ["live", "file"])
  assert.deepEqual(rolesOf("assemblyai"), ["live", "file"])
  assert.deepEqual(rolesOf("openai"), ["file", "llm"])
  assert.deepEqual(rolesOf("groq"), ["file", "llm"])
  // Separate vendors stay separate: Volcengine's Ark is a language model only, and speech has no model.
  assert.deepEqual(rolesOf("ark"), ["llm"])
  assert.deepEqual(rolesOf("deepseek"), ["llm"])
  // Local services are accounts too.
  assert.deepEqual(rolesOf("sherpa"), ["live"])
  assert.deepEqual(rolesOf("whisper-local"), ["file"])
  assert.deepEqual(rolesOf("local-speech"), ["live", "file"])
  assert.deepEqual(rolesOf("ollama"), ["llm"])
  assert.deepEqual(rolesOf("lmstudio"), ["llm"])
  assert.deepEqual(rolesOf("custom"), ["file", "llm"])
})

test("every language-model preset and every speech adapter is reachable from some service", () => {
  for (const preset of LLM_PRESETS) assert.ok(serviceForPreset(preset.id), `preset ${preset.id}`)
  for (const provider of ASR_PROVIDERS) assert.ok(SERVICES.some((s) => s.asr === provider.id), `adapter ${provider.id}`)
  for (const service of SERVICES) {
    assert.ok(service.name, service.id)
    for (const region of service.regions ?? []) assert.ok(presetOfService(service, { region: region.id }) || !service.presets, `${service.id}/${region.id}`)
  }
})

test("a role lists only the accounts that can serve it", () => {
  const { settings } = loadSettings(null)
  const volc = withAccount(settings, "volc", { key: "k" })
  const deepseek = withAccount(settings, "deepseek", { key: "k" })
  const groq = withAccount(settings, "groq", { key: "k" })
  const dashscope = withAccount(settings, "dashscope", { key: "k" })
  assert.deepEqual(accountsFor(settings.accounts, "live").map((a) => a.id), [volc.id, dashscope.id])
  assert.deepEqual(accountsFor(settings.accounts, "file").map((a) => a.id), [volc.id, groq.id, dashscope.id])
  assert.deepEqual(accountsFor(settings.accounts, "llm").map((a) => a.id), [deepseek.id, groq.id, dashscope.id])
  assert.equal(accountRoles({ ...deepseek, service: "gone" }).llm, false, "an account of an unknown service serves nothing")
})

test("a new account takes the roles that are still empty and that it can do, and keeps no other", () => {
  const { settings } = loadSettings(null)
  const volc = withAccount(settings, "volc")
  assert.deepEqual(settings.roles, { live: volc.id, file: volc.id, llm: { account: "", model: "" } })
  const deepseek = withAccount(settings, "deepseek")
  assert.deepEqual(settings.roles, { live: volc.id, file: volc.id, llm: { account: deepseek.id, model: "deepseek-flash" } })
  // Roles already chosen are not taken over by the next account.
  withAccount(settings, "dashscope")
  assert.deepEqual([settings.roles.live, settings.roles.file, settings.roles.llm.account], [volc.id, volc.id, deepseek.id])
  assert.equal(roleAccount(settings, "llm")?.id, deepseek.id)
})

test("removing an account moves its roles to the next one that can do them, or empties them", () => {
  const { settings } = loadSettings(null)
  const volc = withAccount(settings, "volc")
  const dashscope = withAccount(settings, "dashscope", { region: "cn" })
  assert.deepEqual([settings.roles.live, settings.roles.llm.account], [volc.id, dashscope.id])
  assert.equal(removeAccount(settings, volc.id)?.id, volc.id)
  assert.deepEqual([settings.roles.live, settings.roles.file], [dashscope.id, dashscope.id])
  removeAccount(settings, dashscope.id)
  assert.deepEqual(settings.roles, { live: "", file: "", llm: { account: "", model: "" } })
  assert.equal(removeAccount(settings, "gone"), undefined)
})

test("two accounts of one service are told apart in lists, and a name the user gave wins", () => {
  const { settings } = loadSettings(null)
  const a = withAccount(settings, "deepseek")
  const b = withAccount(settings, "deepseek")
  assert.deepEqual([...accountLabels(settings.accounts).values()], ["DeepSeek (1)", "DeepSeek (2)"])
  assert.notEqual(a.id, b.id)
  b.name = "Work"
  assert.deepEqual([...accountLabels(settings.accounts).values()], ["DeepSeek", "Work"])
  assert.equal(newAccountId(settings.accounts, "deepseek"), "deepseek-3")
})

test("the secret ids the plugin makes are valid for SecretStorage, and only those are the plugin's to clear", () => {
  for (const id of ["volc", "deepseek-2", "Weird_Id.1"]) assert.match(secretIdFor(id), /^[a-z0-9-]+$/)
  assert.equal(isOwnSecret(secretIdFor("volc")), true)
  assert.equal(isOwnSecret("volc-api-key"), false, "the ids 1.0.1 reads belong to the user")
  assert.equal(isOwnSecret("deepseek-api-key"), false)
})

test("a service with regions starts each account at its own region's address, and the region is kept in its options", () => {
  const def = serviceDef("dashscope")!
  const cn = createAccount([], def, "cn")
  const intl = createAccount([], def, "intl")
  assert.deepEqual([cn.options.region, cn.options.baseUrl], ["cn", "https://dashscope.aliyuncs.com/compatible-mode/v1"])
  assert.deepEqual([intl.options.region, intl.options.baseUrl], ["intl", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"])
  const kimi = createAccount([], serviceDef("kimi")!, "intl")
  assert.equal(kimi.options.baseUrl, "https://api.moonshot.ai/v1")
  assert.equal(presetOfService(serviceDef("kimi")!, kimi.options)?.id, "kimi-intl")
  const fresh = loadSettings(null).settings
  addAccount(fresh, kimi)
  assert.equal(fresh.roles.llm.model, "kimi-k3.1-pro")
})
