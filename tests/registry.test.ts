import assert from "node:assert/strict"
import { test } from "node:test"
import { ASR_PROVIDERS, asrProvider, fileProviders, liveProviders, resolveFile, resolveLive } from "../src/asr/providers/registry.ts"
import type { AsrProvider } from "../src/asr/providers/types.ts"
import { destinations } from "../src/consent.ts"
import { loadSettings, type MeetingLiveSettings } from "../src/settings.ts"

const secrets = (values: Record<string, string>) => ({ getSecret: (id: string) => values[id] ?? null })
const settings = (patch: (s: MeetingLiveSettings) => void = () => undefined) => {
  const { settings } = loadSettings(null)
  patch(settings)
  return settings
}

test("the registry lists Volcengine with its capabilities and destinations", () => {
  assert.deepEqual(ASR_PROVIDERS.map((p) => p.id), ["volc", "dashscope", "deepgram", "openai-compat"])
  const volc = asrProvider("volc")!
  assert.equal(volc.name, "火山引擎")
  assert.deepEqual(volc.live!.capabilities(settings()), { hotwords: true, endWindow: true, language: false, diarization: false })
  assert.deepEqual(volc.file!.capabilities(settings()), { language: false, diarization: true, fileSizeLimit: 60 * 1024 * 1024 })
  assert.equal(volc.live!.host(settings()), "openspeech.bytedance.com")
  assert.equal(volc.file!.host(settings()), "openspeech.bytedance.com")
  assert.equal(volc.live!.host(settings((s) => (s.providers.volc.endpoint = "ws://127.0.0.1:8790/asr"))), "127.0.0.1:8790")
  assert.equal(volc.live!.host(settings((s) => (s.providers.volc.endpoint = "not a url"))), "")
  assert.equal(asrProvider("other"), undefined)
})

test("live resolution reflects the credentials in storage at the time it is asked", () => {
  const s = settings((s) => (s.providers.volc.apiKeySecret = "volc-api-key"))
  const without = resolveLive({ secrets: secrets({}), settings: s })
  assert.equal(without.connect, null)
  assert.match(without.problem ?? "", /未配置火山引擎凭证/)
  const withKey = resolveLive({ secrets: secrets({ "volc-api-key": " k " }), settings: s })
  assert.equal(typeof withKey.connect, "function")
  assert.equal(withKey.problem, undefined)
  assert.deepEqual([withKey.id, withKey.name], ["volc", "火山引擎"])
})

test("file resolution carries the resource, the destination and the credential problem", () => {
  const s = settings((s) => {
    s.providers.volc.apiKeySecret = "volc-api-key"
    s.providers.volc.fileResourceId = " volc.bigasr.auc "
  })
  const file = resolveFile({ secrets: secrets({ "volc-api-key": "k" }), settings: s })
  assert.equal(file.model, "volc.bigasr.auc")
  assert.equal(file.host, "openspeech.bytedance.com")
  assert.equal(file.problem, undefined)
  assert.match(resolveFile({ secrets: secrets({}), settings: s }).problem ?? "", /凭证/)
  assert.equal(resolveFile({ secrets: secrets({}), settings: settings((x) => (x.providers.volc.fileResourceId = " ")) }).model, "volc.seedasr.auc")
})

test("an unknown provider id is reported instead of silently replaced", async () => {
  const s = settings((x) => {
    x.liveProvider = "gone"
    x.fileProvider = "gone"
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
    host: () => "live.example.com",
    resolve: () => ({ connect: async () => Promise.reject(new Error("unused")) }),
  },
  renderSettings: () => undefined,
}
const fileOnly: AsrProvider = {
  id: "file-only",
  name: "仅文件",
  file: {
    capabilities: () => ({ language: true, diarization: false, fileSizeLimit: 25 * 1024 * 1024 }),
    host: () => "file.example.com",
    resolve: () => ({ id: "file-only", name: "仅文件", host: "file.example.com", model: "m", capabilities: { language: true, diarization: false, fileSizeLimit: 1 }, directFormats: {}, transcribe: async () => Promise.reject(new Error("unused")) }),
  },
  renderSettings: () => undefined,
}

test("a provider may be live-only or file-only: the choices list only capable ones and a mismatched selection is reported", async () => {
  const providers = ASR_PROVIDERS as AsrProvider[]
  providers.push(liveOnly, fileOnly)
  try {
    assert.deepEqual(liveProviders().map((p) => p.id), ["volc", "dashscope", "deepgram", "live-only"])
    assert.deepEqual(fileProviders().map((p) => p.id), ["volc", "openai-compat", "file-only"])

    const mixed = settings((s) => {
      s.liveProvider = "live-only"
      s.fileProvider = "file-only"
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
      s.liveProvider = "file-only"
      s.fileProvider = "live-only"
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
  }
})
