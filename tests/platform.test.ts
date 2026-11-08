import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { AudioCapture } from "../src/audio/capture.ts"
import { currentOs, platformText, type Os, type PlatformTopic } from "../src/platform.ts"
import { setLanguage, setPlatform } from "./support/obsidian.ts"

afterEach(() => {
  setLanguage("zh-CN")
  setPlatform("mac")
})

const OSES: Os[] = ["mac", "win", "linux"]
const TOPICS: PlatformTopic[] = ["systemAudio", "micDenied", "reveal"]

test("the operating system comes from Obsidian's Platform", () => {
  for (const os of OSES) {
    setPlatform(os)
    assert.equal(currentOs(), os)
  }
})

test("every topic has its own wording for every system in both languages", () => {
  for (const topic of TOPICS) {
    for (const lang of ["zh", "en"] as const) {
      const texts = OSES.map((os) => platformText(topic, os, lang))
      assert.equal(new Set(texts).size, 3, `${topic} ${lang} repeats a text across systems`)
    }
  }
})

test("macOS keeps its Chinese wording from 1.0.1", () => {
  assert.equal(platformText("micDenied", "mac", "zh"), "麦克风权限被拒绝。请在 系统设置 → 隐私与安全性 → 麦克风 中允许 Obsidian")
  assert.equal(platformText("systemAudio", "mac", "zh"), "普通麦克风只能录到现场声音。线上会议的远端声音需要通过 BlackHole 等虚拟声卡或聚合设备接入后在此选择。")
  assert.equal(platformText("reveal", "mac", "zh"), "在访达中显示会议文件夹")
})

test("system audio advice names the right tools for each system", () => {
  const advice = (os: Os) => platformText("systemAudio", os, "en")
  assert.match(advice("mac"), /BlackHole/)
  assert.doesNotMatch(advice("mac"), /Stereo Mix|monitor/)
  assert.match(advice("win"), /Stereo Mix/)
  assert.match(advice("win"), /VB-CABLE/)
  assert.doesNotMatch(advice("win"), /BlackHole/)
  assert.match(advice("linux"), /PulseAudio or PipeWire/)
  assert.match(advice("linux"), /monitor/)
  assert.doesNotMatch(advice("linux"), /BlackHole|VB-CABLE/)
  assert.match(platformText("systemAudio", "win", "zh"), /立体声混音/)
  assert.match(platformText("systemAudio", "linux", "zh"), /monitor/)
})

test("microphone permission advice points at the right settings for each system", () => {
  assert.match(platformText("micDenied", "mac", "en"), /System Settings → Privacy & Security → Microphone/)
  assert.match(platformText("micDenied", "win", "en"), /Windows Settings → Privacy & security → Microphone/)
  assert.match(platformText("micDenied", "linux", "en"), /Flatpak or Snap/)
  assert.match(platformText("reveal", "mac", "en"), /Finder/)
  assert.match(platformText("reveal", "win", "en"), /File Explorer/)
  assert.doesNotMatch(platformText("reveal", "linux", "en"), /Finder|Explorer/)
})

test("a denied microphone is reported with the advice for this system and language", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })) } } })
  try {
    await denied()
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original)
  }
})

async function denied(): Promise<void> {
  const open = () => AudioCapture.open({ deviceId: "", voiceProcessing: false }, () => undefined, () => undefined)
  setPlatform("win")
  await assert.rejects(open, { message: platformText("micDenied", "win", "zh") })
  setLanguage("en")
  setPlatform("linux")
  await assert.rejects(open, { message: platformText("micDenied", "linux", "en") })
  setPlatform("mac")
  await assert.rejects(open, /System Settings/)}
