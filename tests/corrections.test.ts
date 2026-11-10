import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { applyCorrections, correctionTables, parseCorrections } from "../src/asr/corrections.ts"
import type { AsrContext } from "../src/asr/context.ts"
import type { AsrConnect, AsrUtterance } from "../src/asr/contract.ts"
import type { ResolvedLive } from "../src/asr/providers/registry.ts"
import { AudioCapture } from "../src/audio/capture.ts"
import { SegmentRecorder } from "../src/audio/recorder.ts"
import { MeetingSession, type SessionEnv } from "../src/meeting/session.ts"
import { linkTranscript, parseTranscript, retextTranscript, utteranceLine } from "../src/meeting/transcriptFormat.ts"
import type { MeetingMeta } from "../src/meeting/types.ts"
import { DEFAULT_SETTINGS } from "../src/settings.ts"

test("the settings' table goes before the note's pairs, and longer words before the shorter ones inside them", () => {
  const tables = correctionTables("兰箭→蓝箭\n兰箭航天 -> 蓝箭航天\n不是一对\n", parseCorrections("蓝箭→青箭"))
  assert.deepEqual(tables, [
    [{ from: "兰箭航天", to: "蓝箭航天" }, { from: "兰箭", to: "蓝箭" }],
    [{ from: "蓝箭", to: "青箭" }],
  ])
  // The note's pair sees what the settings' table made of the text.
  assert.equal(applyCorrections("兰箭", tables), "青箭")
  assert.equal(applyCorrections("兰箭航天和兰箭", correctionTables("兰箭→蓝箭\n兰箭航天 -> 青柠航天", [])), "青柠航天和蓝箭")
})

test("a word already in its corrected form is left alone, so running a table again changes nothing", () => {
  const tables = correctionTables("蓝箭→蓝箭科技", [])
  assert.equal(applyCorrections("蓝箭说，蓝箭科技", tables), "蓝箭科技说，蓝箭科技")
  assert.equal(applyCorrections(applyCorrections("蓝箭说", tables), tables), "蓝箭科技说")
})

test("numbers change only where the table says so", () => {
  const tables = correctionTables("二亿→2亿", [])
  assert.equal(applyCorrections("去年收入二亿，今年三亿", tables), "去年收入2亿，今年三亿")
  assert.equal(applyCorrections("估值 12 亿", correctionTables("兰箭→蓝箭", [])), "估值 12 亿")
})

test("sides with full stops, commas or link brackets, or longer than 12, are not pairs", () => {
  assert.deepEqual(parseCorrections("a。→b\na→b，c\n[[兰箭→蓝箭]]\n一二三四五六七八九十一二三→短\n同→同\n- 甲 -> 乙"), [{ from: "甲", to: "乙" }])
})

test("rewriting a line changes its text only: the time link back to the summary, the speaker and the block id stay", () => {
  const u = { startMs: 8000, endMs: 9500, text: "兰箭的进展", speaker: "2" }
  const linked = linkTranscript(utteranceLine(u, "访谈") + utteranceLine({ startMs: 10000, endMs: 11000, text: "兰箭以外" }, "访谈"), (ms) => (ms === 8000 ? "访谈#^m-1-s1" : "访谈"))
  const next = retextTranscript(linked, new Map([["t8000-9500", "蓝箭的进展"]]))
  assert.equal(next.split("\n")[0], "[[访谈#^m-1-s1|00:00:08]] **S2** 蓝箭的进展 ^t8000-9500")
  assert.equal(next.split("\n")[2], linked.split("\n")[2], "a line not named is not touched")
  assert.deepEqual(parseTranscript(next).map((x) => x.text), ["蓝箭的进展", "兰箭以外"])
})

/** A live session over in-memory files whose note text the test controls. */
function liveSession(t: TestContext, note: { text: string }, settings = DEFAULT_SETTINGS) {
  t.mock.method(AudioCapture, "open", async () => ({ sampleRate: 16000, channels: 1, deviceLabel: "测试麦克风", close: async () => undefined }))
  t.mock.method(SegmentRecorder, "create", async () => ({ write: () => undefined, close: async () => undefined }))
  const files: Record<string, string> = {}
  let emit: (utterances: AsrUtterance[]) => void = () => undefined
  const connect: AsrConnect = async (handlers) => {
    emit = (utterances) => handlers.onResult({ utterances }, false)
    return { connection: { sendAudio: (_pcm, last) => last && handlers.onResult({ utterances: [] }, true), close: () => undefined } }
  }
  const watchers: ((path: string) => void)[] = []
  const contexts: (AsrContext | undefined)[] = []
  const consent = { asked: 0, answer: true }
  const env = {
    store: {
      path: (folder: string, name: string) => `${folder}/${name}`,
      audioFile: async (folder: string, _name: string | undefined, n: number, format: string) => `${folder}/audio/${n}.${format}`,
      fullPath: (path: string) => `/vault/${path}`,
      appendTranscript: async (path: string, text: string) => void (files[path] = (files[path] ?? "") + text),
      readTranscript: async (path: string) => files[path] ?? "",
      write: async (path: string, text: string) => void (files[path] = text),
      saveMeta: async () => undefined,
      readNote: async () => note.text,
      onNoteModified: (listener: (path: string) => void) => (watchers.push(listener), () => watchers.splice(watchers.indexOf(listener), 1)),
    },
    settings: () => ({ ...settings, audioFormat: "wav" as const }),
    asr: (context?: () => AsrContext | undefined): ResolvedLive => {
      contexts.push(context?.())
      return { id: "volc", name: "火山引擎", connect, pacing: { maxRate: 6 } }
    },
    asrContextConsent: async () => (consent.asked++, consent.answer),
    llmConsented: () => true,
    llm: () => ({ problem: "未配置", model: "", target: "", complete: async () => "" }),
    claim: () => undefined,
    release: () => undefined,
  } as unknown as SessionEnv
  const meta = { id: "m-1", title: "青柠科技", notePath: "青柠科技.md", createdAt: "2026-11-09T14:30:00+08:00", summaries: [], gaps: [], segments: [], lastCutoffMs: 0, asrLogIds: [] } as unknown as MeetingMeta
  const session = new MeetingSession(env, "m", meta, "")
  return { session, files, emit: (u: AsrUtterance[]) => emit(u), watchers, contexts, consent }
}

const settle = () => new Promise((r) => setImmediate(r))

test("a final is corrected before it is kept, so the transcript and what the summaries read have the right word", async (t) => {
  const note = { text: "兰箭→蓝箭\n" }
  const live = liveSession(t, note, { ...DEFAULT_SETTINGS, corrections: "甲木→甲沐" })
  await live.session.start()
  await settle()
  live.emit([{ text: "兰箭和甲木都在", startMs: 0, endMs: 900, final: true }])
  assert.equal(live.session.utterances[0].text, "蓝箭和甲沐都在")
  await live.session.stop()
  assert.match(Object.values(live.files).join(""), /蓝箭和甲沐都在 \^t0-900/)
  assert.doesNotMatch(Object.values(live.files).join(""), /兰箭/)
})

test("a pair written into the note during the meeting corrects what was already written, once the typing settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const note = { text: "# 青柠科技\n" }
  const live = liveSession(t, note)
  await live.session.start()
  await settle()
  live.emit([{ text: "兰箭说产能紧", startMs: 0, endMs: 900, final: true }])
  await settle()
  note.text += "兰箭→蓝箭\n"
  live.watchers.forEach((w) => w("青柠科技.md"))
  live.watchers.forEach((w) => w("别的笔记.md"))
  t.mock.timers.tick(1500)
  for (let i = 0; i < 5; i++) await settle()
  assert.equal(live.session.utterances[0].text, "蓝箭说产能紧")
  const file = Object.entries(live.files).find(([path]) => !path.endsWith("meeting.json"))![1]
  assert.match(file, /蓝箭说产能紧 \^t0-900/)
  assert.doesNotMatch(file, /兰箭/)
  await live.session.stop()
  assert.equal(live.watchers.length, 0, "a meeting that has ended stops watching its note")
})

test("the note's names go to the recognizer only once the user agreed; declined, the meeting records with the typed hotwords", async (t) => {
  const note = { text: "参会：[[孟星澜]]\n" }
  const settings = { ...DEFAULT_SETTINGS, hotwords: "甲乙资本" }
  const declined = liveSession(t, note, settings)
  declined.consent.answer = false
  await declined.session.start()
  assert.equal(declined.session.status, "recording")
  assert.deepEqual(declined.contexts, [{ hotwords: ["甲乙资本"] }])
  await declined.session.stop()

  const agreed = liveSession(t, note, settings)
  await agreed.session.start()
  assert.deepEqual(agreed.contexts, [{ hotwords: ["甲乙资本", "青柠科技", "孟星澜"] }])
  await agreed.session.stop()

  // With nothing beyond the typed hotwords there is nothing to ask about.
  const plain = liveSession(t, { text: "" }, { ...settings, hotwords: "青柠科技" })
  await plain.session.start()
  assert.equal(plain.consent.asked, 0)
  assert.deepEqual(plain.contexts, [{ hotwords: ["青柠科技"] }])
  await plain.session.stop()
})
