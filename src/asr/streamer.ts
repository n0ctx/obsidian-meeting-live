import { ASR_RATE, PcmRing, msToSamples, samplesToMs } from "../audio/pcm.ts"
import type { TranscriptGap, Utterance } from "../meeting/types.ts"

export class AsrError extends Error {
  /** Fatal errors (bad credentials, bad parameters) are not retried automatically. */
  readonly fatal: boolean

  constructor(message: string, fatal: boolean) {
    super(message)
    this.fatal = fatal
  }
}

export interface AsrConnection {
  sendAudio(pcm: Int16Array, last: boolean): void
  close(): void
}

export interface AsrConnectionHandlers {
  onResult(data: unknown, last: boolean): void
  /** Called once when the connection ends without being closed locally. */
  onClose(error: AsrError): void
}

export type AsrConnect = (handlers: AsrConnectionHandlers) => Promise<{ connection: AsrConnection; logId?: string }>

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
  /** Chunks sent per tick; above 1 lets the stream catch up after a reconnect. */
  maxChunksPerTick: number
  tickMs: number
  finalTimeoutMs: number
  /** Disables the internal timer so tests can drive tick() directly. */
  manualTicks?: boolean
}

const DEFAULTS: AsrOptions = {
  ringSeconds: 180,
  chunkMs: 200,
  maxChunksPerTick: 3,
  tickMs: 100,
  finalTimeoutMs: 8000,
}

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000]

interface RawUtterance {
  text?: unknown
  start_time?: unknown
  end_time?: unknown
  definite?: unknown
  words?: { start_time?: unknown }[]
}

/** The first utterance of a connection arrives without start_time; fall back to its first word, then the previous utterance. */
function startOf(item: RawUtterance, previousEnd: number): number {
  const direct = Number(item.start_time)
  if (item.start_time !== undefined && Number.isFinite(direct)) return direct
  const word = Number(Array.isArray(item.words) ? item.words[0]?.start_time : undefined)
  return Number.isFinite(word) ? word : previousEnd
}

export function utterancesOf(data: unknown): RawUtterance[] {
  if (!data || typeof data !== "object") return []
  const result = (data as { result?: unknown }).result
  const list = Array.isArray(result) ? result.flatMap((r) => (r as { utterances?: unknown }).utterances ?? []) : (result as { utterances?: unknown } | undefined)?.utterances
  return Array.isArray(list) ? list.filter((u): u is RawUtterance => !!u && typeof u === "object") : []
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

  private readonly connect: AsrConnect | null
  private readonly events: AsrEvents

  constructor(connect: AsrConnect | null, events: AsrEvents, options: Partial<AsrOptions> = {}) {
    this.connect = connect
    this.events = events
    this.options = { ...DEFAULTS, ...options }
    this.ring = new PcmRing(this.options.ringSeconds * ASR_RATE)
    this.chunk = (this.options.chunkMs / 1000) * ASR_RATE
    this.state = connect ? "idle" : "disabled"
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

  /** Starts a recording run at the given timeline position. */
  begin(positionMs: number): void {
    const position = msToSamples(positionMs)
    if (this.ring.end !== position) this.ring.seek(position)
    this.running = true
    this.ending = false
    this.cursor = position
    this.retryIndex = 0
    if (!this.options.manualTicks) this.tickTimer = window.setInterval(() => this.tick(), this.options.tickMs)
    if (this.connect) void this.open("connecting")
  }

  push(samples: Int16Array): void {
    if (!this.running) return
    this.ring.push(samples)
    if (this.cursor < this.ring.start) {
      this.emitGap(this.cursor, this.ring.start, "网络中断超过缓冲时长，该时段未能转写")
      this.cursor = this.ring.start
    }
  }

  tick(): void {
    if (this.state !== "live" || !this.connection) return
    for (let i = 0; i < this.options.maxChunksPerTick && this.ring.end - this.cursor >= this.chunk; i++) {
      this.send(this.chunk, false)
    }
  }

  /** Ends the current run: flushes audio, waits for final results, records untranscribed audio as gaps. */
  async end(): Promise<void> {
    if (!this.running) return
    this.ending = true
    this.clearRetry()
    if (this.tickTimer) window.clearInterval(this.tickTimer)
    this.tickTimer = undefined
    if (this.connecting) await this.connecting
    if (this.state === "live" && this.connection) {
      while (this.ring.end - this.cursor > 0) this.send(Math.min(this.chunk, this.ring.end - this.cursor), false)
      const done = new Promise<void>((resolve) => {
        this.finalWaiter = resolve
        window.setTimeout(resolve, this.options.finalTimeoutMs)
      })
      try {
        this.connection.sendAudio(new Int16Array(0), true)
        await done
      } catch {
        // The socket closed while finishing; remaining interims are committed below.
      }
      this.finalWaiter = undefined
      this.dropConnection()
    }
    for (const u of this.interims) this.acceptFinal(u)
    this.setInterims([])
    if (this.cursor < this.ring.end) {
      const reason = this.connect ? "ASR 未连接，该时段未能转写" : "未配置语音识别，该时段未转写"
      this.emitGap(this.cursor, this.ring.end, reason)
      this.cursor = this.ring.end
    }
    this.running = false
    this.ending = false
    this.setState(this.connect ? "idle" : "disabled")
  }

  /** Immediately retries a failed or waiting connection. */
  retryNow(): void {
    if (!this.running || !this.connect || this.state === "live" || this.connecting) return
    this.clearRetry()
    this.retryIndex = 0
    void this.open("reconnecting")
  }

  dispose(): void {
    this.running = false
    this.clearRetry()
    if (this.tickTimer) window.clearInterval(this.tickTimer)
    this.dropConnection()
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
    const base = this.cursor
    const attempt = (async () => {
      try {
        const { connection, logId } = await this.connect!({
          onResult: (data, last) => {
            if (generation === this.generation) this.handleResult(data, last, base)
          },
          onClose: (error) => {
            if (generation === this.generation) this.handleDrop(error)
          },
        })
        if (generation !== this.generation || !this.running) {
          connection.close()
          return
        }
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

  private handleResult(data: unknown, last: boolean, base: number): void {
    const baseMs = samplesToMs(base)
    const interims: Utterance[] = []
    const raw = utterancesOf(data)
    let previousEnd = 0
    for (const item of raw) {
      const text = typeof item.text === "string" ? item.text.trim() : ""
      const start = startOf(item, previousEnd)
      const end = Number(item.end_time)
      if (Number.isFinite(end)) previousEnd = end
      if (!text) continue
      const u: Utterance = { startMs: baseMs + start, endMs: baseMs + (Number.isFinite(end) && end >= start ? end : start), text }
      if (item.definite === true) this.acceptFinal(u)
      else interims.push(u)
    }
    if (raw.length > 0 || last) this.setInterims(interims.filter((u) => !this.finalKeys.has(Math.round(u.startMs))))
    if (last) this.finalWaiter?.()
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

  private emitGap(from: number, to: number, reason: string): void {
    if (to <= from) return
    this.events.onGap({ startMs: samplesToMs(from), endMs: samplesToMs(to), reason })
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
