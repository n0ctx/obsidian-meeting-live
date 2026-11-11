import assert from "node:assert/strict"
import { test } from "node:test"
import { ASR_PROVIDERS, asrProvider, fileProviders, liveProviders, resolveFile, resolveLive } from "../src/asr/providers/registry.ts"
import type { AsrProvider } from "../src/asr/providers/types.ts"
import { SERVICES, type ServiceDef } from "../src/accounts/services.ts"
import { destinations } from "../src/consent.ts"
import type { MeetingLiveSettings } from "../src/settings.ts"
import { withAccount, withOne } from "./support/accounts.ts"

const secrets = (values: Record<string, string>) => ({ getSecret: (id: string) => values[id] ?? null })
/** The settings of someone with a Volcengine account and a DeepSeek account (the 1.0.1 configuration), changed by `patch`. */
const settings = (patch: (s: MeetingLiveSettings, volc: Record<string, unknown>) => void = () => undefined) => {
  const { settings, account } = withOne("volc", { key: "volc-api-key" })
  withAccount(settings, "deepseek", { key: "deepseek-api-key" })
  patch(settings, account.options)
  return settings
}
const volcAccount = (s: MeetingLiveSettings) => s.accounts.find((a) => a.service === "volc")!

test("the registry lists Volcengine with its capabilities and destinations", () => {
  assert.deepEqual(ASR_PROVIDERS.map((p) => p.id), ["volc", "dashscope", "assemblyai", "deepgram", "openai-compat", "sherpa-onnx", "whisper-local", "local-speech"])
  const volc = asrProvider("volc")!
  assert.equal(volc.name, "火山引擎")
  const account = volcAccount(settings())
  assert.deepEqual(volc.live!.capabilities(account), { hotwords: true, endWindow: true, language: false, diarization: false, context: true })
  assert.deepEqual(volc.file!.capabilities(account), { language: false, diarization: true, fileSizeLimit: 60 * 1024 * 1024, context: true })
  assert.equal(volc.live!.host(account), "openspeech.bytedance.com")
  assert.equal(volc.file!.host(account), "openspeech.bytedance.com")
  assert.equal(volc.live!.host(volcAccount(settings((_, o) => (o.endpoint = "ws://127.0.0.1:8790/asr")))), "127.0.0.1:8790")
  assert.equal(volc.live!.host(volcAccount(settings((_, o) => (o.endpoint = "not a url")))), "")
  assert.equal(asrProvider("other"), undefined)
})

test("live resolution reflects the credentials in storage at the time it is asked", () => {
  const s = settings()
  const without = resolveLive({ secrets: secrets({}), settings: s })
  assert.equal(without.connect, null)
  assert.match(without.problem ?? "", /未配置火山引擎凭证/)
  const withKey = resolveLive({ secrets: secrets({ "volc-api-key": " k " }), settings: s })
  assert.equal(typeof withKey.connect, "function")
  assert.equal(withKey.problem, undefined)
  assert.deepEqual([withKey.id, withKey.name], ["volc", "火山引擎"])
})

test("file resolution carries the resource, the destination and the credential problem", () => {
  const s = settings((_, o) => (o.fileResourceId = " volc.bigasr.auc "))
  const file = resolveFile({ secrets: secrets({ "volc-api-key": "k" }), settings: s })
  assert.equal(file.model, "volc.bigasr.auc")
  assert.equal(file.host, "openspeech.bytedance.com")
  assert.equal(file.problem, undefined)
  assert.match(resolveFile({ secrets: secrets({}), settings: s }).problem ?? "", /凭证/)
  assert.equal(resolveFile({ secrets: secrets({}), settings: settings((_, o) => (o.fileResourceId = " ")) }).model, "volc.seedasr.auc")
})

test("an account of a service this version does not know is reported instead of silently replaced", async () => {
  const s = settings((x) => {
    x.accounts.push({ ...volcAccount(x), id: "gone", service: "gone" })
    x.roles.live = "gone"
    x.roles.file = "gone"
  })
  const live = resolveLive({ secrets: secrets({}), settings: s })
  assert.equal(live.connect, null)
  assert.match(live.problem ?? "", /未知的语音识别服务「gone」/)
  const file = resolveFile({ secrets: secrets({}), settings: s })
  assert.match(file.problem ?? "", /gone/)
  await assert.rejects(file.transcribe({ data: new Uint8Array(), format: "mp3", transcoded: false, bytes: 0 }, { speakers: false, post: async () => ({ status: 200, headers: {}, text: "" }) }), /gone/)
})

/** A service that only listens live, and one that only transcribes files, as the settings and the resolvers must treat them. */
const liveOnly: AsrProvider = {
  id: "live-only",
  name: "仅实时",
  live: {
    capabilities: () => ({ hotwords: false, endWindow: false, language: true, diarization: true }),
    pacing: () => ({ maxRate: 2 }),
    host: () => "live.example.com",
    resolve: () => ({ connect: async () => Promise.reject(new Error("unused")) }),
  },
  renderAdvanced: () => undefined,
}
const fileOnly: AsrProvider = {
  id: "file-only",
  name: "仅文件",
  file: {
    capabilities: () => ({ language: true, diarization: false, fileSizeLimit: 25 * 1024 * 1024 }),
    host: () => "file.example.com",
    resolve: () => ({ id: "file-only", name: "仅文件", host: "file.example.com", model: "m", capabilities: { language: true, diarization: false, fileSizeLimit: 1 }, directFormats: {}, transcribe: async () => Promise.reject(new Error("unused")) }),
  },
  renderAdvanced: () => undefined,
}

/** Each fake speech service gets a service of its own, so an account can be made for it. */
const serviceFor = (provider: AsrProvider): ServiceDef => ({ id: provider.id, name: provider.name, asr: provider.id, keyUrl: () => "", options: () => ({}) })

test("a provider may be live-only or file-only: the choices list only capable ones and a mismatched selection is reported", async () => {
  const providers = ASR_PROVIDERS as AsrProvider[]
  const services = SERVICES as ServiceDef[]
  providers.push(liveOnly, fileOnly)
  services.push(serviceFor(liveOnly), serviceFor(fileOnly))
  try {
    assert.deepEqual(liveProviders().map((p) => p.id), ["volc", "dashscope", "assemblyai", "deepgram", "sherpa-onnx", "local-speech", "live-only"])
    assert.deepEqual(fileProviders().map((p) => p.id), ["volc", "dashscope", "assemblyai", "deepgram", "openai-compat", "whisper-local", "local-speech", "file-only"])

    const mixed = settings((s) => {
      s.roles.live = withAccount(s, "live-only").id
      s.roles.file = withAccount(s, "file-only").id
    })
    assert.deepEqual(destinations(mixed), [
      { kind: "live", name: "仅实时", host: "live.example.com" },
      { kind: "file", name: "仅文件", host: "file.example.com" },
      { kind: "llm", name: "api.deepseek.com", host: "api.deepseek.com", detail: "deepseek-flash" },
    ])
    assert.equal(resolveLive({ secrets: secrets({}), settings: mixed }).problem, undefined)
    assert.equal(resolveFile({ secrets: secrets({}), settings: mixed }).model, "m")

    // Selecting a provider for a job it cannot do gives a reason, a recorded gap rather than a crash, and no destination.
    const wrong = settings((s) => {
      s.roles.live = withAccount(s, "file-only").id
      s.roles.file = withAccount(s, "live-only").id
    })
    const live = resolveLive({ secrets: secrets({}), settings: wrong })
    assert.equal(live.connect, null)
    assert.match(live.problem ?? "", /仅文件不支持实时识别/)
    const file = resolveFile({ secrets: secrets({}), settings: wrong })
    assert.match(file.problem ?? "", /仅实时不支持录音文件识别/)
    await assert.rejects(file.transcribe({ data: new Uint8Array(), format: "mp3", transcoded: false, bytes: 0 }, { speakers: false, post: async () => ({ status: 200, headers: {}, text: "" }) }), /不支持/)
    assert.deepEqual(destinations(wrong).map((d) => d.kind), ["llm"])
  } finally {
    providers.splice(providers.indexOf(liveOnly), 1)
    providers.splice(providers.indexOf(fileOnly), 1)
    services.splice(services.length - 2, 2)
  }
})
