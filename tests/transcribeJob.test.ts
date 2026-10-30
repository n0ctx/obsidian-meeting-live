import assert from "node:assert/strict"
import { test } from "node:test"
import { TFile } from "obsidian"
import { TranscribeJob, TranscribeJobs, type TranscribeDeps } from "../src/ui/transcribeJob.ts"

// The stub's TFile takes a path; the real typings expose no public constructor.
const file = (path: string) => new (TFile as unknown as new (path: string) => TFile)(path)

function fakeVault(files: Record<string, string>) {
  const created: string[] = []
  const vault = {
    getAbstractFileByPath: (p: string) => (p in files ? file(p) : null),
    read: async (f: TFile) => files[f.path],
    process: async (f: TFile, fn: (s: string) => string) => (files[f.path] = fn(files[f.path])),
    create: async (p: string, c: string) => {
      files[p] = c
      created.push(p)
    },
    createFolder: async (p: string) => (files[p] = ""),
  }
  return { app: { vault, workspace: { openLinkText: async () => undefined } } as never, created }
}

const asrPayload = { audio_info: { duration: 10_000 }, result: { text: "t", utterances: [{ text: "您好。", start_time: 0, end_time: 2000, additions: { speaker: "1" } }, { text: "收入3亿。", start_time: 2500, end_time: 9500, additions: { speaker: "2" } }] } }

test("a failed write-up retries without re-running recognition, then replaces the bar", async () => {
  const files: Record<string, string> = { "访谈.md": "## 速记\n- 李总\n" }
  const { app, created } = fakeVault(files)
  let asrCalls = 0
  let llmCalls = 0
  const deps: TranscribeDeps = {
    auth: () => ({}),
    post: async (url) => {
      asrCalls++
      return url.endsWith("/submit") ? { status: 200, headers: { "x-api-status-code": "20000000" }, text: "" } : { status: 200, headers: { "x-api-status-code": "20000000" }, text: JSON.stringify(asrPayload) }
    },
    llm: () => ({
      problem: undefined,
      model: "m",
      target: "t",
      complete: async (messages) => {
        llmCalls++
        if (llmCalls === 1) throw new Error("LLM 请求失败（HTTP 429）")
        assert.match(messages[1].content, /说话人2：收入3亿。/)
        assert.match(messages[1].content, /李总/)
        return "### 一、财务\n- 收入3亿"
      },
    }),
    prompt: () => "系统提示",
    transcriptFolder: () => "Meetings/录音转写",
  }
  const source = { name: "访谈.mp3", extension: "mp3", size: 3, modified: Date.parse("2026-10-27"), read: async () => new Uint8Array([1, 2, 3]) }
  const job = new TranscribeJob(app, deps, file("访谈.md"), source, { apiKey: "k", appId: "", accessToken: "", resourceId: "volc.seedasr.auc" }, { speakers: true, writeUp: true })
  const jobs = new TranscribeJobs(app, { addClass() {}, addEventListener() {}, toggleClass() {}, empty() {}, setText() {}, setAttr() {} } as never)

  // Resolve on the tracker's final notification, after the job has left the running set.
  const finished = () =>
    new Promise<void>((resolve) => {
      const ref = jobs.on("change", (j: unknown) => {
        if ((j as TranscribeJob).finished && jobs.running === 0) {
          jobs.offref(ref as never)
          resolve()
        }
      })
    })
  let done = finished()
  await jobs.start(job)
  await done
  assert.equal(job.stage, "failed")
  assert.equal(job.failedAt, "writing")
  assert.ok(job.recognized)
  assert.equal(asrCalls, 2)
  assert.deepEqual(created, ["Meetings/录音转写/访谈 原始转写.md"])
  assert.match(files["Meetings/录音转写/访谈 原始转写.md"], /^---\ntype: audio-transcript\nnote: "\[\[访谈\]\]"\ndate: 2026-10-27\n/)
  assert.match(files["访谈.md"], /```meeting-live-job\nid: j-/)

  done = finished()
  await jobs.start(job)
  await done
  assert.equal(job.stage, "done")
  assert.equal(asrCalls, 2, "retry must not call recognition again")
  assert.equal(created.length, 1, "retry must not write a second raw transcript")
  assert.doesNotMatch(files["访谈.md"], /meeting-live-job/)
  assert.match(files["访谈.md"], /^## 速记\n- 李总\n\n> \[!info\] 访谈记录由 m 根据录音「访谈.mp3」/)
  assert.match(files["访谈.md"], /> 原始转写：\[\[Meetings\/录音转写\/访谈 原始转写\|/)
  assert.match(files["访谈.md"], /### 一、财务\n- 收入3亿\n$/)
  assert.equal(jobs.get(job.id), undefined)
})
