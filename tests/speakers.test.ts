import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import type { AsrConnectionHandlers, AsrUtterance } from "../src/asr/contract.ts"
import { AsrStreamer } from "../src/asr/streamer.ts"
import { labelledText, speakerColor, speakerId, speakerName, SPEAKER_COLORS } from "../src/meeting/speakers.ts"
import { linkTranscript, parseTranscript, utteranceLine } from "../src/meeting/transcriptFormat.ts"
import type { Utterance } from "../src/meeting/types.ts"
import { setLanguage } from "./support/obsidian.ts"

afterEach(() => setLanguage("zh-CN"))

// The pattern 1.0.1 and 1.1.0 read transcript lines with, copied from their releases (commits 4ac8bef and c696ff3, src/meeting/transcriptFormat.ts).
// It is frozen here on purpose: the point is that those versions still accept what this version writes.
const SHIPPED_LINE = new RegExp(String.raw`^(?:\[(\d{2}:\d{2}:\d{2})\]|\[\[[^\]|\n]*\|(\d{2}:\d{2}:\d{2})\]\]) (.*) \^t(\d+)-(\d+)[ \t]*$`)

/** What 1.0.1 and 1.1.0 would make of a line: the text with any label still in front, or undefined when the line is not read. */
function shippedRead(line: string): { text: string; startMs: number; endMs: number } | undefined {
  const m = SHIPPED_LINE.exec(line)
  return m ? { text: m[3], startMs: Number(m[4]), endMs: Number(m[5]) } : undefined
}

const OLD_TRANSCRIPT =
  "---\nmeeting: m-1\n---\n\n> [!info] 由火山引擎实时语音识别生成的原始转写\n\n" +
  "![[Meetings/周会/audio/周会 录音 01.ogg]]\n\n" +
  "[00:00:03] 收入 3 亿，毛利 40% ^t3200-5600\n\n" +
  "[[Daily/周会#^m-1-s1|00:00:09]] 讨论预算 ^t9100-9900\n\n" +
  "[00:00:20] **加粗** 开头但不是说话人 ^t20000-21000\n\n"

test("a transcript written by 1.0.1 parses exactly as before, without speakers", () => {
  assert.deepEqual(parseTranscript(OLD_TRANSCRIPT), [
    { startMs: 3200, endMs: 5600, text: "收入 3 亿，毛利 40%" },
    { startMs: 9100, endMs: 9900, text: "讨论预算" },
    { startMs: 20000, endMs: 21000, text: "**加粗** 开头但不是说话人" },
  ])
})

test("a speaker is written as a language-neutral prefix and read back", () => {
  const line = utteranceLine({ startMs: 3200, endMs: 5600, text: "收入 3 亿", speaker: "2" })
  assert.equal(line, "[00:00:03] **S2** 收入 3 亿 ^t3200-5600\n\n")
  assert.equal(utteranceLine({ startMs: 3200, endMs: 5600, text: "收入 3 亿" }), "[00:00:03] 收入 3 亿 ^t3200-5600\n\n")
  const linked = utteranceLine({ startMs: 9100, endMs: 9900, text: "Budget talk", speaker: "1" }, "Daily/周会")
  assert.equal(linked, "[[Daily/周会|00:00:09]] **S1** Budget talk ^t9100-9900\n\n")
  assert.deepEqual(parseTranscript(line + linked), [
    { startMs: 3200, endMs: 5600, text: "收入 3 亿", speaker: "2" },
    { startMs: 9100, endMs: 9900, text: "Budget talk", speaker: "1" },
  ])
})

test("1.0.1 and 1.1.0 still read a labelled line, with the label as part of the text", () => {
  for (const line of [utteranceLine({ startMs: 3200, endMs: 5600, text: "收入 3 亿", speaker: "2" }), utteranceLine({ startMs: 9100, endMs: 9900, text: "预算", speaker: "1" }, "Daily/周会")]) {
    const read = shippedRead(line.trim())
    assert.ok(read, `not read: ${line}`)
    assert.match(read.text, /^\*\*S\d\*\* \S/)
  }
  assert.deepEqual(shippedRead("[00:00:03] **S2** 收入 3 亿 ^t3200-5600"), { text: "**S2** 收入 3 亿", startMs: 3200, endMs: 5600 })
})

test("linking a transcript to its note keeps the labels", () => {
  const md = utteranceLine({ startMs: 3200, endMs: 5600, text: "收入", speaker: "2" }) + utteranceLine({ startMs: 9100, endMs: 9900, text: "预算" })
  const linked = linkTranscript(md, (ms) => `Daily/周会#^m-1-s${ms}`)
  assert.match(linked, /^\[\[Daily\/周会#\^m-1-s3200\|00:00:03\]\] \*\*S2\*\* 收入 \^t3200-5600$/m)
  assert.deepEqual(parseTranscript(linked).map((u) => u.speaker), ["2", undefined])
})

test("a speaker id that could not be read back is not written", () => {
  assert.equal(speakerId("3"), "3")
  assert.equal(speakerId("A"), "A")
  for (const bad of ["", "**", "a b", "说话人", "toolongid1", undefined]) assert.equal(speakerId(bad), undefined, String(bad))
  assert.equal(utteranceLine({ startMs: 0, endMs: 1, text: "hi", speaker: "a b" }), "[00:00:00] hi ^t0-1\n\n")
})

test("speakers are named in the language asked for", () => {
  assert.equal(speakerName("zh", "1"), "说话人 1")
  assert.equal(speakerName("en", "1"), "Speaker 1")
  assert.equal(labelledText({ text: "收入三亿", speaker: "2" }, "zh"), "说话人 2：收入三亿")
  assert.equal(labelledText({ text: "Revenue", speaker: "2" }, "en"), "Speaker 2: Revenue")
  assert.equal(labelledText({ text: "Revenue" }, "en"), "Revenue")
})

test("a speaker keeps one colour, and speakers cycle through the palette", () => {
  assert.equal(speakerColor("1"), 1)
  assert.equal(speakerColor("2"), 2)
  assert.equal(speakerColor("1"), speakerColor("1"))
  assert.equal(speakerColor(String(SPEAKER_COLORS + 1)), 1)
  assert.equal(speakerColor("0"), 1)
  for (const id of ["A", "B", "7", "12", "zz9"]) assert.ok(speakerColor(id) >= 1 && speakerColor(id) <= SPEAKER_COLORS)
})

// ---------------------------------------------------------------- through the streamer

async function run(feed: (emit: (list: AsrUtterance[], last?: boolean) => void) => void): Promise<Utterance[]> {
  const finals: Utterance[] = []
  let handlers: AsrConnectionHandlers | undefined
  const asr = new AsrStreamer({ onFinal: (u) => finals.push(u), onInterim: () => undefined, onGap: () => undefined, onState: () => undefined }, { manualTicks: true, finalTimeoutMs: 20 })
  asr.begin(0, async (h) => {
    handlers = h
    return { connection: { sendAudio: () => undefined, close: () => undefined } }
  })
  await new Promise((r) => setImmediate(r))
  feed((list, last = false) => handlers!.onResult({ utterances: list }, last))
  asr.dispose()
  return finals
}

test("labelled finals keep their speaker and are deduplicated by start time", async () => {
  const final = (text: string, startMs: number, endMs: number, speaker?: string): AsrUtterance => ({ text, startMs, endMs, final: true, speaker })
  const finals = await run((emit) => {
    emit([final("今年收入三亿。", 100, 900, "1")])
    // The service repeats the earlier final, and may label it differently once it has heard more: the first stands.
    emit([final("今年收入三亿。", 100, 900, "2"), final("毛利四成。", 950, 1800, "2")])
    emit([final("毛利四成。", 950, 1800, "2"), final("好的。", 1900, 2100, "bad id!")])
  })
  assert.deepEqual(finals.map((u) => [u.text, u.speaker]), [["今年收入三亿。", "1"], ["毛利四成。", "2"], ["好的。", undefined]])
})
