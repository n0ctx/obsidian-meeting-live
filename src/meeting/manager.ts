import { Events } from "obsidian"
import { upgradeSummaries } from "../llm/summary.ts"
import { MeetingSession, type SessionEnv } from "./session.ts"
import { TRANSCRIPT_FILE, meetingFile, newMeetingId, type MeetingStore } from "./store.ts"
import { localTimestamp, type MeetingMeta } from "./types.ts"

/** Owns every meeting runtime for the lifetime of the plugin, independent of rendered views. */
export class MeetingManager extends Events {
  private readonly store: MeetingStore
  private readonly env: Omit<SessionEnv, "store" | "claim" | "release">
  private readonly folders = new Map<string, { folder: string; notePath: string }>()
  private readonly sessions = new Map<string, MeetingSession>()
  private readonly loading = new Map<string, Promise<MeetingSession | undefined>>()
  private ready: Promise<void> | undefined
  active: MeetingSession | undefined

  constructor(store: MeetingStore, env: Omit<SessionEnv, "store" | "claim" | "release">) {
    super()
    this.store = store
    this.env = env
  }

  /** Indexes meeting folders and repairs meetings interrupted by a crash or quit. */
  load(): Promise<void> {
    this.ready ??= (async () => {
      for (const { folder, meta } of await this.store.scan()) {
        // Loaded sessions own their files; never "recover" a meeting that is live in memory.
        if (this.sessions.has(meta.id)) continue
        if (await MeetingSession.recover(this.store, meta)) await this.store.saveMeta(folder, meta)
        this.folders.set(meta.id, { folder, notePath: meta.notePath })
      }
    })()
    return this.ready
  }

  reindex(): Promise<void> {
    this.ready = undefined
    return this.load()
  }

  private sessionEnv(): SessionEnv {
    return {
      ...this.env,
      store: this.store,
      claim: (session) => {
        if (this.active && this.active !== session) return `「${this.active.meta.title}」正在录音，请先结束该会议`
        this.active = session
        this.trigger("active")
        return undefined
      },
      release: (session) => {
        if (this.active !== session) return
        this.active = undefined
        this.trigger("active")
      },
    }
  }

  loaded(id: string): MeetingSession | undefined {
    return this.sessions.get(id)
  }

  fullPath(path: string): string {
    return this.store.fullPath(path)
  }

  async get(id: string): Promise<MeetingSession | undefined> {
    const existing = this.sessions.get(id)
    if (existing) return existing
    const pending = this.loading.get(id)
    if (pending) return pending
    const task = (async () => {
      await this.load()
      if (!this.folders.has(id)) await this.reindex()
      const entry = this.folders.get(id)
      if (!entry) return undefined
      const metaText = await this.store.app.vault.adapter.read(this.store.path(entry.folder, "meeting.json"))
      const meta = JSON.parse(metaText) as MeetingMeta
      upgradeSummaries(meta)
      const transcript = await this.store.readTranscript(this.store.path(entry.folder, meetingFile(meta.name, TRANSCRIPT_FILE)))
      const session = new MeetingSession(this.sessionEnv(), entry.folder, meta, transcript)
      session.on("change", () => this.trigger("session-change", session))
      this.sessions.set(id, session)
      if (meta.summaries.some((s) => s.status === "pending")) void session.runQueue()
      return session
    })()
    this.loading.set(id, task)
    try {
      return await task
    } finally {
      this.loading.delete(id)
    }
  }

  async create(title: string, notePath: string): Promise<MeetingSession> {
    await this.load()
    const now = new Date()
    const meta: MeetingMeta = {
      version: 1,
      id: newMeetingId(),
      title,
      notePath,
      createdAt: localTimestamp(now),
      updatedAt: now.toISOString(),
      status: "idle",
      segments: [],
      gaps: [],
      summaries: [],
      lastCutoffMs: 0,
      asrLogIds: [],
      minutes: [],
    }
    const folder = await this.store.create(meta)
    this.folders.set(meta.id, { folder, notePath })
    const session = await this.get(meta.id)
    if (!session) throw new Error("会议创建失败")
    return session
  }

  async handleRename(oldPath: string, newPath: string): Promise<void> {
    await this.load()
    for (const [id, entry] of this.folders) {
      if (entry.notePath !== oldPath) continue
      entry.notePath = newPath
      const session = await this.get(id)
      await session?.setNotePath(newPath)
    }
  }

  /** Ends the live meeting once its block is gone from its note: no card is left to stop it, and it would block every other meeting. */
  async endIfDetached(path: string): Promise<MeetingSession | undefined> {
    const session = this.active
    if (!session || session.meta.notePath !== path || session.status === "stopping") return undefined
    const adapter = this.store.app.vault.adapter
    const content = (await adapter.exists(path)) ? await adapter.read(path) : ""
    if (this.active !== session || new RegExp(`^\\s*id\\s*:\\s*${session.id}\\s*$`, "m").test(content)) return undefined
    await session.stop()
    return session
  }

  shutdown(): void {
    for (const session of this.sessions.values()) session.shutdown()
  }
}
