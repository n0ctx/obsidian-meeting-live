import assert from "node:assert/strict"
import { test } from "node:test"
import { ASR_PROVIDERS, asrProvider, resolveFile, resolveLive } from "../src/asr/providers/registry.ts"
import { loadSettings, type MeetingLiveSettings } from "../src/settings.ts"

const secrets = (values: Record<string, string>) => ({ getSecret: (id: string) => values[id] ?? null })
const settings = (patch: (s: MeetingLiveSettings) => void = () => undefined) => {
  const { settings } = loadSettings(null)
  patch(settings)
  return settings
}

test("the registry lists Volcengine with its capabilities and destinations", () => {
  assert.deepEqual(ASR_PROVIDERS.map((p) => p.id), ["volc"])
  const volc = asrProvider("volc")!
  assert.equal(volc.name, "火山引擎")
  assert.deepEqual(volc.capabilities, { hotwords: true, endWindow: true, diarization: true, fileSizeLimit: 60 * 1024 * 1024 })
  assert.equal(volc.liveHost(settings()), "openspeech.bytedance.com")
  assert.equal(volc.fileHost(settings()), "openspeech.bytedance.com")
  assert.equal(volc.liveHost(settings((s) => (s.providers.volc.endpoint = "ws://127.0.0.1:8790/asr"))), "127.0.0.1:8790")
  assert.equal(volc.liveHost(settings((s) => (s.providers.volc.endpoint = "not a url"))), "")
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
