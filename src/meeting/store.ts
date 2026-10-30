import { promises as fs } from "node:fs"
import { FileSystemAdapter, TFile, Vault, normalizePath, type App } from "obsidian"
import { transcriptHeader } from "./transcriptFormat.ts"
import type { MeetingMeta } from "./types.ts"

export const META_FILE = "meeting.json"
export const TRANSCRIPT_FILE = "原始转写.md"
export const SUMMARY_FILE = "AI 阶段摘要.md"
export const MINUTES_FILE = "正式纪要"
export const AUDIO_DIR = "audio"

export interface IndexEntry {
  folder: string
  meta: MeetingMeta
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "会议"
}

/** The name a meeting takes from its note. */
export function noteName(notePath: string): string {
  return sanitize(notePath.split("/").pop()!.replace(/\.md$/, ""))
}

/** Files are named "<meeting name> <role>"; meetings without a name use the bare role. */
export function meetingFile(name: string | undefined, role: string): string {
  return name ? `${name} ${role}` : role
}

/** Where a file of a meeting folder ends up once the meeting is renamed from one name to another. */
export function movedPath(path: string, folder: string, target: string, from: string, to: string): string {
  const slash = path.lastIndexOf("/")
  const file = path.slice(slash + 1)
  return `${target}${path.slice(folder.length, slash)}/${file.startsWith(`${from} `) ? to + file.slice(from.length) : file}`
}

export function newMeetingId(): string {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`
  return `m-${stamp}-${Math.random().toString(36).slice(2, 8)}`
}

export class MeetingStore {
  readonly app: App
  private readonly root: () => string

  constructor(app: App, root: () => string) {
    this.app = app
    this.root = root
  }

  private get adapter(): FileSystemAdapter {
    const adapter = this.app.vault.adapter
    if (!(adapter instanceof FileSystemAdapter)) throw new Error("Meeting Live 需要桌面版 Obsidian")
    return adapter
  }

  fullPath(path: string): string {
    return this.adapter.getFullPath(normalizePath(path))
  }

  resourceUrl(path: string): string {
    return this.adapter.getResourcePath(normalizePath(path))
  }

  path(folder: string, file: string): string {
    return normalizePath(`${folder}/${file}`)
  }

  async scan(): Promise<IndexEntry[]> {
    const root = normalizePath(this.root())
    if (!(await this.adapter.exists(root))) return []
    const listing = await this.adapter.list(root)
    const entries: IndexEntry[] = []
    for (const folder of listing.folders) {
      const metaPath = this.path(folder, META_FILE)
      if (!(await this.adapter.exists(metaPath))) continue
      try {
        entries.push({ folder, meta: JSON.parse(await this.adapter.read(metaPath)) as MeetingMeta })
      } catch (error) {
        console.error(`[meeting-live] 无法读取 ${metaPath}`, error)
      }
    }
    return entries
  }

  async create(meta: MeetingMeta): Promise<string> {
    const root = normalizePath(this.root())
    if (!(await this.adapter.exists(root))) await this.adapter.mkdir(root)
    meta.name = await this.freeName(root, noteName(meta.notePath))
    const folder = this.path(root, meta.name)
    await this.adapter.mkdir(folder)
    await this.adapter.mkdir(this.path(folder, AUDIO_DIR))
    await this.adapter.write(this.path(folder, meetingFile(meta.name, TRANSCRIPT_FILE)), transcriptHeader(meta))
    await this.saveMeta(folder, meta)
    return folder
  }

  /** First of "<base>", "<base> 2", … not taken by another folder in parent. */
  private async freeName(parent: string, base: string, current?: string): Promise<string> {
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base} ${n}`
      if (name === current || !(await this.adapter.exists(this.path(parent, name)))) return name
    }
  }

  /**
   * Renames a meeting folder and its "<from> …" files after base, through Obsidian so links to them follow.
   * Returns the folder and name unchanged when the name already fits.
   */
  async renameMeeting(folder: string, from: string, base: string): Promise<{ folder: string; name: string }> {
    const parent = folder.slice(0, folder.lastIndexOf("/"))
    const name = await this.freeName(parent, base, from)
    if (name === from) return { folder, name }
    const dir = this.app.vault.getFolderByPath(folder)
    if (!dir) throw new Error(`找不到会议文件夹「${folder}」`)
    const files: TFile[] = []
    Vault.recurseChildren(dir, (file) => {
      if (file instanceof TFile && file.name.startsWith(`${from} `)) files.push(file)
    })
    for (const file of files) await this.app.fileManager.renameFile(file, this.path(file.parent!.path, name + file.name.slice(from.length)))
    const target = this.path(parent, name)
    await this.app.fileManager.renameFile(dir, target)
    return { folder: target, name }
  }

  /** Atomic replace so a crash mid-write never leaves a truncated meeting.json. */
  async saveMeta(folder: string, meta: MeetingMeta): Promise<void> {
    const target = this.fullPath(this.path(folder, META_FILE))
    const temp = `${target}.tmp`
    await fs.writeFile(temp, JSON.stringify(meta, null, 2), "utf8")
    await fs.rename(temp, target)
  }

  async readTranscript(path: string): Promise<string> {
    return (await this.adapter.exists(path)) ? this.adapter.read(path) : ""
  }

  async appendTranscript(path: string, text: string): Promise<void> {
    await this.adapter.append(path, text)
  }

  async audioFile(folder: string, name: string | undefined, index: number, format: string): Promise<string> {
    const dir = this.path(folder, AUDIO_DIR)
    if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir)
    const number = String(index).padStart(2, "0")
    return this.path(dir, `${name ? `${name} 录音 ${number}` : `录音-${number}`}.${format}`)
  }

  async exists(path: string): Promise<boolean> {
    return this.adapter.exists(normalizePath(path))
  }

  async uniquePath(folder: string, base: string, ext: string): Promise<string> {
    let candidate = this.path(folder, `${base}.${ext}`)
    for (let n = 2; await this.adapter.exists(candidate); n++) candidate = this.path(folder, `${base} ${n}.${ext}`)
    return candidate
  }

  async write(path: string, content: string): Promise<void> {
    await this.adapter.write(normalizePath(path), content)
  }
}
