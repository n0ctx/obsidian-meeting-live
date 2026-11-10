// Checking a pasted key, against scripts/mock-server.ts and fakes: nothing here can reach a paid service or needs a real key.
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { after, before, test } from "node:test"
import type { Account } from "../src/accounts/account.ts"
import { freeCheck, hasFreeCheck, paidCheck, type CheckDeps, type CheckResult } from "../src/accounts/check.ts"
import { createAccount } from "../src/accounts/manage.ts"
import { serviceDef } from "../src/accounts/services.ts"
import { VOLC_LIVE_RESOURCES, detectVolcResource, fileResourceFor } from "../src/asr/providers/volc/detect.ts"
import { volcHandshake, type HandshakeResult } from "../src/asr/providers/volc/live.ts"
import type { HttpGet, HttpPost } from "../src/llm/client.ts"
import { loadSettings } from "../src/settings.ts"

let server: ChildProcess
let base = ""

before(async () => {
  server = spawn(process.execPath, ["--import", "./tests/support/register.mjs", "scripts/mock-server.ts", "0"], { stdio: ["ignore", "pipe", "inherit"] })
  base = await new Promise<string>((resolve, reject) => {
    server.stdout!.on("data", (chunk: Buffer) => {
      const match = /mock server on (http:\/\/127\.0\.0\.1:\d+)/.exec(chunk.toString())
      if (match) resolve(match[1])
    })
    server.on("exit", (code) => reject(new Error(`mock server exited with ${code}`)))
  })
})
after(() => server.kill())

const wsBase = () => base.replace("http", "ws")

/** Only this machine can be reached: a request to anything else throws, so a check that tried a real service would fail the test instead of calling it. */
const local = (url: string) => {
  assert.equal(new URL(url).hostname, "127.0.0.1", `would have called ${url}`)
}
const get: HttpGet = async (url, headers) => {
  local(url)
  const response = await fetch(url, { headers })
  return { status: response.status, text: await response.text() }
}
const post: HttpPost = async (url, headers, body) => {
  local(url)
  const response = await fetch(url, { method: "POST", headers, body })
  return { status: response.status, text: await response.text() }
}
const guardedHandshake: CheckDeps["volcHandshake"] = (config) => (local(config.endpoint.replace(/^ws/, "http")), volcHandshake(config))
const deps = (patch: Partial<CheckDeps> = {}): CheckDeps => ({ get, post, volcHandshake: guardedHandshake, secrets: { getSecret: () => null }, liveTest: async () => ({ ok: true }), ...patch })

function account(service: string, options: Record<string, unknown> = {}, region = ""): Account {
  return createAccount([], serviceDef(service)!, region, { options })
}
const say = (result: CheckResult) => (result.state === "failed" ? result.message : result.state)

test("a language-model account is checked with its model list, which also fills the picker", async () => {
  const custom = account("custom", { baseUrl: `${base}/v1` })
  const ok = await freeCheck(custom, "sk-1", deps())
  assert.deepEqual(ok, { state: "ok", models: ["mock-chat-large", "mock-chat-small"] })
  assert.match(say(await freeCheck(custom, "bad", deps())), /不认这个密钥（HTTP 401）/)
})

test("DashScope is checked at its own list, which is not under compatible-mode", async () => {
  const dashscope = account("dashscope", { baseUrl: `${base}/compatible-mode/v1` }, "cn")
  assert.deepEqual(await freeCheck(dashscope, "sk-1", deps()), { state: "ok", models: ["mock-chat-large", "mock-chat-small"] })
  assert.equal((await freeCheck(dashscope, "bad", deps())).state, "failed")
})

test("Deepgram is checked with its authentication test, at the host of the account's own address", async () => {
  const deepgram = account("deepgram", { endpoint: `${wsBase()}/v1/listen` })
  assert.deepEqual(await freeCheck(deepgram, "dg-1", deps()), { state: "ok" })
  assert.match(say(await freeCheck(deepgram, "bad", deps())), /401/)
  assert.match(say(await freeCheck(account("deepgram", { endpoint: "not a url" }), "k", deps())), /地址/)
})

test("AssemblyAI is checked by listing one transcript, with the key as the whole Authorization value", async () => {
  const seen: { url: string; auth: string | undefined }[] = []
  const fakeGet: HttpGet = async (url, headers) => (seen.push({ url, auth: headers.Authorization }), { status: headers.Authorization === "bad" ? 401 : 200, text: "{}" })
  const result = await freeCheck(account("assemblyai"), "as-1", deps({ get: fakeGet }))
  assert.deepEqual(result, { state: "ok" })
  assert.deepEqual(seen, [{ url: "https://api.assemblyai.com/v2/transcript?limit=1", auth: "as-1" }])
  assert.equal((await freeCheck(account("assemblyai", { region: "eu" }), "bad", deps({ get: fakeGet }))).state, "failed")
  assert.equal(seen[1].url, "https://api.eu.assemblyai.com/v2/transcript?limit=1")
})

test("a server that cannot be reached, or answers with something else, is said so in plain words", async () => {
  const refused: HttpGet = async () => {
    throw new Error("connect ECONNREFUSED")
  }
  assert.match(say(await freeCheck(account("custom", { baseUrl: "http://127.0.0.1:9/v1" }), "k", deps({ get: refused }))), /连不上服务器：connect ECONNREFUSED/)
  const teapot: HttpGet = async () => ({ status: 500, text: "oops" })
  assert.match(say(await freeCheck(account("custom", { baseUrl: "http://127.0.0.1:9/v1" }), "k", deps({ get: teapot }))), /HTTP 500/)
})

test("a service with no documented list asks for a manual Test, and the Test sends one small request", async () => {
  for (const service of ["glm", "ark"]) {
    const manual = account(service, {}, service === "glm" ? "cn" : "")
    assert.equal(hasFreeCheck(manual), false, service)
    const never: HttpGet = async () => assert.fail("a manual service must not be called for free")
    assert.deepEqual(await freeCheck(manual, "k", deps({ get: never })), { state: "manual" })
  }
  // Custom is tried for free first, and falls to manual when the server has no /models.
  const noList: HttpGet = async () => ({ status: 404, text: "" })
  assert.deepEqual(await freeCheck(account("custom", { baseUrl: `${base}/v1` }), "k", deps({ get: noList })), { state: "manual" })

  const glm = account("glm", { baseUrl: `${base}/v1` }, "cn")
  assert.deepEqual(await paidCheck(glm, "k", deps(), "glm-5.3"), { state: "ok", note: "测试通过：" + ((await paidCheck(glm, "k", deps(), "glm-5.3")) as { note: string }).note.replace("测试通过：", "") })
  assert.match(say(await paidCheck(glm, "bad", deps(), "glm-5.3")), /401/)
  assert.match(say(await paidCheck(glm, "k", deps(), "")), /模型/, "the Test needs a model to ask")
})

test("a recognizer or a server on this computer needs no key: it is reachable or it is not", async () => {
  const whisper = account("whisper-local", { baseUrl: `${base}/v1` })
  assert.equal((await freeCheck(whisper, "", deps())).state, "ok")
  assert.equal(hasFreeCheck(whisper), true)
  const down: HttpGet = async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:8080")
  }
  assert.match(say(await freeCheck(whisper, "", deps({ get: down }))), /ECONNREFUSED/)
  assert.deepEqual(await freeCheck(account("sherpa"), "", deps({ liveTest: async () => ({ ok: true }) })), { state: "ok" })
  assert.match(say(await freeCheck(account("sherpa"), "", deps({ liveTest: async () => ({ ok: false, message: "连不上" }) }))), /连不上/)
  // Ollama and LM Studio list their models, and fall back to reachability when they cannot.
  const ollama = account("ollama", { baseUrl: `${base}/v1` })
  assert.equal(((await freeCheck(ollama, "", deps())) as { models: string[] }).models.length, 2)
})

test("Volcengine: a key that has the 2.0 resource keeps it, and the file resource is not touched", async () => {
  const volc = account("volc", { endpoint: `${wsBase()}/asr` })
  const result = await freeCheck(volc, "any-key", deps())
  assert.deepEqual(result.state === "ok" && result.options, { resourceId: "volc.seedasr.sauc.duration" })
})

test("Volcengine: a key without the 2.0 resource falls back to 1.0, and files follow it", async () => {
  const volc = account("volc", { endpoint: `${wsBase()}/asr` })
  const result = await freeCheck(volc, "key-1.0-only", deps())
  assert.deepEqual(result.state === "ok" && result.options, { resourceId: "volc.bigasr.sauc.duration", fileResourceId: "volc.bigasr.auc" })
  assert.match(result.state === "ok" ? (result.note ?? "") : "", /volc\.bigasr\.sauc\.duration/)
})

test("Volcengine: a resource the account already has is kept if it works, so a 1.0 user is not moved to 2.0", async () => {
  const volc = account("volc", { endpoint: `${wsBase()}/asr`, resourceId: "volc.bigasr.sauc.duration", fileResourceId: "volc.seedasr.auc" })
  const result = await freeCheck(volc, "any-key", deps())
  assert.deepEqual(result.state === "ok" && result.options?.resourceId, "volc.bigasr.sauc.duration")
  // The file resource the user set is theirs: it is not rewritten from the streaming one.
  assert.deepEqual(result.state === "ok" && result.options, { resourceId: "volc.bigasr.sauc.duration" }, "nothing about the files is touched")
})

test("Volcengine: a refused key, a missing credential and an unreachable server each say so", async () => {
  const volc = account("volc", { endpoint: `${wsBase()}/asr` })
  assert.match(say(await freeCheck(volc, "bad", deps())), /火山引擎拒绝了连接（HTTP 401）/)
  assert.match(say(await freeCheck(volc, "", deps())), /未配置火山引擎凭证/)
  assert.match(say(await freeCheck(account("volc", { endpoint: "ws://127.0.0.1:9/asr" }), "k", deps())), /连不上服务器/)
})

test("the detection tries the account's own resource first, then the known ones in order, and stops at the first that is accepted", async () => {
  const tried: string[] = []
  const config = { endpoint: "ws://x", resourceId: "custom.resource", apiKey: "k", appId: "", accessToken: "", endWindowMs: 800 }
  const refuse = (status: number, body = ""): HandshakeResult => ({ ok: false, status, body })
  const only = (accepted: string) => async (c: { resourceId: string }) => (tried.push(c.resourceId), c.resourceId === accepted ? ({ ok: true } as HandshakeResult) : refuse(403, "requested resource not granted"))
  assert.deepEqual(await detectVolcResource(config, only("volc.bigasr.sauc.duration")), { state: "ok", resourceId: "volc.bigasr.sauc.duration", changed: true })
  assert.deepEqual(tried, ["custom.resource", ...VOLC_LIVE_RESOURCES])
  tried.length = 0
  assert.deepEqual(await detectVolcResource(config, only("custom.resource")), { state: "ok", resourceId: "custom.resource", changed: false })
  assert.deepEqual(tried, ["custom.resource"])
  assert.deepEqual(await detectVolcResource(config, async () => refuse(403, "nope")), { state: "refused", status: 403, body: "nope" })
  assert.deepEqual(await detectVolcResource(config, async () => refuse(0, "ECONNREFUSED")), { state: "unreachable", message: "ECONNREFUSED" })
})

test("the file resource follows the streaming one only while it is still the default", () => {
  assert.equal(fileResourceFor("volc.bigasr.sauc.duration", "volc.seedasr.auc", "volc.seedasr.auc"), "volc.bigasr.auc")
  assert.equal(fileResourceFor("volc.seedasr.sauc.duration", "volc.seedasr.auc", "volc.seedasr.auc"), "volc.seedasr.auc")
  assert.equal(fileResourceFor("volc.bigasr.sauc.duration", "volc.bigasr.auc_turbo", "volc.seedasr.auc"), "volc.bigasr.auc_turbo")
})

test("which services show Check (free) and which Test (may count as usage)", () => {
  const free = ["deepseek", "openai", "anthropic", "gemini", "openrouter", "kimi", "siliconflow", "grok", "mistral", "groq", "azure", "ollama", "lmstudio", "dashscope", "custom", "volc", "deepgram", "assemblyai", "sherpa", "whisper-local"]
  for (const service of free) assert.equal(hasFreeCheck(account(service, {}, serviceDef(service)!.regions ? "intl" : "")), true, service)
  for (const service of ["glm", "ark"]) assert.equal(hasFreeCheck(account(service, {}, serviceDef(service)!.regions ? "cn" : "")), false, service)
  assert.equal(hasFreeCheck(account("minimax", {}, "cn")), false, "only the international MiniMax host documents a list")
  assert.equal(hasFreeCheck(account("minimax", {}, "intl")), true)
  // Unused settings are not needed to build any of these.
  assert.equal(loadSettings(null).settings.accounts.length, 0)
})
