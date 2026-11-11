// Cuts a 16 kHz PCM stream into utterances at a pause, or at a maximum length when nobody pauses.
// An adaptive noise floor keeps a quiet room from looking like speech, and a short pre-roll keeps a word's onset.
import { ASR_RATE } from "../../../audio/pcm.ts"

export interface SpeechChunk {
  pcm: Int16Array
  /** Index of pcm[0] in the audio this cutter has been given, so times can be placed on that timeline. */
  startSample: number
}

const FRAME_MS = 100
/** Quiet audio kept so the start of a word is not clipped. */
const PREROLL_FRAMES = 3
/** Shorter than this, a clip is a click, not an utterance. */
const MIN_SPEECH_FRAMES = 3
/** On stop, a trailing utterance this short is dropped: it is the tail of a pause, not a sentence. */
const MIN_FLUSH_FRAMES = 5

const rmsOf = (frame: Int16Array): number => {
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i] / 32768
    sum += s * s
  }
  return Math.sqrt(sum / frame.length)
}

const concat = (parts: Int16Array[]): Int16Array => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/**
 * Pause cutter. Frames are 100 ms. A frame is speech when its RMS exceeds both a fixed floor and three times the
 * noise estimated while nobody is speaking. After `pauseMs` of quiet, or `maxMs` of audio, the utterance is ready.
 */
export class PauseCutter {
  private readonly frame: number
  private readonly pauseFrames: number
  private readonly maxFrames: number
  private floor = 0.003
  private pending = new Int16Array(0)
  private pre: Int16Array[] = []
  private speech: Int16Array[] = []
  private silence = 0
  private loudFrames = 0
  /** Index of the next sample that will be framed. */
  private next = 0
  private speechStart = 0

  constructor(pauseMs: number, maxMs: number, rate = ASR_RATE) {
    this.frame = Math.max(1, Math.round((rate * FRAME_MS) / 1000))
    this.pauseFrames = Math.max(1, Math.round(pauseMs / FRAME_MS))
    this.maxFrames = Math.max(this.pauseFrames + 1, Math.round(maxMs / FRAME_MS))
  }

  push(pcm: Int16Array): SpeechChunk[] {
    if (pcm.length === 0) return []
    const all = new Int16Array(this.pending.length + pcm.length)
    all.set(this.pending, 0)
    all.set(pcm, this.pending.length)
    const ready: SpeechChunk[] = []
    let at = 0
    while (at + this.frame <= all.length) {
      const frame = all.subarray(at, at + this.frame)
      at += this.frame
      const chunk = this.take(Int16Array.from(frame))
      if (chunk) ready.push(chunk)
    }
    this.pending = Int16Array.from(all.subarray(at))
    return ready
  }

  /** The recording stopped: send a trailing utterance that is long enough to be speech, and drop the rest. */
  finish(): SpeechChunk[] {
    if (this.speech.length) this.speech.push(this.pending)
    this.next += this.pending.length
    this.pending = new Int16Array(0)
    const samples = this.speech.reduce((n, frame) => n + frame.length, 0)
    if (samples < this.frame * MIN_FLUSH_FRAMES) {
      this.speech = []
      this.silence = 0
      this.loudFrames = 0
      return []
    }
    return [this.emit()]
  }

  private take(frame: Int16Array): SpeechChunk | undefined {
    const frameStart = this.next
    this.next += frame.length
    const loud = rmsOf(frame) > Math.max(0.006, this.floor * 3)
    if (this.speech.length === 0) {
      if (!loud) this.floor = 0.95 * this.floor + 0.05 * rmsOf(frame)
      this.pre = [...this.pre, frame].slice(-PREROLL_FRAMES)
      if (!loud) return undefined
      this.speechStart = frameStart - this.pre.slice(0, -1).reduce((n, f) => n + f.length, 0)
      this.speech = [...this.pre]
      this.silence = 0
      this.loudFrames = 1
      return undefined
    }
    this.speech.push(frame)
    this.silence = loud ? 0 : this.silence + 1
    if (loud) this.loudFrames++
    if (this.silence < this.pauseFrames && this.speech.length < this.maxFrames) return undefined
    if (this.loudFrames < MIN_SPEECH_FRAMES) {
      this.speech = []
      this.pre = []
      this.silence = 0
      this.loudFrames = 0
      return undefined
    }
    return this.emit()
  }

  private emit(): SpeechChunk {
    const chunk = { pcm: concat(this.speech), startSample: this.speechStart }
    this.speech = []
    this.pre = []
    this.silence = 0
    this.loudFrames = 0
    return chunk
  }
}
