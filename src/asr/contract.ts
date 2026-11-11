// The provider-neutral streaming contract between AsrStreamer and a provider adapter.
//
// An adapter owns everything provider-specific: wire format, authentication, how timestamps are
// obtained, and which errors are fatal. The streamer owns buffering, resuming, deduplication and gaps.
import { samplesToMs } from "../audio/pcm.ts"

export class AsrError extends Error {
  /** Fatal errors (bad credentials, bad parameters) are not retried automatically. */
  readonly fatal: boolean

  constructor(message: string, fatal: boolean) {
    super(message)
    this.fatal = fatal
  }
}

/**
 * Times are milliseconds from the first audio sample sent on the connection that produced them,
 * not from the meeting start; the streamer shifts them onto the meeting timeline.
 */
export interface AsrUtterance {
  text: string
  startMs: number
  endMs: number
  /** Final text never changes again. Non-final text is a live guess that later updates replace. */
  final: boolean
  speaker?: string
}

export interface AsrUpdate {
  /**
   * What the provider reported. Finals may repeat earlier ones; the streamer deduplicates by start time.
   * The non-final entries replace the current set of in-progress utterances.
   */
  utterances: AsrUtterance[]
  /** Leave the in-progress utterances as they are (for example a keep-alive carrying no content). */
  keepInterims?: boolean
  /**
   * A note for the card, not text. `"recognizing"` means a finished utterance is being recognized; `""` clears it.
   * The streamer does not read it: the session does, so a slow request can say it is still working.
   */
  activity?: string
}

export interface AsrConnection {
  /** Audio is 16 kHz mono PCM16. `last` marks the end of the stream; a final `onResult(…, true)` must follow. */
  sendAudio(pcm: Int16Array, last: boolean): void
  close(): void
}

export interface AsrConnectionHandlers {
  /** `last` is true once the provider has nothing more to say about the audio sent before the end of stream. */
  onResult(update: AsrUpdate, last: boolean): void
  /** Called once when the connection ends without being closed locally. */
  onClose(error: AsrError): void
}

/**
 * How fast a provider takes audio. Services throttle, close or error when audio arrives faster than they can follow, so the streamer
 * never sends faster than the provider declares, in steady state, while catching up after a reconnect, and when a run ends.
 *
 * The guarantee: over any window of W seconds the streamer sends at most `maxRate` × W seconds of audio, plus one chunk (200 ms) and
 * what a late timer tick owes. A provider that limits audio per window (Tencent: error 4000 above 3 s of audio within 1 s) declares a
 * rate that keeps `maxRate` × 1.1 s + 0.2 s under that limit, with room to spare.
 */
export interface LivePacing {
  /** Largest sustained send rate as a multiple of real time: 1 is real time, 2 sends two seconds of audio per second. At 1 a backlog never shrinks. */
  maxRate: number
}

/**
 * For a provider whose documentation states no limit: the 1.25x real-time throttle that Deepgram and AssemblyAI both document for
 * their streaming APIs. Real-time-only services (Tencent, iFlytek) state 1x, which cannot drain a backlog at all; this is the least
 * that does, and it is a rate two comparable services are documented to accept.
 */
export const CAUTIOUS_LIVE_PACING: LivePacing = { maxRate: 1.25 }

export type AsrConnect = (handlers: AsrConnectionHandlers) => Promise<{ connection: AsrConnection; logId?: string }>

/**
 * Position in the audio an adapter has sent so far. An adapter whose provider returns no timestamps
 * derives them from this: whatever it commits between two readings spans exactly that stretch of audio.
 */
export class SentAudioClock {
  private samples = 0

  advance(samples: number): void {
    this.samples += samples
  }

  get ms(): number {
    return samplesToMs(this.samples)
  }
}
