import { promises as nodeFs } from "node:fs"

/** The file system calls a replace makes, so a test can make them fail. */
export interface ReplaceIo {
  writeFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}

const NODE_IO: ReplaceIo = {
  writeFile: (path, data) => nodeFs.writeFile(path, data, "utf8"),
  rename: (from, to) => nodeFs.rename(from, to),
  unlink: (path) => nodeFs.unlink(path),
}

/**
 * Windows refuses to rename over a file another process has open (antivirus, a sync client, an indexer) with one of these,
 * usually for a moment only.
 */
const BUSY_CODES = new Set(["EPERM", "EBUSY", "EACCES"])

/** Waits between the attempts to rename; about 0.8 s in all, short enough not to hold up the session's write queue. */
const RENAME_BACKOFF_MS = [20, 40, 80, 160, 240, 240]

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

/**
 * Replaces `target` with `data` without a moment in which it is missing or cut short.
 *
 * The data goes to `<target>.tmp` first and is renamed over the target, retrying while the system reports the target busy.
 * If it stays busy the target is overwritten in place instead, and the temporary file is kept until that succeeds: whatever
 * happens, a complete copy is either the target or `<target>.tmp`, which readers fall back to. If both fail, the error is
 * thrown and the old target is untouched, since an open that is refused truncates nothing.
 */
export async function replaceFile(target: string, data: string, io: ReplaceIo = NODE_IO, backoffMs: readonly number[] = RENAME_BACKOFF_MS): Promise<void> {
  const temp = tempPath(target)
  await io.writeFile(temp, data)
  for (let attempt = 0; ; attempt++) {
    try {
      await io.rename(temp, target)
      return
    } catch (error) {
      if (!BUSY_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error
      if (attempt >= backoffMs.length) break
      await sleep(backoffMs[attempt])
    }
  }
  await io.writeFile(target, data)
  await io.unlink(temp).catch(() => undefined)
}

export const tempPath = (target: string) => `${target}.tmp`
