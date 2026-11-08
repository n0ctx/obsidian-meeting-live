import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { FileSystemAdapter } from "obsidian"
import { replaceFile, type ReplaceIo } from "../src/meeting/atomicFile.ts"
import { MeetingStore } from "../src/meeting/store.ts"
import type { MeetingMeta } from "../src/meeting/types.ts"

const errno = (code: string) => Object.assign(new Error(`${code}: operation not permitted`), { code })

/** The real file system, with the first `renameFailures` renames and `writeFailures` writes to the target refused as Windows does a busy file. */
function flaky(options: { renameFailures?: number; code?: string; writeFailures?: number }) {
  let renames = 0
  let targetWrites = 0
  const io: ReplaceIo = {
    writeFile: async (path, data) => {
      if (!path.endsWith(".tmp") && targetWrites++ < (options.writeFailures ?? 0)) throw errno("EBUSY")
      await fs.writeFile(path, data, "utf8")
    },
    rename: async (from, to) => {
      if (renames++ < (options.renameFailures ?? 0)) throw errno(options.code ?? "EPERM")
      await fs.rename(from, to)
    },
    unlink: (path) => fs.unlink(path),
  }
  return { io, renames: () => renames }
}

function target(initial = "old") {
  const dir = mkdtempSync(join(tmpdir(), "meeting-live-atomic-"))
  const path = join(dir, "meeting.json")
  writeFileSync(path, initial)
  return path
}

const NO_WAIT = [0, 0, 0, 0]

test("a rename refused as busy is retried until it goes through, leaving no temporary file", async () => {
  for (const code of ["EPERM", "EBUSY", "EACCES"]) {
    const path = target()
    const { io, renames } = flaky({ renameFailures: 3, code })
    await replaceFile(path, "new", io, NO_WAIT)
    assert.equal(renames(), 4, code)
    assert.equal(readFileSync(path, "utf8"), "new")
    assert.equal(existsSync(`${path}.tmp`), false)
  }
})

test("a target that stays busy is overwritten in place, and the old content is never missing in between", async () => {
  const path = target()
  const { io, renames } = flaky({ renameFailures: 99 })
  await replaceFile(path, "new", io, NO_WAIT)
  assert.equal(renames(), NO_WAIT.length + 1, "the retries are bounded")
  assert.equal(readFileSync(path, "utf8"), "new")
  assert.equal(existsSync(`${path}.tmp`), false)
})

test("when even the overwrite is refused the old file is untouched and the complete new one waits in the temporary file", async () => {
  const path = target()
  const { io } = flaky({ renameFailures: 99, writeFailures: 99 })
  await assert.rejects(replaceFile(path, "new", io, NO_WAIT), { code: "EBUSY" })
  assert.equal(readFileSync(path, "utf8"), "old")
  assert.equal(readFileSync(`${path}.tmp`, "utf8"), "new")
})

test("an error that is not a busy file is not retried", async () => {
  const path = target()
  const { io, renames } = flaky({ renameFailures: 99, code: "ENOSPC" })
  await assert.rejects(replaceFile(path, "new", io, NO_WAIT), { code: "ENOSPC" })
  assert.equal(renames(), 1)
  assert.equal(readFileSync(path, "utf8"), "old")
})

test("replacing without a fake works on the real file system", async () => {
  const path = target()
  await replaceFile(path, "new")
  assert.equal(readFileSync(path, "utf8"), "new")
})

/** A store whose adapter reads real files and whose saves go through `io`. */
function store(dir: string, io?: ReplaceIo) {
  const adapter = Object.assign(Object.create(FileSystemAdapter.prototype), {
    exists: async (path: string) => existsSync(join(dir, path)),
    read: async (path: string) => readFileSync(join(dir, path), "utf8"),
    getFullPath: (path: string) => join(dir, path),
  })
  return new MeetingStore({ vault: { adapter } } as never, () => "Meetings", io, NO_WAIT)
}

test("saveMeta goes through the busy-file retry and meeting.json reads back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meeting-live-meta-"))
  await fs.mkdir(join(dir, "Meetings/周会"), { recursive: true })
  const { io, renames } = flaky({ renameFailures: 2 })
  const s = store(dir, io)
  await s.saveMeta("Meetings/周会", { id: "m-1", title: "周会" } as MeetingMeta)
  assert.equal(renames(), 3)
  assert.equal((await s.readMeta("Meetings/周会")).title, "周会")
})

test("a meeting.json cut short by a failed in-place overwrite is read from the complete temporary copy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meeting-live-meta-"))
  await fs.mkdir(join(dir, "Meetings/周会"), { recursive: true })
  const s = store(dir)
  writeFileSync(join(dir, "Meetings/周会/meeting.json"), '{"id": "m-1", "tit')
  writeFileSync(join(dir, "Meetings/周会/meeting.json.tmp"), JSON.stringify({ id: "m-1", title: "周会" }))
  assert.equal((await s.readMeta("Meetings/周会")).title, "周会")

  writeFileSync(join(dir, "Meetings/周会/meeting.json.tmp"), '{"id"')
  await assert.rejects(s.readMeta("Meetings/周会"), SyntaxError, "with no usable copy the original error is reported")
})
