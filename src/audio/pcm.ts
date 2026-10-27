export const ASR_RATE = 16000

/** Streaming mono downmix + resample to 16 kHz PCM16 for ASR. Keeps fractional state across chunks. */
export class AsrResampler {
  private readonly step: number
  private readonly integerRatio: number
  private position = 0
  private carry: number[] = []
  private previous = 0

  constructor(inputRate: number) {
    this.step = inputRate / ASR_RATE
    this.integerRatio = Number.isInteger(this.step) ? this.step : 0
  }

  process(channels: Float32Array[]): Int16Array {
    const frames = channels[0]?.length ?? 0
    const mono = new Float32Array(frames)
    for (const channel of channels) for (let i = 0; i < frames; i++) mono[i] += channel[i] / channels.length
    return this.integerRatio ? this.decimate(mono) : this.interpolate(mono)
  }

  private decimate(mono: Float32Array): Int16Array {
    const n = this.integerRatio
    const input = this.carry.length ? Float32Array.from([...this.carry, ...mono]) : mono
    const count = Math.floor(input.length / n)
    const out = new Int16Array(count)
    for (let i = 0; i < count; i++) {
      let sum = 0
      for (let j = 0; j < n; j++) sum += input[i * n + j]
      out[i] = toInt16(sum / n)
    }
    this.carry = Array.from(input.subarray(count * n))
    return out
  }

  private interpolate(mono: Float32Array): Int16Array {
    const out: number[] = []
    // Light low-pass before linear interpolation to limit aliasing.
    const filtered = new Float32Array(mono.length)
    for (let i = 0; i < mono.length; i++) {
      const prev = i > 0 ? mono[i - 1] : this.previous
      filtered[i] = (prev + mono[i]) / 2
    }
    if (mono.length) this.previous = mono[mono.length - 1]
    while (this.position < filtered.length - 1) {
      const left = Math.floor(this.position)
      const weight = this.position - left
      out.push(toInt16(filtered[left] * (1 - weight) + filtered[left + 1] * weight))
      this.position += this.step
    }
    this.position -= filtered.length
    if (this.position < -1) this.position = 0
    return Int16Array.from(out)
  }
}

function toInt16(sample: number): number {
  const s = Math.max(-1, Math.min(1, sample))
  return s < 0 ? s * 0x8000 : s * 0x7fff
}

/** Fixed-capacity buffer of PCM16 samples addressed by absolute sample position. */
export class PcmRing {
  private readonly data: Int16Array
  private total = 0
  private floor = 0

  readonly capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
    this.data = new Int16Array(capacity)
  }

  get end(): number {
    return this.total
  }

  get start(): number {
    return Math.max(this.floor, this.total - this.capacity)
  }

  push(samples: Int16Array): void {
    for (let i = 0; i < samples.length; i++) this.data[(this.total + i) % this.capacity] = samples[i]
    this.total += samples.length
  }

  /** Moves the write position forward without data, e.g. when a meeting continues after reload. */
  seek(position: number): void {
    this.total = position
    this.floor = position
  }

  read(from: number, count: number): Int16Array {
    const begin = Math.max(from, this.start)
    const stop = Math.min(begin + count, this.total)
    const out = new Int16Array(Math.max(0, stop - begin))
    for (let i = 0; i < out.length; i++) out[i] = this.data[(begin + i) % this.capacity]
    return out
  }
}

export function samplesToMs(samples: number): number {
  return (samples / ASR_RATE) * 1000
}

export function msToSamples(ms: number): number {
  return Math.round((ms / 1000) * ASR_RATE)
}
