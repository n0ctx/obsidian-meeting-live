import { cutPoints } from "./chunking.ts"
import { OggOpusMuxer, opusHead } from "./ogg.ts"

/** Other formats Chromium can decode, transcoded locally before upload. */
export const DECODABLE_EXTENSIONS = ["aac", "flac", "webm", "mov", "3gp"]
const RATE = 16000
const BITRATE = 32_000

export interface PreparedAudio {
  data: Uint8Array
  format: string
  /** True when the file was re-encoded locally before upload. */
  transcoded: boolean
  bytes: number
}

/** One upload: the whole recording, or a stretch of it when it is too long for the service. */
export interface AudioChunk extends PreparedAudio {
  /** Where this piece starts in the recording. */
  offsetMs: number
  /** Length of the piece when it was cut here; 0 when the file went up as it is and its length is not known. */
  durationMs: number
}

export interface UploadLimits {
  /** Lower-case file extension → format name the service accepts as it is. */
  directFormats: Record<string, string>
  maxBytes: number
}

/** Pieces are cut to this share of the limit, leaving room for the request around the file. */
const CHUNK_FILL = 0.9
/** How far back from an even cut the quietest spot is looked for. */
const CUT_SLACK_S = 30
const MAX_SPLIT_ATTEMPTS = 6

/**
 * What to upload: the original file when the service accepts it, else 16 kHz mono Opus. A recording still over the limit
 * after that is cut into pieces under it, in order, each with its position in the recording.
 */
export async function prepareChunks(data: Uint8Array, extension: string, limits: UploadLimits): Promise<AudioChunk[]> {
  const format = limits.directFormats[extension.toLowerCase()]
  if (format && data.length <= limits.maxBytes) return [{ data, format, transcoded: false, bytes: data.length, offsetMs: 0, durationMs: 0 }]
  const mono = await decodeMono(data)
  const whole = await encodeSpeechOpus(mono, 0, mono.length)
  if (whole.length <= limits.maxBytes) return [opusChunk(whole, 0, mono.length)]
  return splitSpeechOpus(mono, whole.length, limits.maxBytes)
}

const opusChunk = (data: Uint8Array, from: number, to: number): AudioChunk => ({ data, format: "ogg", transcoded: true, bytes: data.length, offsetMs: (from / RATE) * 1000, durationMs: ((to - from) / RATE) * 1000 })

async function splitSpeechOpus(mono: Mono, wholeBytes: number, maxBytes: number): Promise<AudioChunk[]> {
  let size = Math.floor(mono.length * ((maxBytes * CHUNK_FILL) / wholeBytes))
  for (let attempt = 0; attempt < MAX_SPLIT_ATTEMPTS && size > RATE; attempt++) {
    const cuts = cutPoints(mono, size, Math.min(CUT_SLACK_S * RATE, Math.floor(size / 10)), RATE)
    const chunks: AudioChunk[] = []
    for (let i = 0; i + 1 < cuts.length; i++) chunks.push(opusChunk(await encodeSpeechOpus(mono, cuts[i], cuts[i + 1]), cuts[i], cuts[i + 1]))
    if (chunks.every((c) => c.bytes <= maxBytes)) return chunks
    // The encoder ran above its usual rate on some stretch: cut smaller.
    size = Math.floor(size * 0.8)
  }
  throw new Error("录音太长，无法切成符合服务大小限制的分段")
}

type Mono = Float32Array<ArrayBuffer>

async function decodeMono(data: Uint8Array): Promise<Mono> {
  let decoded: AudioBuffer
  try {
    decoded = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(data.slice().buffer)
  } catch {
    throw new Error("无法解码这个音频文件，请先转换为 mp3、m4a 或 wav")
  }
  const length = decoded.length
  const mono: Mono = new Float32Array(length)
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const channel = decoded.getChannelData(c)
    for (let i = 0; i < length; i++) mono[i] += channel[i] / decoded.numberOfChannels
  }
  return mono
}

/** Encodes `mono[from, to)` as an Ogg Opus file. */
async function encodeSpeechOpus(mono: Mono, from: number, to: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let muxer: OggOpusMuxer | undefined
  let failure: Error | undefined
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      if (!muxer) {
        const description = metadata?.decoderConfig?.description
        const bytes = description ? (ArrayBuffer.isView(description) ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength) : new Uint8Array(description)) : undefined
        const head = bytes && new TextDecoder().decode(bytes.subarray(0, 8)) === "OpusHead" ? bytes.slice() : opusHead(1, RATE, 312)
        muxer = new OggOpusMuxer((Math.random() * 0xffffffff) >>> 0, head)
        parts.push(muxer.headers())
      }
      const packet = new Uint8Array(chunk.byteLength)
      chunk.copyTo(packet)
      const page = muxer.addPacket(packet, chunk.duration ? (chunk.duration * 48) / 1000 : 960)
      if (page) parts.push(page)
    },
    error: (error) => (failure = new Error(`音频压缩失败：${error.message}`)),
  })
  encoder.configure({ codec: "opus", sampleRate: RATE, numberOfChannels: 1, bitrate: BITRATE })
  for (let offset = from; offset < to && !failure; offset += RATE) {
    const frames = Math.min(RATE, to - offset)
    const audio = new AudioData({ format: "f32-planar", sampleRate: RATE, numberOfFrames: frames, numberOfChannels: 1, timestamp: ((offset - from) / RATE) * 1_000_000, data: mono.subarray(offset, offset + frames) })
    encoder.encode(audio)
    audio.close()
    if (encoder.encodeQueueSize > 64) await new Promise((r) => window.setTimeout(r, 0))
  }
  await encoder.flush()
  encoder.close()
  if (failure) throw failure
  const last = muxer?.flush(true)
  if (last) parts.push(last)
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
