import assert from "node:assert/strict"
import { test } from "node:test"
import { accountLlmConfig } from "../src/accounts/llm.ts"
import { createAccount } from "../src/accounts/manage.ts"
import { serviceDef } from "../src/accounts/services.ts"
import type { HttpGet } from "../src/llm/client.ts"
import { curatedModels, hasListing, listModels, parseModels } from "../src/llm/models.ts"
import { LLM_PRESETS, presetById } from "../src/llm/presets.ts"

/** The configuration of a new account of a service, with a key, ready for a call. */
function configFor(service: string, region = "", options: Record<string, unknown> = {}, key = "sk-test") {
  const def = serviceDef(service)!
  const account = createAccount([], def, region, { options })
  return accountLlmConfig(account, key, "")!
}

/** A GET that records what it was asked and answers from a table; any host outside this machine would be a paid call, so there is no way to make one. */
function fake(answers: Record<string, { status: number; body?: unknown } | Error>) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const get: HttpGet = async (url, headers) => {
    calls.push({ url, headers })
    const answer = answers[url] ?? { status: 404 }
    if (answer instanceof Error) throw answer
    return { status: answer.status, text: typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body ?? {}) }
  }
  return { get, calls }
}

const list = (...ids: string[]) => ({ object: "list", data: ids.map((id) => ({ id })) })

test("the list is fetched from the address the account names, with the key the preset's way, and sorted", async () => {
  const deepseek = configFor("deepseek")
  const a = fake({ "https://api.deepseek.com/models": { status: 200, body: list("deepseek-v4-pro", "deepseek-flash") } })
  assert.deepEqual(await listModels("deepseek", deepseek, a.get), { state: "ok", models: ["deepseek-flash", "deepseek-v4-pro"] })
  assert.equal(a.calls[0].headers.Authorization, "Bearer sk-test")

  const azure = configFor("azure", "", { baseUrl: "https://acme.openai.azure.com/openai/v1" })
  const b = fake({ "https://acme.openai.azure.com/openai/v1/models": { status: 200, body: list("gpt-5") } })
  assert.deepEqual(await listModels("azure", azure, b.get), { state: "ok", models: [] }, "base models are not deployments, so Azure's list only checks the key")
  assert.equal(b.calls[0].headers["api-key"], "sk-test")
  assert.equal(b.calls[0].headers.Authorization, undefined)

  const qwen = configFor("dashscope", "cn")
  const c = fake({ "https://dashscope.aliyuncs.com/api/v1/models?page_size=100": { status: 200, body: { output: { models: [{ model: "qwen-plus" }, { model: "text-embedding-v4" }, { model: "qwen3-asr-flash" }] } } } })
  assert.deepEqual(await listModels("qwen", qwen, c.get), { state: "ok", models: ["qwen-plus"] }, "DashScope's list is not under compatible-mode, and its embedding and speech models are left out")

  const anthropic = configFor("anthropic")
  const d = fake({ "https://api.anthropic.com/v1/models?limit=1000": { status: 200, body: list("claude-sonnet-5-5") } })
  assert.deepEqual(await listModels("anthropic", anthropic, d.get), { state: "ok", models: ["claude-sonnet-5-5"] })
})

test("models that do not chat are left out, and what a service puts around an id is removed", () => {
  assert.deepEqual(parseModels({ shape: "openai", exclude: /embedding|whisper/ }, list("gpt-5", "text-embedding-3", "whisper-1")), ["gpt-5"])
  assert.deepEqual(parseModels({ shape: "openai", strip: /^models\// }, list("models/gemini-3.8-flash")), ["gemini-3.8-flash"])
  assert.deepEqual(parseModels({ shape: "openai", keep: (e) => e.active !== false }, { data: [{ id: "a", active: false }, { id: "b" }] }), ["b"])
  assert.equal(parseModels({ shape: "openai" }, { models: [] }), undefined, "another shape is not a list")
  assert.equal(parseModels({ shape: "openai" }, "junk"), undefined)
  assert.deepEqual(parseModels({ shape: "openai" }, list("b", "a", "a")), ["a", "b"])
})

test("OpenRouter's key is checked at /key, since its list needs no key", async () => {
  const config = configFor("openrouter")
  const bad = fake({ "https://openrouter.ai/api/v1/key": { status: 401 }, "https://openrouter.ai/api/v1/models": { status: 200, body: list("x/y") } })
  assert.deepEqual(await listModels("openrouter", config, bad.get), { state: "rejected", status: 401 })
  const good = fake({ "https://openrouter.ai/api/v1/key": { status: 200, body: {} }, "https://openrouter.ai/api/v1/models": { status: 200, body: list("x/y") } })
  assert.deepEqual(await listModels("openrouter", config, good.get), { state: "ok", models: ["x/y"] })
})

test("each outcome is told apart: refused key, no list, an unreachable server, a server error, a reply that is not a list", async () => {
  const config = configFor("openai")
  const url = "https://api.openai.com/v1/models"
  assert.deepEqual(await listModels("openai", config, fake({ [url]: { status: 401 } }).get), { state: "rejected", status: 401 })
  assert.deepEqual(await listModels("openai", config, fake({ [url]: { status: 403 } }).get), { state: "rejected", status: 403 })
  assert.deepEqual(await listModels("openai", config, fake({ [url]: { status: 404 } }).get), { state: "none" })
  assert.deepEqual(await listModels("openai", config, fake({ [url]: { status: 200, body: "<html>" } }).get), { state: "none" })
  assert.deepEqual(await listModels("openai", config, fake({ [url]: { status: 200, body: { hello: 1 } } }).get), { state: "none" })
  const down = await listModels("openai", config, fake({ [url]: new Error("ECONNREFUSED") }).get)
  assert.deepEqual(down, { state: "failed", message: "ECONNREFUSED" })
  const broken = await listModels("openai", config, fake({ [url]: { status: 500, body: "oops" } }).get)
  assert.equal(broken.state, "failed")
})

test("DashScope's 403 is not taken for a bad key, since a good key can lack access to the list", async () => {
  const config = configFor("dashscope", "cn")
  const url = "https://dashscope.aliyuncs.com/api/v1/models?page_size=100"
  assert.deepEqual(await listModels("qwen", config, fake({ [url]: { status: 401 } }).get), { state: "rejected", status: 401 })
  assert.deepEqual(await listModels("qwen", config, fake({ [url]: { status: 403 } }).get), { state: "none" })
})

test("a service with no documented list is never called, and falls back to the short list", async () => {
  for (const id of ["glm", "glm-intl", "ark", "minimax"]) {
    assert.equal(hasListing(id), false, id)
    const none = fake({})
    assert.deepEqual(await listModels(id, configFor("glm"), none.get), { state: "none" })
    assert.equal(none.calls.length, 0, `${id} makes no call`)
  }
})

test("the fallback list starts with the preset's own suggestion, without repeats, and every preset has one or none to offer", () => {
  assert.deepEqual(curatedModels("deepseek", "deepseek-flash"), ["deepseek-flash", "deepseek-v4-pro"])
  assert.deepEqual(curatedModels("groq", "openai/gpt-oss-120b").slice(0, 1), ["openai/gpt-oss-120b"])
  assert.deepEqual(curatedModels("openrouter", ""), [], "a service with no suggestion offers nothing, and the picker goes straight to Other")
  assert.deepEqual(curatedModels("mistral", "mistral-small-latest"), ["mistral-small-latest"])
  for (const preset of LLM_PRESETS) assert.equal(new Set(curatedModels(preset.id, preset.model)).size, curatedModels(preset.id, preset.model).length)
})

test("Groq is a preset with its documented shape", () => {
  const groq = presetById("groq")
  assert.equal(groq.baseUrl, "https://api.groq.com/openai/v1")
  assert.deepEqual([groq.temperature, groq.effort, groq.json, groq.auth, groq.keyRequired], [true, "none", "always", "bearer", true])
  assert.equal(presetById("groq").matches(new URL("https://api.groq.com/openai/v1")), true)
})
