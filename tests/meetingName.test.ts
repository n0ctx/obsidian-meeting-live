import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { FileSystemAdapter, TFile, TFolder } from "obsidian"
import { MeetingSession, type SessionEnv } from "../src/meeting/session.ts"
import { MeetingStore, movedPath, transcriptFileName } from "../src/meeting/store.ts"
import type { MeetingMeta } from "../src/meeting/types.ts"
import { DEFAULT_SETTINGS } from "../src/settings.ts"

// The stub's TFile and TFolder take paths; the real typings expose no public constructors.
const file = (path: string) => new (TFile as unknown as new (path: string) => TFile)(path)
const folder = (path: string, children: (TFile | TFolder)[]) => new (TFolder as unknown as new (path: string, children: (TFile | TFolder)[]) => TFolder)(path, children)

/** A vault on a temporary directory, with just the adapter, vault and file manager calls the store makes. */
function tempVault() {
  const root = mkdtempSync(join(tmpdir(), "meeting-live-"))
  const full = (path: string) => join(root, path)
  const adapter = Object.assign(Object.create(FileSystemAdapter.prototype), {
    exists: async (path: string) => existsSync(full(path)),
    mkdir: async (path: string) => void mkdirSync(full(path), { recursive: true }),
    write: async (path: string, data: string) => writeFileSync(full(path), data),
    getFullPath: full,
  })
  const tree = (path: string): TFolder =>
    folder(path, readdirSync(full(path)).map((name) => (statSync(full(`${path}/${name}`)).isDirectory() ? tree(`${path}/${name}`) : file(`${path}/${name}`))))
  const renames: string[] = []
  const app = {
    vault: { adapter, getFolderByPath: (path: string) => (existsSync(full(path)) ? tree(path) : null) },
    fileManager: {
      renameFile: async (target: TFile | TFolder, path: string) => {
        renames.push(path)
        renameSync(full(target.path), full(path))
      },
    },
  }
  const list = (path: string) => readdirSync(full(path), { recursive: true }).map(String).sort()
  return { store: new MeetingStore(app as never, () => "Meetings"), root, list, renames, put: (path: string) => writeFileSync(full(path), "") }
}

const meeting = (notePath: string) => ({ id: "m-1", title: notePath.slice(6, -3), notePath, createdAt: "2026-10-30T10:00:00+08:00" }) as MeetingMeta

test("a meeting folder and its files are named after the note, numbered when the name is taken", async () => {
  const { store, list } = tempVault()
  const first = meeting("Daily/2026年10月30日.md")
  assert.equal(await store.create(first, "火山引擎"), "Meetings/2026年10月30日")
  assert.equal(first.name, "2026年10月30日")
  assert.deepEqual(list("Meetings/2026年10月30日"), ["2026年10月30日 原始转写.md", "audio", "meeting.json"])
  assert.equal(await store.audioFile("Meetings/2026年10月30日", first.name, 1, "ogg"), "Meetings/2026年10月30日/audio/2026年10月30日 录音 01.ogg")

  const second = meeting("Daily/2026年10月30日.md")
  assert.equal(await store.create(second, "火山引擎"), "Meetings/2026年10月30日 2")
  assert.deepEqual(list("Meetings/2026年10月30日 2"), ["2026年10月30日 2 原始转写.md", "audio", "meeting.json"])
})

test("renaming a meeting moves its folder and named files and leaves the rest", async () => {
  const { store, list, renames, put } = tempVault()
  await store.create(meeting("Daily/2026年10月30日甲公司.md"), "火山引擎")
  const meta = meeting("Daily/2026年10月30日.md")
  const old = await store.create(meta, "火山引擎")
  put(`${old}/audio/2026年10月30日 录音 01.ogg`)
  put(`${old}/2026年10月30日 正式纪要.md`)

  const renamed = await store.renameMeeting(old, "2026年10月30日", "2026年10月30日甲公司")
  assert.deepEqual(renamed, { folder: "Meetings/2026年10月30日甲公司 2", name: "2026年10月30日甲公司 2" })
  assert.deepEqual(list(renamed.folder), [
    "2026年10月30日甲公司 2 原始转写.md",
    "2026年10月30日甲公司 2 正式纪要.md",
    "audio",
    "audio/2026年10月30日甲公司 2 录音 01.ogg",
    "meeting.json",
  ])
  assert.equal(
    movedPath(`${old}/audio/2026年10月30日 录音 01.ogg`, old, renamed.folder, "2026年10月30日", renamed.name),
    "Meetings/2026年10月30日甲公司 2/audio/2026年10月30日甲公司 2 录音 01.ogg",
  )

  const count = renames.length
  assert.deepEqual(await store.renameMeeting(renamed.folder, renamed.name, "2026年10月30日甲公司"), renamed, "a numbered name that is still needed stays")
  assert.equal(renames.length, count)
})

function session(meta: Partial<MeetingMeta>) {
  const calls: string[][] = []
  const env = {
    store: {
      path: (dir: string, name: string) => `${dir}/${name}`,
      saveMeta: async () => undefined,
      renameMeeting: async (dir: string, from: string, base: string) => {
        calls.push([dir, from, base])
        return { folder: `Meetings/${base}`, name: base }
      },
    },
    settings: () => DEFAULT_SETTINGS,
    llm: () => ({ problem: "未配置" }),
    release: () => undefined,
  } as unknown as SessionEnv
  const full = { summaries: [], gaps: [], segments: [], minutes: [], lastCutoffMs: 0, ...meta } as unknown as MeetingMeta
  return { session: new MeetingSession(env, `Meetings/${meta.name ?? "2026-10-30 旧会议"}`, full, ""), calls }
}

test("a renamed note renames its meeting once recording has ended", async () => {
  const { session: s, calls } = session({
    title: "2026年10月30日",
    name: "2026年10月30日",
    notePath: "Daily/2026年10月30日.md",
    status: "paused",
    segments: [{ file: "Meetings/2026年10月30日/audio/2026年10月30日 录音 01.ogg" } as MeetingMeta["segments"][number]],
    minutes: ["Meetings/2026年10月30日/2026年10月30日 正式纪要.md"],
  })
  await s.setNotePath("Daily/2026年10月30日甲公司.md")
  assert.equal(calls.length, 0, "files being recorded into are not renamed")
  assert.equal(s.meta.title, "2026年10月30日甲公司")

  await s.stop()
  await s.saveNow()
  assert.deepEqual(calls, [["Meetings/2026年10月30日", "2026年10月30日", "2026年10月30日甲公司"]])
  assert.equal(s.transcriptPath, "Meetings/2026年10月30日甲公司/2026年10月30日甲公司 原始转写.md")
  assert.equal(s.meta.segments[0].file, "Meetings/2026年10月30日甲公司/audio/2026年10月30日甲公司 录音 01.ogg")
  assert.deepEqual(s.meta.minutes, ["Meetings/2026年10月30日甲公司/2026年10月30日甲公司 正式纪要.md"])
})

test("meetings from before named files and hand-edited titles stay as they are", async () => {
  const { session: s, calls } = session({ title: "投后访谈", notePath: "Daily/2026年10月30日.md", status: "ended" })
  await s.setNotePath("Daily/2026年10月30日乙公司.md")
  assert.equal(calls.length, 0)
  assert.equal(s.meta.title, "投后访谈")
  assert.equal(s.transcriptPath, "Meetings/2026-10-30 旧会议/原始转写.md")
})

test("a new meeting names its raw transcript in the note language and stores the name", async () => {
  const { store, root, list } = tempVault()
  const zh = meeting("Daily/周会.md")
  await store.create(zh, "火山引擎", "zh")
  assert.equal(zh.transcriptFile, "原始转写.md")
  assert.deepEqual(list("Meetings/周会"), ["audio", "meeting.json", "周会 原始转写.md"])

  const en = meeting("Daily/Weekly sync.md")
  const folder = await store.create(en, "Volcengine", "en")
  assert.equal(en.transcriptFile, "Raw transcript.md")
  assert.deepEqual(list(folder), ["Weekly sync Raw transcript.md", "audio", "meeting.json"])
  assert.equal(JSON.parse(readFileSync(join(root, `${folder}/meeting.json`), "utf8")).transcriptFile, "Raw transcript.md")
  assert.equal(transcriptFileName(en), "Weekly sync Raw transcript.md")
})

test("a meeting without a stored transcript name resolves to the Chinese one, as before", () => {
  assert.equal(transcriptFileName({ name: "周会" }), "周会 原始转写.md")
  assert.equal(transcriptFileName({ name: undefined }), "原始转写.md")
  assert.equal(transcriptFileName({ name: "Weekly sync", transcriptFile: "Raw transcript.md" }), "Weekly sync Raw transcript.md")
})

test("the stored transcript name follows the meeting when its note is renamed, and old meetings keep theirs", async () => {
  const { store, list } = tempVault()
  const en = meeting("Daily/Weekly sync.md")
  const folder = await store.create(en, "Volcengine", "en")
  const legacy = meeting("Daily/周会.md")
  delete legacy.transcriptFile
  const old = await store.create(legacy, "火山引擎", "zh")
  assert.deepEqual(await store.renameMeeting(folder, "Weekly sync", "Board sync"), { folder: "Meetings/Board sync", name: "Board sync" })
  assert.deepEqual(list("Meetings/Board sync"), ["Board sync Raw transcript.md", "audio", "meeting.json"])
  assert.deepEqual(await store.renameMeeting(old, "周会", "董事会"), { folder: "Meetings/董事会", name: "董事会" })
  assert.deepEqual(list("Meetings/董事会"), ["audio", "meeting.json", "董事会 原始转写.md"])

  // Through the session: stored name and legacy derivation both land on the renamed file.
  for (const [stored, expected] of [
    ["Raw transcript.md", "Meetings/Board sync/Board sync Raw transcript.md"],
    [undefined, "Meetings/Board sync/Board sync 原始转写.md"],
  ] as const) {
    const { session: s } = session({ title: "Weekly sync", name: "Weekly sync", transcriptFile: stored, notePath: "Daily/Weekly sync.md", status: "paused" })
    await s.setNotePath("Daily/Board sync.md")
    await s.stop()
    assert.equal(s.transcriptPath, expected)
  }
})
