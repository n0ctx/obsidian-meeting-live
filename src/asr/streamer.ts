import { ASR_RATE, PcmRing, msToSamples, samplesToMs } from "../audio/pcm.ts"
import { newGap } from "../meeting/gap.ts"
import { speakerId } from "../meeting/speakers.ts"
import type { GapCode, TranscriptGap, Utterance } from "../meeting/types.ts"
import { AsrError, type AsrConnect, type AsrConnection, type AsrUpdate, type AsrUtterance, type LivePacing } from "./contract.ts"

export type AsrState = "disabled" | "idle" | "connecting" | "live" | "reconnecting" | "failed"

export interface AsrEvents {
  onFinal(u: Utterance): void
  onInterim(list: Utterance[]): void
  onGap(gap: TranscriptGap): void
  onState(state: AsrState, detail?: string): void
  onLogId?(id: string): void
}

export interface AsrOptions {
  ringSeconds: number
  chunkMs: number
  /** Send rate for a run that declares none. A run started with a provider's own pacing never uses it. */
  pacing: LivePacing
  tickMs: number
  /** Longest `end()` keeps sending the backlog at the provider's pace; what is still unsent after that is recorded as a gap. */
  flushMs: number
  finalTimeoutMs: number
  /** Longest an utterance may stay unconfirmed before its text is kept and recognition restarts. */
  maxInterimMs: number
  /** Disables the internal timer so tests can drive tick() directly. */
  manualTicks?: boolean
}

/**
 * How long `end()` keeps sending a backlog. Audio left unsent is in the recording either way, but a stop that hangs is a visible failure, so the
 * wait is bounded; a minute covers a backlog of 75 s at the slowest declared rate (1.25x), which is what an outage the retry ladder
 * rides out (about 30 s of waiting plus the speech to resend) leaves behind, and costs the user at most a minute at a stop.
 */
export const DEFAULT_FLUSH_MS = 60_000

const DEFAULTS: AsrOptions = {
  ringSeconds: 180,
  chunkMs: 200,
  // What the streamer sent before providers declared a pace: three chunks per tick, which is 6x real time.
  pacing: { maxRate: 6 },
  tickMs: 100,
  flushMs: DEFAULT_FLUSH_MS,
  finalTimeoutMs: 8000,
  maxInterimMs: 60_000,
}

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000]

/** A tick later than this many ticks is a stalled timer (a background window): it is granted the real time that passed, up to the cap below. */
const LATE_TICKS = 1.5
const MAX_STEP_MS = 1000

/** Shifts a connection-relative utterance onto the meeting timeline. */
function onTimeline(item: AsrUtterance, text: string, baseMs: number): Utterance {
  const u: Utterance = { startMs: baseMs + item.startMs, endMs: baseMs + Math.max(item.startMs, item.endMs), text }
  const speaker = speakerId(item.speaker)
  if (speaker) u.speaker = speaker
  return u
}

export class AsrStreamer {
  private readonly options: AsrOptions
  private readonly ring: PcmRing
  private readonly chunk: number
  private connection: AsrConnection | undefined
  private connecting: Promise<void> | undefined
  private state: AsrState
  private cursor = 0
  private lastFinalEndMs = 0
  private readonly finalKeys = new Set<number>()
  private interims: Utterance[] = []
  private retryIndex = 0
  private retryTimer: number | undefined
  private tickTimer: number | undefined
  private finalWaiter: (() => void) | undefined
  private running = false
  private ending = false
  private generation = 0
  /** Audio (in samples) the provider's pace lets the next tick send; the part of a chunk left over carries into the next tick. */
  private allowance = 0
  private pacing: LivePacing
  private lastStepAt: number | undefined
  private flushCut = false
  private wakeFlush: (() => void) | undefined

  /** The connector of the current run; a new run may bring a different one. */
  private connect: AsrConnect | null = null
  private readonly events: AsrEvents

  constructor(events: AsrEvents, options: Partial<AsrOptions> = {}) {
    this.events = events
    this.options = { ...DEFAULTS, ...options }
    this.pacing = this.options.pacing
    this.ring = new PcmRing(this.options.ringSeconds * ASR_RATE)
    this.chunk = (this.options.chunkMs / 1000) * ASR_RATE
    this.state = "idle"
  }

  get currentState(): AsrState {
    return this.state
  }

  /** Timeline position (ms) up to which audio has been delivered to the recognizer. */
  get deliveredMs(): number {
    return samplesToMs(this.cursor)
  }

  get backlogMs(): number {
    return samplesToMs(this.ring.end - this.cursor)
  }

  /** Marks finals already persisted, so a continued meeting never re-emits them. */
  restore(finals: Utterance[]): void {
    for (const u of finals) {
      this.finalKeys.add(Math.round(u.startMs))
      this.lastFinalEndMs = Math.max(this.lastFinalEndMs, u.endMs)
    }
  }

  /**
   * Starts a recording run at the given timeline position, recognizing through `connect` (null: no recognizer
   * is available, so the run is recorded as a gap), sending no faster than `pacing`. The buffer and the finals already seen carry over between runs.
   */
  begin(positionMs: number, connect: AsrConnect | null, pacing: LivePacing = this.options.pacing): void {
    this.connect = connect
    this.pacing = pacing
    this.flushCut = false
    const position = msToSamples(positionMs)
    if (this.ring.end !== position) this.ring.seek(position)
    this.running = true
    this.ending = false
    this.cursor = position
    this.retryIndex = 0
    this.lastStepAt = undefined
    if (!this.options.manualTicks) this.tickTimer = window.setInterval(() => this.tick(this.step()), this.options.tickMs)
    if (connect) void this.open("connecting")
    else this.setState("disabled")
  }

  push(samples: Int16Array): void {
    if (!this.running) return
    this.ring.push(samples)
    if (this.cursor < this.ring.start) {
      this.emitGap(this.cursor, this.ring.start, "overflow")
      this.cursor = this.ring.start
    }
  }

  /** One step of sending; `elapsedMs` is the time it stands for, a tick unless the timer ran late. */
  tick(elapsedMs: number = this.options.tickMs): void {
    if (this.state !== "live" || !this.connection) return
    this.pump(elapsedMs, false)
  }

  /** Time a step stands for: one tick, or the time that really passed when the timer ran clearly late, so a throttled timer does not slow the stream. */
  private step(): number {
    const now = Date.now()
    const passed = now - (this.lastStepAt ?? now)
    this.lastStepAt = now
    return passed >= this.options.tickMs * LATE_TICKS ? Math.min(passed, MAX_STEP_MS) : this.options.tickMs
  }

  /**
   * Sends what the provider's pace allows for `elapsedMs`: whole chunks (and the last partial one when `final`), at most
   * `maxRate` × time on average. Less than one chunk of allowance carries over; more never builds up, so idle time buys no burst.
   */
  private pump(elapsedMs: number, final: boolean): void {
    this.allowance += Math.round((this.pacing.maxRate * elapsedMs * ASR_RATE) / 1000)
    for (;;) {
      const pending = this.ring.end - this.cursor
      const size = pending >= this.chunk ? this.chunk : final ? pending : 0
      if (size === 0 || this.allowance < size) break
      this.send(size, false)
      this.allowance -= size
    }
    this.allowance = Math.min(this.allowance, this.chunk - 1)
  }

  /** Makes a pending `end()` stop sending its backlog and record what is left as a gap: a resumed recording must not wait for it. */
  interruptFlush(): void {
    this.flushCut = true
    this.wakeFlush?.()
  }

  /** Ends the current run: flushes audio, waits for final results, records untranscribed audio as gaps. */
  async end(): Promise<void> {
    if (!this.running) return
    this.ending = true
    this.clearRetry()
    if (this.tickTimer) window.clearInterval(this.tickTimer)
    this.tickTimer = undefined
    if (this.connecting) await this.connecting
    let tail: GapCode = this.connect ? "disconnected" : "unconfigured"
    if (this.state === "live" && this.connection) {
      tail = (await this.flush()) ?? tail
      // A connection lost during the flush has nobody left to wait for.
      if (this.connection) {
        let timeout: number | undefined
        const done = new Promise<void>((resolve) => {
          this.finalWaiter = resolve
          timeout = window.setTimeout(resolve, this.options.finalTimeoutMs)
        })
        try {
          this.connection.sendAudio(new Int16Array(0), true)
          await done
        } catch {
          // The socket closed while finishing; remaining interims are committed below.
        }
        window.clearTimeout(timeout)
        this.finalWaiter = undefined
      }
      this.dropConnection()
    }
    for (const u of this.interims) this.acceptFinal(u)
    this.setInterims([])
    if (this.cursor < this.ring.end) {
      this.emitGap(this.cursor, this.ring.end, tail)
      this.cursor = this.ring.end
    }
    this.running = false
    this.ending = false
    this.setState(this.connect ? "idle" : "disabled")
  }

  /**
   * Immediately retries a failed or waiting connection, through `connect` when given (the recognizer resolved afresh, so settings fixed
   * since the failure apply), whose `pacing` then applies. The buffer and the finals stay. Returns whether a retry started: not while live or already connecting.
   */
  retryNow(connect?: AsrConnect, pacing?: LivePacing): boolean {
    if (!this.running || !this.connect || this.state === "live" || this.connecting) return false
    if (connect) {
      this.connect = connect
      this.pacing = pacing ?? this.options.pacing
    }
    this.clearRetry()
    this.retryIndex = 0
    void this.open("reconnecting")
    return true
  }

  dispose(): void {
    this.running = false
    this.clearRetry()
    if (this.tickTimer) window.clearInterval(this.tickTimer)
    this.dropConnection()
  }

  /**
   * Sends the backlog at the provider's pace, so ending a run after an outage obeys the same limit as catching up does. The wait is
   * bounded by `flushMs`: the audio is in the recording either way, but a stop that hangs is a visible failure. Returns why audio is
   * left unsent (the bound or a resumed recording cut the flush, or the connection went), and nothing when all of it went out.
   */
  private async flush(): Promise<GapCode | undefined> {
    const deadline = Date.now() + this.options.flushMs
    let elapsed = this.options.tickMs
    this.lastStepAt = undefined
    while (this.ring.end > this.cursor) {
      if (!this.running || !this.connection) return "disconnected"
      try {
        this.pump(elapsed, true)
      } catch {
        return "disconnected"
      }
      if (this.ring.end <= this.cursor) break
      if (this.flushCut || Date.now() >= deadline) return "unsent"
      await this.sleep(this.options.tickMs)
      elapsed = this.step()
    }
    return undefined
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        window.clearTimeout(timer)
        this.wakeFlush = undefined
        resolve()
      }
      const timer = window.setTimeout(wake, ms)
      this.wakeFlush = wake
    })
  }

  private send(samples: number, last: boolean): void {
    const pcm = this.ring.read(this.cursor, samples)
    this.connection?.sendAudio(pcm, last)
    this.cursor += pcm.length
  }

  private async open(state: "connecting" | "reconnecting"): Promise<void> {
    if (!this.connect) return
    const generation = ++this.generation
    this.setState(state)
    // Result times count from the first sample sent on this connection, which is where the cursor stands once it is ready.
    let base = this.cursor
    const attempt = (async () => {
      try {
        const { connection, logId } = await this.connect!({
          onResult: (update, last) => {
            if (generation === this.generation) this.handleResult(update, last, base)
          },
          onClose: (error) => {
            if (generation === this.generation) this.handleDrop(error)
          },
        })
        if (generation !== this.generation || !this.running) {
          connection.close()
          return
        }
        base = this.cursor
        this.allowance = 0
        this.lastStepAt = undefined
        this.connection = connection
        this.retryIndex = 0
        if (logId) this.events.onLogId?.(logId)
        this.setState("live")
      } catch (error) {
        if (generation !== this.generation || !this.running || this.ending) return
        const asrError = error instanceof AsrError ? error : new AsrError(String((error as Error)?.message ?? error), false)
        this.scheduleRetry(asrError)
      }
    })()
    this.connecting = attempt
    await attempt
    if (this.connecting === attempt) this.connecting = undefined
  }

  private handleDrop(error: AsrError): void {
    this.connection = undefined
    this.finalWaiter?.()
    if (!this.running || this.ending) return
    // Resume from the earliest unconfirmed speech so nothing between confirmed text and the drop is lost.
    const earliestInterim = this.interims.reduce((min, u) => Math.min(min, u.startMs), Infinity)
    const restartMs = Math.max(this.lastFinalEndMs, Math.min(earliestInterim, samplesToMs(this.cursor)))
    this.cursor = Math.max(this.ring.start, Math.min(this.cursor, msToSamples(restartMs)))
    this.setInterims([])
    this.scheduleRetry(error)
  }

  private scheduleRetry(error: AsrError): void {
    this.connection = undefined
    if (error.fatal) {
      this.setState("failed", error.message)
      return
    }
    const delay = RETRY_DELAYS[Math.min(this.retryIndex++, RETRY_DELAYS.length - 1)]
    this.setState("reconnecting", error.message)
    this.clearRetry()
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined
      if (this.running) void this.open("reconnecting")
    }, delay)
  }

  private handleResult(update: AsrUpdate, last: boolean, base: number): void {
    const baseMs = samplesToMs(base)
    const items = update.utterances.flatMap((item) => {
      const text = item.text.trim()
      return text ? [{ final: item.final, u: onTimeline(item, text, baseMs) }] : []
    })
    for (const item of items) if (item.final) this.acceptFinal(item.u)
    if (!update.keepInterims) this.setInterims(items.filter((item) => !item.final && !this.finalKeys.has(Math.round(item.u.startMs))).map((item) => item.u))
    if (last) this.finalWaiter?.()
    else if (!this.ending && this.interims.some((u) => u.endMs - u.startMs > this.options.maxInterimMs)) this.restartStuck()
  }

  /** The recognizer stopped confirming utterances: keeps the unconfirmed text and resumes on a new connection. */
  private restartStuck(): void {
    for (const u of this.interims) this.acceptFinal(u)
    this.setInterims([])
    this.cursor = Math.max(this.ring.start, Math.min(this.cursor, msToSamples(this.lastFinalEndMs)))
    this.dropConnection()
    void this.open("reconnecting")
  }

  private acceptFinal(u: Utterance): void {
    const key = Math.round(u.startMs)
    if (this.finalKeys.has(key)) return
    if (u.startMs < this.lastFinalEndMs - 300) return
    this.finalKeys.add(key)
    this.lastFinalEndMs = Math.max(this.lastFinalEndMs, u.endMs)
    this.events.onFinal(u)
  }

  private setInterims(list: Utterance[]): void {
    if (list.length === 0 && this.interims.length === 0) return
    this.interims = list
    this.events.onInterim(list)
  }

  private emitGap(from: number, to: number, code: GapCode): void {
    if (to <= from) return
    this.events.onGap(newGap(samplesToMs(from), samplesToMs(to), code))
  }

  private dropConnection(): void {
    this.generation++
    this.connection?.close()
    this.connection = undefined
  }

  private clearRetry(): void {
    if (this.retryTimer) window.clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }

  private setState(state: AsrState, detail?: string): void {
    this.state = state
    this.events.onState(state, detail)
  }
}
