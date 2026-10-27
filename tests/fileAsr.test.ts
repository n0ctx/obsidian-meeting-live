import assert from "node:assert/strict"
import { test } from "node:test"
import { assertCoverage, groupBySpeaker, parseFileResult, renderInterviewRecord, speakerUtterances, statusOf, transcribeFile, type FileAsrResponse } from "../src/asr/fileAsr.ts"
import { buildMinutesMessages } from "../src/llm/minutes.ts"

const auth = { apiKey: "k", appId: "", accessToken: "", resourceId: "volc.seedasr.auc" }
const ok = (body: unknown = {}, code = "20000000"): FileAsrResponse => ({ status: 200, headers: { "x-api-status-code": code, "x-api-message": "OK" }, text: body === "" ? "" : JSON.stringify(body) })

const payload = {
  audio_info: { duration: 20_000 },
  result: {
    text: "全文",
    utterances: [
      { text: "您好，先介绍一下公司。", start_time: 0, end_time: 3000, additions: { speaker: "1" } },
      { text: "我们成立于2019年。", start_time: 3200, end_time: 6000, additions: { speaker: "2" } },
      { text: "去年收入2亿。", start_time: 6100, end_time: 9000, additions: { speaker: "2" } },
      { text: "毛利多少？", start_time: 9500, end_time: 11000, additions: { speaker: "1" } },
      { text: "四成左右。", start_time: 30_000, end_time: 32_000, speaker: "2" },
    ],
  },
}

test("status comes from the header, or the body header when missing; auth and 413 are explicit", () => {
  assert.equal(statusOf(ok({}, "20000001")).code, "20000001")
  assert.deepEqual(statusOf({ status: 400, headers: {}, text: '{"header":{"code":45000001,"message":"bad audio"}}' }).code, "45000001")
  assert.throws(() => statusOf({ status: 403, headers: {}, text: "requested resource not granted" }), /鉴权失败（HTTP 403）/)
  assert.throws(() => statusOf({ status: 413, headers: {}, text: "<html>too large</html>" }), /HTTP 413/)
})

test("submit then polls until done, reading speakers from additions", async () => {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = []
  const replies = [ok(""), ok({}, "20000001"), ok({}, "20000002"), ok(payload)]
  const stages: string[] = []
  const result = await transcribeFile(auth, { base64: "QUJD", format: "mp3" }, {
    speakers: true,
    post: async (url, headers, body) => {
      calls.push({ url, headers, body })
      return replies.shift()!
    },
    onStage: (s) => stages.push(s.stage),
    sleep: async () => undefined,
  })
  assert.match(calls[0].url, /\/api\/v3\/auc\/bigmodel\/submit$/)
  const submitted = JSON.parse(calls[0].body)
  assert.deepEqual(submitted.audio, { data: "QUJD", format: "mp3" })
  assert.equal(submitted.request.enable_speaker_info, true)
  assert.equal(submitted.request.corpus, undefined)
  assert.equal(calls[0].headers["X-Api-Key"], "k")
  assert.equal(calls[1].headers["X-Api-Request-Id"], calls[0].headers["X-Api-Request-Id"])
  assert.equal(calls.length, 4)
  assert.deepEqual(stages, ["uploading", "recognizing", "recognizing", "recognizing"])
  assert.deepEqual(result.utterances.map((u) => u.speaker), ["1", "2", "2", "1", "2"])
})

test("failed recognition status surfaces the service message", async () => {
  const replies = [ok(""), { status: 200, headers: {}, text: '{"header":{"code":55000001,"message":"internal"}}' }]
  await assert.rejects(transcribeFile(auth, { base64: "", format: "mp3" }, { speakers: false, post: async () => replies.shift()!, sleep: async () => undefined }), /55000001 internal/)
})

test("coverage check rejects empty and silently truncated results", () => {
  assert.doesNotThrow(() => assertCoverage(parseFileResult(payload)))
  assert.throws(() => assertCoverage(parseFileResult({ audio_info: { duration: 1000 }, result: { text: "", utterances: [] } })), /识别结果为空/)
  const truncated = { audio_info: { duration: 7_200_000 }, result: { text: "x", utterances: [{ text: "x", start_time: 0, end_time: 600_000 }] } }
  assert.throws(() => assertCoverage(parseFileResult(truncated)), /静默截断/)
})

test("sentences merge per speaker and split on long pauses", () => {
  const blocks = groupBySpeaker(parseFileResult(payload).utterances)
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
  const md = renderInterviewRecord(parseFileResult(payload), { title: "空白笔记", source: "访谈.m4a", vaultPath: "录音/访谈.m4a", transcribedAt: "2026-10-27 18:00", resourceId: "volc.seedasr.auc" }, true)
  assert.match(md, /^# 空白笔记\n\n## 访谈记录 · 访谈.m4a\n\n!\[\[录音\/访谈.m4a\]\]/)
  assert.match(md, /时长 00:00:20 · 2 位说话人 · 5 句/)
  assert.match(md, /\*\*说话人 2\*\* `00:00:03`\n我们成立于2019年。去年收入2亿。/)
  const plain = renderInterviewRecord(parseFileResult({ audio_info: { duration: 5000 }, result: { text: "t", utterances: [{ text: "单人。", start_time: 0, end_time: 4000 }] } }), { title: "x", source: "a.mp3", transcribedAt: "t", resourceId: "r" }, false)
  assert.doesNotMatch(plain, /说话人|!\[\[|^# /)
  assert.match(plain, /`00:00:00`\n单人。/)
})

test("write-up input labels speakers per paragraph and keeps timestamps", () => {
  const [, user] = buildMinutesMessages("", { title: "访谈", date: "2026-10-27", utterances: speakerUtterances(parseFileResult(payload)), summaries: [], notes: [] })
  assert.match(user.content, /\[00:00:03\] 说话人2：我们成立于2019年。去年收入2亿。/)
  assert.match(user.content, /\[00:00:09\] 说话人1：毛利多少？/)
  const single = speakerUtterances(parseFileResult({ result: { text: "t", utterances: [{ text: "单人。", start_time: 0, end_time: 1 }] } }))
  assert.deepEqual(single.map((u) => u.text), ["单人。"])
})
