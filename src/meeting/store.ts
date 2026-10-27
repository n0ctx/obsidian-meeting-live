import { promises as fs } from "node:fs"
import { FileSystemAdapter, normalizePath, type App } from "obsidian"
import { transcriptHeader } from "./transcriptFormat.ts"
import type { MeetingMeta } from "./types.ts"

export const META_FILE = "meeting.json"
export const TRANSCRIPT_FILE = "原始转写.md"
export const SUMMARY_FILE = "AI 阶段摘要.md"
export const AUDIO_DIR = "audio"

export interface IndexEntry {
  folder: string
  meta: MeetingMeta
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "会议"
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
    const date = meta.createdAt.slice(0, 10)
    let folder = normalizePath(`${root}/${date} ${sanitize(meta.title)}`)
    if (await this.adapter.exists(folder)) folder = `${folder} ${meta.id.slice(-6)}`
    await this.adapter.mkdir(folder)
    await this.adapter.mkdir(this.path(folder, AUDIO_DIR))
    await this.adapter.write(this.path(folder, TRANSCRIPT_FILE), transcriptHeader(meta.id, meta.title, meta.notePath))
    await this.saveMeta(folder, meta)
    return folder
  }

  /** Atomic replace so a crash mid-write never leaves a truncated meeting.json. */
  async saveMeta(folder: string, meta: MeetingMeta): Promise<void> {
    const target = this.fullPath(this.path(folder, META_FILE))
    const temp = `${target}.tmp`
    await fs.writeFile(temp, JSON.stringify(meta, null, 2), "utf8")
    await fs.rename(temp, target)
  }

  async readTranscript(folder: string): Promise<string> {
    const path = this.path(folder, TRANSCRIPT_FILE)
    return (await this.adapter.exists(path)) ? this.adapter.read(path) : ""
  }

  async appendTranscript(folder: string, text: string): Promise<void> {
    await this.adapter.append(this.path(folder, TRANSCRIPT_FILE), text)
  }

  async writeSummaries(folder: string, markdown: string): Promise<void> {
    await this.adapter.write(this.path(folder, SUMMARY_FILE), markdown)
  }

  async audioFile(folder: string, index: number, format: string): Promise<string> {
    const dir = this.path(folder, AUDIO_DIR)
    if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir)
    return this.path(dir, `录音-${String(index).padStart(2, "0")}.${format}`)
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
