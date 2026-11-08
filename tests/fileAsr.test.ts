import assert from "node:assert/strict"
import { test } from "node:test"
import { assertCoverage, groupBySpeaker, renderInterviewRecord, speakerUtterances, transcribeFile, type FileAsrPost, type FileAsrProvider, type FileAsrResult } from "../src/asr/fileAsr.ts"
import { buildMinutesMessages } from "../src/llm/minutes.ts"
import { prepareAudio } from "../src/audio/transcode.ts"

const result: FileAsrResult = {
  durationMs: 20_000,
  text: "全文",
  utterances: [
    { text: "您好，先介绍一下公司。", startMs: 0, endMs: 3000, speaker: "1" },
    { text: "我们成立于2019年。", startMs: 3200, endMs: 6000, speaker: "2" },
    { text: "去年收入2亿。", startMs: 6100, endMs: 9000, speaker: "2" },
    { text: "毛利多少？", startMs: 9500, endMs: 11000, speaker: "1" },
    { text: "四成左右。", startMs: 30_000, endMs: 32_000, speaker: "2" },
  ],
}
const single = (utterances: FileAsrResult["utterances"], durationMs = 5000): FileAsrResult => ({ durationMs, text: "t", utterances })

/** A provider that uploads multipart form data, the way an /audio/transcriptions style service needs. */
function multipartProvider(seen: { body?: string | ArrayBuffer; headers?: Record<string, string> }): FileAsrProvider {
  return {
    id: "fake",
    name: "示例",
    host: "api.example.com",
    model: "m",
    capabilities: { hotwords: false, endWindow: false, diarization: false, fileSizeLimit: 1024 },
    directFormats: { mp3: "mp3" },
    transcribe: async (audio, call) => {
      const head = new TextEncoder().encode("--b\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\n")
      const tail = new TextEncoder().encode("\r\n--b--\r\n")
      const body = new Uint8Array(head.length + audio.data.length + tail.length)
      body.set(head)
      body.set(audio.data, head.length)
      body.set(tail, head.length + audio.data.length)
      const reply = await call.post("https://api.example.com/v1/audio/transcriptions", { "Content-Type": "multipart/form-data; boundary=b" }, body.buffer)
      seen.body = body.buffer
      return single([{ text: reply.text, startMs: 0, endMs: 4000 }])
    },
  }
}

test("a provider can post a binary body, and the result still goes through the coverage check", async () => {
  const seen: { body?: string | ArrayBuffer } = {}
  const sent: (string | ArrayBuffer)[] = []
  const post: FileAsrPost = async (_url, _headers, body) => {
    sent.push(body)
    return { status: 200, headers: {}, text: "你好" }
  }
  const audio = { data: new Uint8Array([1, 2, 3]), format: "mp3", transcoded: false, bytes: 3 }
  const out = await transcribeFile(multipartProvider(seen), audio, { speakers: false, post })
  assert.ok(sent[0] instanceof ArrayBuffer)
  assert.equal(sent[0], seen.body)
  assert.ok(Buffer.from(sent[0] as ArrayBuffer).includes(Buffer.from([1, 2, 3])))
  assert.equal(out.utterances[0].text, "你好")

  const empty: FileAsrProvider = { ...multipartProvider({}), transcribe: async () => ({ durationMs: 1000, text: "", utterances: [] }) }
  await assert.rejects(transcribeFile(empty, audio, { speakers: false, post }), /识别结果为空/)
})

test("recordings are uploaded as they are when the service takes them, otherwise they need recompressing", async () => {
  const limits = { directFormats: { m4a: "mp4", mp3: "mp3" }, maxBytes: 10 }
  const small = new Uint8Array([1, 2, 3])
  const direct = await prepareAudio(small, "M4A", limits)
  assert.deepEqual({ format: direct.format, transcoded: direct.transcoded, bytes: direct.bytes }, { format: "mp4", transcoded: false, bytes: 3 })
  assert.equal(direct.data, small)
  // Too large, or a format the service does not take, goes through the local decoder, which Node does not have.
  await assert.rejects(prepareAudio(new Uint8Array(11), "mp3", limits))
  await assert.rejects(prepareAudio(small, "flac", limits))
})

test("coverage check rejects empty and silently truncated results", () => {
  assert.doesNotThrow(() => assertCoverage(result))
  assert.throws(() => assertCoverage({ durationMs: 1000, text: "", utterances: [] }), /识别结果为空/)
  assert.throws(() => assertCoverage({ durationMs: 7_200_000, text: "x", utterances: [{ text: "x", startMs: 0, endMs: 600_000 }] }), /静默截断/)
})

test("sentences merge per speaker and split on long pauses", () => {
  const blocks = groupBySpeaker(result.utterances)
  assert.deepEqual(
    blocks.map((b) => [b.speaker, b.startMs, b.text]),
    [
      ["1", 0, "您好，先介绍一下公司。"],
      ["2", 3200, "我们成立于2019年。去年收入2亿。"],
      ["1", 9500, "毛利多少？"],
      ["2", 30_000, "四成左右。"],
    ],
  )
})

test("record renders heading, player, speakers and timestamps", () => {
  const md = renderInterviewRecord(result, { title: "空白笔记", source: "访谈.m4a", vaultPath: "录音/访谈.m4a", transcribedAt: "2026-10-27 18:00", provider: "火山引擎", model: "volc.seedasr.auc" }, true)
  assert.match(md, /^# 空白笔记\n\n## 访谈记录 · 访谈.m4a\n\n!\[\[录音\/访谈.m4a\]\]/)
  assert.match(md, /> \[!info\] 火山引擎录音文件识别原始转写（volc.seedasr.auc）/)
  assert.match(md, /时长 00:00:20 · 2 位说话人 · 5 句/)
  assert.match(md, /\*\*说话人 2\*\* `00:00:03`\n我们成立于2019年。去年收入2亿。/)
  const plain = renderInterviewRecord(single([{ text: "单人。", startMs: 0, endMs: 4000 }]), { title: "x", source: "a.mp3", transcribedAt: "t", provider: "示例", model: "r" }, false)
  assert.match(plain, /示例录音文件识别原始转写（r）/)
  assert.doesNotMatch(plain, /说话人|!\[\[|^# /)
  assert.match(plain, /`00:00:00`\n单人。/)
})

test("write-up input labels speakers per paragraph and keeps timestamps", () => {
  const [, user] = buildMinutesMessages("", { title: "访谈", date: "2026-10-27", utterances: speakerUtterances(result), summaries: [], notes: [] })
  assert.match(user.content, /\[00:00:03\] 说话人2：我们成立于2019年。去年收入2亿。/)
  assert.match(user.content, /\[00:00:09\] 说话人1：毛利多少？/)
  const alone = speakerUtterances(single([{ text: "单人。", startMs: 0, endMs: 1 }]))
  assert.deepEqual(alone.map((u) => u.text), ["单人。"])
})
