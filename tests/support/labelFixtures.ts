// A meeting with every kind of written label in it, for tests of what the plugin writes into notes and files.
import { applyEdit } from "../../src/meeting/noteSummary.ts"
import { MeetingSession, type SessionEnv } from "../../src/meeting/session.ts"
import type { MeetingMeta, SummaryRecord } from "../../src/meeting/types.ts"
import { DEFAULT_SETTINGS, type MeetingLiveSettings } from "../../src/settings.ts"

export const TRANSCRIPT =
  "[00:00:03] 收入 3 亿，毛利 40% ^t3200-5600\n\n" + "[00:00:09] 讨论预算 ^t9100-9900\n\n" + "[00:00:20] 渠道进展 ^t20000-21000\n\n"

export const stage = (index: number, partial: Partial<SummaryRecord>): SummaryRecord => ({ index, startMs: 0, endMs: 30_000, trigger: "auto", status: "done", attempts: 1, utterances: [3200, 9100], ...partial })

export function meetingMeta(): MeetingMeta {
  return {
    version: 1,
    id: "m-20261027-abc123",
    title: "周会",
    name: "周会",
    notePath: "Daily/周会.md",
    createdAt: "2026-10-27T14:30:00+08:00",
    updatedAt: "2026-10-27T14:40:00.000Z",
    status: "ended",
    segments: [],
    gaps: [],
    summaries: [
      stage(1, {
        content: {
          title: "",
          paragraphs: [{ topic: "预算", text: "收入 3 亿，毛利 40%。", t: 3200, unverified: ["40"] }],
          todos: [{ text: "交方案 ¥500万", t: 9100, unverified: ["500"] }, { text: "补数据", t: 9100, unverified: [] }],
          open: [{ text: "是否扩招", t: 3200, unverified: [] }],
        },
      }),
      stage(2, { content: { title: "", paragraphs: [], todos: [], open: [] } }),
      stage(3, { utterances: [20000], content: undefined, raw: "模型原文" }),
      stage(4, { utterances: [20000], content: { title: "渠道", paragraphs: [{ topic: "", text: "渠道进展顺利。", t: 20000, unverified: [] }], todos: [], open: [] } }),
    ],
    overview: {
      stages: [1, 2, 3, 4],
      content: { title: "", paragraphs: [{ topic: "预算", text: "收入 3 亿，毛利 40%。", t: 3200, unverified: ["40"] }], todos: [{ text: "交方案 ¥500万", t: 9100, unverified: ["500"] }], open: [] },
    },
    lastCutoffMs: 30_000,
    asrLogIds: [],
    minutes: [],
  }
}

export interface FakeEnv {
  env: SessionEnv
  written: Record<string, string>
  llmCalls: { count: number }
}

/** A session over in-memory files; `settings` overrides the defaults and `consented` answers the model-consent check. */
export function fakeSession(options: { settings?: Partial<MeetingLiveSettings>; meta?: MeetingMeta; transcript?: string; consented?: boolean; note?: string; complete?: () => Promise<string> } = {}) {
  const written: Record<string, string> = {}
  /** The meeting's note, which summary edits are applied to. */
  const note = { text: options.note ?? "# 周会\n\n```meeting-live\nid: m-20261027-abc123\n```\n" }
  const llmCalls = { count: 0 }
  const settings = { ...DEFAULT_SETTINGS, ...options.settings }
  const env = {
    store: {
      path: (folder: string, name: string) => `${folder}/${name}`,
      saveMeta: async () => undefined,
      appendTranscript: async () => undefined,
      readTranscript: async () => options.transcript ?? TRANSCRIPT,
      write: async (path: string, text: string) => void (written[path] = text),
      uniquePath: async (folder: string, base: string, ext: string) => `${folder}/${base}.${ext}`,
      editNote: async (_path: string, edit: (content: string) => { from: number; to: number; text: string } | undefined) => {
        const change = edit(note.text)
        if (change) note.text = applyEdit(note.text, change)
      },
      renameMeeting: async (folder: string, from: string) => ({ folder, name: from }),
    },
    settings: () => settings,
    asr: () => ({ id: "volc", name: "火山引擎", connect: null }),
    llm: () => ({
      problem: undefined,
      model: "deepseek-flash",
      target: "api.deepseek.com",
      inputLimit: 1_000_000,
      complete: async () => {
        llmCalls.count++
        return options.complete ? options.complete() : "正文"
      },
    }),
    claim: () => undefined,
    release: () => undefined,
    llmConsented: () => options.consented ?? true,
  } as unknown as SessionEnv
  const session = new MeetingSession(env, "Meetings/周会", options.meta ?? meetingMeta(), options.transcript ?? TRANSCRIPT)
  return { session, env, written, llmCalls, note, settings }
}
