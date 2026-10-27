import { promises as fs } from "node:fs"
import { OPUS_DEFAULT_PRESKIP, OggOpusMuxer, oggDurationMs, opusHead, scanOgg } from "./ogg.ts"
import { WAV_HEADER_BYTES, interleavePcm16, repairWav, wavHeader } from "./wav.ts"
import type { AudioFormat } from "../meeting/types.ts"

const FLUSH_MS = 1000

export function opusBitrate(channels: number): number {
  return channels > 1 ? 160_000 : 96_000
}

export async function opusSupported(sampleRate: number, channels: number): Promise<boolean> {
  if (typeof AudioEncoder === "undefined") return false
  try {
    const result = await AudioEncoder.isConfigSupported({ codec: "opus", sampleRate, numberOfChannels: channels, bitrate: opusBitrate(channels) })
    return result.supported === true
  } catch {
    return false
  }
}

/**
 * Writes one audio segment incrementally. Data reaches disk at least once per second,
 * and the file is valid after every write, so a crash loses at most the last second.
 */
export class SegmentRecorder {
  private handle: fs.FileHandle
  private chain: Promise<unknown> = Promise.resolve()
  private pending: Uint8Array[] = []
  private timer: number
  private dataBytes = 0
  private position = 0
  private encoder: AudioEncoder | undefined
  private muxer: OggOpusMuxer | undefined
  private timestampUs = 0
  private closed = false
  private readonly format: AudioFormat
  private readonly sampleRate: number
  private readonly channels: number
  private readonly onError: (error: Error) => void

  private constructor(handle: fs.FileHandle, format: AudioFormat, sampleRate: number, channels: number, onError: (error: Error) => void) {
    this.handle = handle
    this.format = format
    this.sampleRate = sampleRate
    this.channels = channels
    this.onError = onError
    this.timer = window.setInterval(() => void this.flush(), FLUSH_MS)
  }

  static async create(fullPath: string, format: AudioFormat, sampleRate: number, channels: number, onError: (error: Error) => void): Promise<SegmentRecorder> {
    const handle = await fs.open(fullPath, "wx")
    const recorder = new SegmentRecorder(handle, format, sampleRate, channels, onError)
    if (format === "wav") recorder.pending.push(wavHeader(sampleRate, channels, 0))
    else recorder.startEncoder()
    return recorder
  }

  private startEncoder(): void {
    let headerWritten = false
    this.encoder = new AudioEncoder({
      output: (chunk, metadata) => {
        if (!headerWritten) {
          headerWritten = true
          const description = metadata?.decoderConfig?.description
          let head = opusHead(this.channels, this.sampleRate, OPUS_DEFAULT_PRESKIP)
          if (description) {
            const bytes = ArrayBuffer.isView(description) ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength) : new Uint8Array(description)
            if (new TextDecoder().decode(bytes.subarray(0, 8)) === "OpusHead") head = bytes.slice()
          }
          this.muxer = new OggOpusMuxer((Math.random() * 0xffffffff) >>> 0, head)
          this.pending.push(this.muxer.headers())
        }
        const packet = new Uint8Array(chunk.byteLength)
        chunk.copyTo(packet)
        const samples = chunk.duration ? (chunk.duration * 48) / 1000 : 960
        const page = this.muxer!.addPacket(packet, samples)
        if (page) this.pending.push(page)
      },
      error: (error) => this.onError(new Error(`Opus 编码失败：${error.message}`)),
    })
    this.encoder.configure({ codec: "opus", sampleRate: this.sampleRate, numberOfChannels: this.channels, bitrate: opusBitrate(this.channels) })
  }

  write(channels: Float32Array[]): void {
    if (this.closed) return
    const frames = channels[0]?.length ?? 0
    if (frames === 0) return
    if (this.format === "wav") {
      const pcm = interleavePcm16(channels)
      this.pending.push(pcm)
      this.dataBytes += pcm.length
      return
    }
    const planar = new Float32Array(frames * this.channels)
    channels.forEach((c, i) => planar.set(c, i * frames))
    const data = new AudioData({ format: "f32-planar", sampleRate: this.sampleRate, numberOfFrames: frames, numberOfChannels: this.channels, timestamp: this.timestampUs, data: planar })
    this.timestampUs += (frames / this.sampleRate) * 1_000_000
    try {
      this.encoder?.encode(data)
    } finally {
      data.close()
    }
  }

  private flush(): Promise<unknown> {
    if (this.muxer) {
      const page = this.muxer.flush(false)
      if (page) this.pending.push(page)
    }
    if (this.pending.length === 0) return this.chain
    const chunks = this.pending
    this.pending = []
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const buffer = Buffer.allocUnsafe(total)
    let offset = 0
    for (const c of chunks) {
      buffer.set(c, offset)
      offset += c.length
    }
    const dataBytes = this.dataBytes
    const position = this.position
    this.position += total
    this.chain = this.chain
      .then(async () => {
        await this.handle.write(buffer, 0, total, position)
        if (this.format === "wav") await this.handle.write(wavHeader(this.sampleRate, this.channels, dataBytes), 0, WAV_HEADER_BYTES, 0)
      })
      .catch((error: Error) => this.onError(new Error(`录音写入失败：${error.message}`)))
    return this.chain
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    window.clearInterval(this.timer)
    if (this.encoder && this.encoder.state === "configured") {
      try {
        await this.encoder.flush()
      } catch {
        // Encoder errors are already reported through onError.
      }
      this.encoder.close()
    }
    if (this.muxer) {
      const last = this.muxer.flush(true)
      if (last) this.pending.push(last)
    }
    await this.flush()
    await this.handle.sync().catch(() => undefined)
    await this.handle.close()
  }
}

/** Repairs a segment left behind by a crash and returns its playable duration. */
export async function repairSegment(fullPath: string, format: AudioFormat, sampleRate: number, channels: number): Promise<number> {
  const data = await fs.readFile(fullPath)
  if (format === "wav") {
    const repair = repairWav(data.length, sampleRate, channels)
    const handle = await fs.open(fullPath, "r+")
    try {
      await handle.write(repair.header, 0, WAV_HEADER_BYTES, 0)
      await handle.truncate(WAV_HEADER_BYTES + repair.dataBytes)
    } finally {
      await handle.close()
    }
    return repair.durationMs
  }
  const scan = scanOgg(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  if (scan.validLength < data.length) await fs.truncate(fullPath, scan.validLength)
  return oggDurationMs(scan)
}
