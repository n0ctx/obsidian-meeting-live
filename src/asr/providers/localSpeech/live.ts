// Live transcription against a synchronous OpenAI-compatible transcription endpoint.
// Audio is cut at a pause (or at the maximum length), encoded as WAV, and posted one utterance at a time.
// Only finals are delivered. Times from the reply are placed where that utterance sits in the audio sent on this connection.
import { requestUrl } from "obsidian"
import { wavHeader } from "../../../audio/wav.ts"
import { t } from "../../../i18n/index.ts"
import { AsrError, type AsrConnect, type AsrConnection, type AsrUtterance } from "../../contract.ts"
import type { FileAsrPost } from "../../fileAsr.ts"
import { openAiTranscribeFile, type OpenAiFileConfig } from "../openaiCompat/file.ts"
import { PauseCutter, type SpeechChunk } from "./segment.ts"

/** The same multipart post the file path uses, so a live utterance and a recording speak one request. */
export const localSpeechPost: FileAsrPost = async (url, headers, body) => {
  const { "Content-Type": contentType, ...rest } = headers
  const response = await requestUrl({ url, method: "POST", headers: rest, contentType, body, throw: false })
  return { status: response.status, headers: response.headers, text: response.text }
}

const wavOf = (pcm: Int16Array): Uint8Array => {
  const data = new Uint8Array(pcm.byteLength)
  data.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
  const header = wavHeader(16000, 1, data.byteLength)
  const out = new Uint8Array(header.byteLength + data.byteLength)
  out.set(header)
  out.set(data, header.byteLength)
  return out
}

const placed = (chunk: SpeechChunk, utterances: { text: string; startMs: number; endMs: number }[]): AsrUtterance[] => {
  const offset = (chunk.startSample / 16000) * 1000
  const span = (chunk.pcm.length / 16000) * 1000
  return utterances
    .filter((u) => u.text)
    .map((u) => ({ text: u.text, startMs: offset + u.startMs, endMs: offset + (u.endMs > u.startMs ? u.endMs : span), final: true }))
}

const said = (error: unknown): string => {
  const message = error instanceof Error ? error.message : ""
  return !message || message.includes("\n") || message.length > 300 ? t("localSpeech.check.down") : message
}

/** Posts one WAV at a time and reports only finished utterances. `post` is injected so a test never leaves the machine. */
export function localSpeechConnector(config: OpenAiFileConfig, pauseMs: number, maxMs: number, post: FileAsrPost = localSpeechPost): AsrConnect {
  return async (handlers) => {
    const cutter = new PauseCutter(pauseMs, maxMs)
    let chain = Promise.resolve()
    let closed = false
    let pending = 0
    const fail = (error: unknown) => {
      if (closed) return
      closed = true
      const message = said(error)
      handlers.onClose(new AsrError(message, /HTTP (401|403)/.test(message)))
    }
    const note = (activity: string) => {
      if (!closed) handlers.onResult({ utterances: [], keepInterims: true, activity }, false)
    }
    const enqueue = (chunks: SpeechChunk[]) => {
      for (const chunk of chunks) {
        pending++
        if (pending === 1) note("recognizing")
        chain = chain.then(async () => {
          if (closed) return
          try {
            const audio = { data: wavOf(chunk.pcm), format: "wav" as const, transcoded: true, bytes: chunk.pcm.byteLength + 44 }
            const result = await openAiTranscribeFile(config, audio, { speakers: false, post })
            if (closed) return
            const utterances = placed(chunk, result.utterances)
            if (utterances.length) handlers.onResult({ utterances }, false)
          } catch (error) {
            fail(error)
          } finally {
            pending--
            if (pending === 0 && !closed) note("")
          }
        })
      }
    }
    const connection: AsrConnection = {
      sendAudio(pcm, last) {
        if (closed) return
        enqueue(cutter.push(pcm))
        if (!last) return
        enqueue(cutter.finish())
        void chain.then(() => {
          if (!closed) handlers.onResult({ utterances: [], keepInterims: true }, true)
        })
      },
      close() {
        closed = true
      },
    }
    return { connection }
  }
}
