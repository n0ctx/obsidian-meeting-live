import assert from "node:assert/strict"
import { test } from "node:test"
import { buildCorpus } from "../src/asr/context.ts"
import { resolveFile, resolveLive } from "../src/asr/providers/registry.ts"
import { decodeClientFrame, encodeServerResult } from "../src/asr/providers/volc/protocol.ts"
import type { PreparedAudio } from "../src/audio/transcode.ts"
import { withOne } from "./support/accounts.ts"
import { collect, fakeWs, waitFor } from "./support/fakeWs.ts"

const words = (n: number) => Array.from({ length: n }, (_, i) => `词${i + 1}`)
const inner = (corpus: Record<string, unknown> | undefined) => JSON.parse(corpus!.context as string) as { hotwords?: { word: string }[]; context_type?: string; context_data?: { text: string }[] }

test("a context with nothing in it adds no corpus, so the request keeps its present shape", () => {
  assert.equal(buildCorpus(undefined, "live"), undefined)
  assert.equal(buildCorpus({ hotwords: [" ", ""], scene: "  " }, "live"), undefined)
  assert.equal(buildCorpus({ hotwords: [], boostingTableId: " ", correctTableId: "" }, "file"), undefined)
})

test("context is a JSON string with the hotwords first and the scene as the first context_data entry; table ids sit on corpus", () => {
  const corpus = buildCorpus({ hotwords: ["青柠科技", "GPU", "青柠科技"], scene: "这是投后访谈，可能提到估值、对赌", boostingTableId: " 266030001 ", correctTableId: "77" }, "live")!
  assert.equal(typeof corpus.context, "string")
  assert.deepEqual(Object.keys(JSON.parse(corpus.context as string)), ["hotwords", "context_type", "context_data"])
  assert.deepEqual(inner(corpus), { hotwords: [{ word: "青柠科技" }, { word: "GPU" }], context_type: "dialog_ctx", context_data: [{ text: "这是投后访谈，可能提到估值、对赌" }] })
  assert.equal(corpus.boosting_table_id, "266030001")
  assert.equal(corpus.correct_table_id, "77")
  assert.doesNotMatch(corpus.context as string, /266030001|table/)
})

test("the live list is not cut to 100: the second pass reads past what the first keeps; the client stops only past 500", () => {
  assert.equal(inner(buildCorpus({ hotwords: words(120) }, "live")).hotwords!.length, 120)
  const capped = inner(buildCorpus({ hotwords: words(520) }, "live")).hotwords!
  assert.equal(capped.length, 500)
  assert.equal(capped[0].word, "词1", "the front of the list, the important end, is kept")
  assert.equal(inner(buildCorpus({ hotwords: words(5200) }, "file")).hotwords!.length, 5000)
})

test("the scene is held to the context limit by a high estimate: 800 tokens live, 500 for files", () => {
  const long = "估".repeat(600)
  assert.equal(inner(buildCorpus({ hotwords: [], scene: long }, "live")).context_data![0].text.length, 400)
  assert.equal(inner(buildCorpus({ hotwords: [], scene: long }, "file")).context_data![0].text.length, 250)
})

/** The full client request a resolved Volcengine stream sends first, captured by a local server. */
async function firstRequest(env: Parameters<typeof resolveLive>[0]): Promise<{ request: Record<string, unknown> }> {
  let first: { request: Record<string, unknown> } | undefined
  const server = await fakeWs((ws) =>
    ws.on("message", (data: Buffer) => {
      const frame = decodeClientFrame(data)
      if (frame.type !== 1) return
      first = JSON.parse(frame.payload.toString())
      ws.send(encodeServerResult(1, { result: { text: "" } }, false))
    }),
  )
  const account = env.settings.accounts[0]
  account.options.endpoint = `${server.url}/api/v3/sauc/bigmodel_async`
  const resolved = resolveLive(env)
  assert.ok(resolved.connect, resolved.problem ?? "no connector")
  const { connection } = await resolved.connect(collect().handlers)
  await waitFor(() => !!first)
  connection.close()
  return first!
}

test("a live run sends the meeting's context; a run without one sends the typed hotwords as before", async () => {
  const { settings } = withOne("volc", { key: "volc-key" })
  settings.hotwords = "甲方资本\n乙方科技"
  const secrets = { getSecret: () => "k" }
  const typed = await firstRequest({ secrets, settings })
  assert.deepEqual(inner(typed.request.corpus as Record<string, unknown>), { hotwords: [{ word: "甲方资本" }, { word: "乙方科技" }] })
  assert.equal(typed.request.enable_nonstream, true)

  settings.accounts[0].options.boostingTableId = "t-1"
  const meeting = await firstRequest({ secrets, settings, context: () => ({ hotwords: ["甲方资本", ...words(119)], scene: "投后访谈" }) })
  const corpus = meeting.request.corpus as Record<string, unknown>
  assert.equal(inner(corpus).hotwords!.length, 120)
  assert.deepEqual(inner(corpus).context_data, [{ text: "投后访谈" }])
  assert.equal(corpus.boosting_table_id, "t-1")

  settings.hotwords = ""
  settings.accounts[0].options.boostingTableId = ""
  const bare = await firstRequest({ secrets, settings })
  assert.equal("corpus" in bare.request, false)
})

test("a recorded file is submitted with the context it was resolved with", async () => {
  const { settings } = withOne("volc", { key: "volc-key" })
  const bodies: Record<string, unknown>[] = []
  const done = { status: 200, headers: { "x-api-status-code": "20000000" }, text: JSON.stringify({ result: { text: "", utterances: [] } }) }
  const post = async (_url: string, _headers: Record<string, string>, body: string | ArrayBuffer) => (bodies.push(JSON.parse(body as string)), done)
  const audio: PreparedAudio = { data: new Uint8Array([1, 2]), format: "mp3", transcoded: false, bytes: 2 }
  const provider = resolveFile({ secrets: { getSecret: () => "k" }, settings, context: () => ({ hotwords: ["青柠科技"], scene: "季度投后访谈" }) })
  await provider.transcribe(audio, { speakers: false, post, sleep: async () => undefined })
  const corpus = (bodies[0].request as Record<string, unknown>).corpus as Record<string, unknown>
  assert.deepEqual(inner(corpus), { hotwords: [{ word: "青柠科技" }], context_type: "dialog_ctx", context_data: [{ text: "季度投后访谈" }] })
})
