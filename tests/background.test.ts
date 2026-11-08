import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { inBackground } from "../src/background.ts"
import { MeetingManager } from "../src/meeting/manager.ts"
import type { MeetingStore } from "../src/meeting/store.ts"
import { DEFAULT_SETTINGS } from "../src/settings.ts"
import { notices } from "./support/obsidian.ts"

const settle = () => new Promise((r) => setImmediate(r))

test("a failure in background work is logged and shown in a notice, and nothing is left unhandled", async () => {
  const logged = mock.method(console, "error", () => undefined)
  try {
    const before = notices.length
    inBackground(Promise.reject(new Error("无法保存")))
    inBackground(Promise.resolve())
    await settle()
    assert.deepEqual(notices.slice(before), ["无法保存"])
    // Node itself may print a warning through console.error; only the plugin's own entries count.
    assert.equal(logged.mock.calls.filter((c) => c.arguments[0] === "[meeting-live]").length, 1)
  } finally {
    logged.mock.restore()
  }
})

test("a scan of the meeting folders that failed is repeated by the next load, not remembered as the answer", async () => {
  let scans = 0
  const store = {
    scan: async () => {
      if (scans++ === 0) throw new Error("读取目录失败")
      return []
    },
  } as unknown as MeetingStore
  const manager = new MeetingManager(store, { settings: () => DEFAULT_SETTINGS } as never)
  await assert.rejects(manager.load(), /读取目录失败/)
  await manager.load()
  assert.equal(scans, 2)
  await manager.load()
  assert.equal(scans, 2, "a scan that worked is kept")
})
