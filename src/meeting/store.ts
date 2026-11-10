import { FileSystemAdapter, MarkdownView, TFile, Vault, normalizePath, type App } from "obsidian"
import { t, tr, uiLang, type Lang } from "../i18n/index.ts"
import { replaceFile, tempPath, type ReplaceIo } from "./atomicFile.ts"
import { applyEdit, type TextEdit } from "./noteSummary.ts"
import { transcriptHeader } from "./transcriptFormat.ts"
import type { MeetingMeta } from "./types.ts"

export const META_FILE = "meeting.json"
/**
 * The raw transcript's file name (without the meeting name in front) in meetings created before it was stored in meeting.json,
 * and what a meeting without `transcriptFile` still resolves to. It stays Chinese: the summary links in existing notes point at it,
 * and a downgrade to 1.0.x finds transcripts by it.
 */
export const TRANSCRIPT_FILE = "原始转写.md"
export const AUDIO_DIR = "audio"

export interface IndexEntry {
  folder: string
  meta: MeetingMeta
}

/** Device names Windows reserves, with or without an extension: a file or folder named so cannot be created there. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

function sanitize(name: string): string {
  // Windows drops trailing dots and spaces from file names, so a name ending in one would not match its own files there.
  const clean = name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).replace(/[. ]+$/, "")
  if (!clean) return t("note.meetingFallback")
  return WINDOWS_RESERVED.test(clean) ? `${clean} meeting` : clean
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

/** The raw transcript's file name within a meeting's folder: the stored name, else the legacy one. */
export function transcriptFileName(meta: Pick<MeetingMeta, "name" | "transcriptFile">): string {
  return meetingFile(meta.name, meta.transcriptFile ?? TRANSCRIPT_FILE)
}

export function newMeetingId(): string {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`
  return `m-${stamp}-${Math.random().toString(36).slice(2, 8)}`
}

export class MeetingStore {
  readonly app: App
  private readonly root: () => string
  private readonly io: ReplaceIo | undefined
  private readonly backoffMs: readonly number[] | undefined

  /** `io` and `backoffMs` stand in for the file system calls and waits of saving meeting.json, for tests. */
  constructor(app: App, root: () => string, io?: ReplaceIo, backoffMs?: readonly number[]) {
    this.app = app
    this.root = root
    this.io = io
    this.backoffMs = backoffMs
  }

  private get adapter(): FileSystemAdapter {
    const adapter = this.app.vault.adapter
    if (!(adapter instanceof FileSystemAdapter)) throw new Error(t("store.desktopOnly"))
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
        entries.push({ folder, meta: await this.readMeta(folder) })
      } catch (error) {
        console.error(`[meeting-live] could not read ${metaPath}`, error)
      }
    }
    return entries
  }

  /**
   * Creates the meeting folder; `provider` is the display name, in `lang`, of the live recognizer the transcript header credits.
   * The raw transcript is named in `lang` too, and the name is kept in `meta`, so a later change of language never moves it.
   */
  async create(meta: MeetingMeta, provider: string, lang: Lang = uiLang()): Promise<string> {
    const root = normalizePath(this.root())
    if (!(await this.adapter.exists(root))) await this.adapter.mkdir(root)
    meta.name = await this.freeName(root, noteName(meta.notePath))
    meta.transcriptFile = `${tr(lang, "note.transcriptFile")}.md`
    const folder = this.path(root, meta.name)
    await this.adapter.mkdir(folder)
    await this.adapter.mkdir(this.path(folder, AUDIO_DIR))
    await this.adapter.write(this.path(folder, transcriptFileName(meta)), transcriptHeader(meta, provider, lang))
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
    if (!dir) throw new Error(t("store.noFolder", folder))
    const files: TFile[] = []
    Vault.recurseChildren(dir, (file) => {
      if (file instanceof TFile && file.name.startsWith(`${from} `)) files.push(file)
    })
    for (const file of files) await this.app.fileManager.renameFile(file, this.path(file.parent!.path, name + file.name.slice(from.length)))
    const target = this.path(parent, name)
    await this.app.fileManager.renameFile(dir, target)
    return { folder: target, name }
  }

  /** Replaces meeting.json so a crash mid-write never leaves it truncated, and a busy file on Windows only delays the write (see replaceFile). */
  async saveMeta(folder: string, meta: MeetingMeta): Promise<void> {
    await replaceFile(this.fullPath(this.path(folder, META_FILE)), JSON.stringify(meta, null, 2), this.io, this.backoffMs)
  }

  /** The meeting's metadata; when meeting.json cannot be read, the complete copy a write that was cut short left in meeting.json.tmp. */
  async readMeta(folder: string): Promise<MeetingMeta> {
    const metaPath = this.path(folder, META_FILE)
    try {
      return JSON.parse(await this.adapter.read(metaPath)) as MeetingMeta
    } catch (error) {
      const temp = tempPath(metaPath)
      if (!(await this.adapter.exists(temp))) throw error
      try {
        return JSON.parse(await this.adapter.read(temp)) as MeetingMeta
      } catch {
        throw error
      }
    }
  }

  async readTranscript(path: string): Promise<string> {
    return (await this.adapter.exists(path)) ? this.adapter.read(path) : ""
  }

  async appendTranscript(path: string, text: string): Promise<void> {
    await this.adapter.append(path, text)
  }

  async audioFile(folder: string, name: string | undefined, index: number, format: string, lang: Lang = uiLang()): Promise<string> {
    const dir = this.path(folder, AUDIO_DIR)
    if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir)
    const number = String(index).padStart(2, "0")
    return this.path(dir, `${name ? tr(lang, "note.audioNamed", name, number) : tr(lang, "note.audioBare", number)}.${format}`)
  }

  async exists(path: string): Promise<boolean> {
    return this.adapter.exists(normalizePath(path))
  }

  async uniquePath(folder: string, base: string, ext: string): Promise<string> {
    let candidate = this.path(folder, `${base}.${ext}`)
    for (let n = 2; await this.adapter.exists(candidate); n++) candidate = this.path(folder, `${base} ${n}.${ext}`)
    return candidate
  }

  /**
   * Applies an edit to a note. An open editor takes it as a transaction, so the cursor, scroll
   * and unsaved typing survive; otherwise the file is rewritten atomically.
   */
  async editNote(path: string, edit: (content: string) => TextEdit | undefined): Promise<void> {
    const file = this.app.vault.getFileByPath(normalizePath(path))
    if (!file) return
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view
      if (!(view instanceof MarkdownView) || view.file !== file || view.getMode() !== "source") continue
      const editor = view.editor
      const change = edit(editor.getValue())
      if (change) editor.replaceRange(change.text, editor.offsetToPos(change.from), editor.offsetToPos(change.to))
      return
    }
    // Skip the write when nothing changes, so re-rendering a card never touches the note.
    if (!edit(await this.app.vault.read(file))) return
    await this.app.vault.process(file, (content) => {
      const change = edit(content)
      return change ? applyEdit(content, change) : content
    })
  }

  /** A note's text as Obsidian has it cached; empty when there is no such note. */
  async readNote(path: string): Promise<string> {
    const file = this.app.vault.getFileByPath(normalizePath(path))
    return file ? this.app.vault.cachedRead(file) : ""
  }

  /** Calls `listener` with the path of every note that is modified; the returned function stops it. */
  onNoteModified(listener: (path: string) => void): () => void {
    const ref = this.app.vault.on("modify", (file) => listener(file.path))
    return () => this.app.vault.offref(ref)
  }

  async write(path: string, content: string): Promise<void> {
    await this.adapter.write(normalizePath(path), content)
  }
}
