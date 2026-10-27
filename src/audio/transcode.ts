import { DIRECT_FORMATS } from "../asr/fileAsr.ts"
import { OggOpusMuxer, opusHead } from "./ogg.ts"

/** Above this the base64 request body (×4/3) risks HTTP 413; such files are compressed first. */
export const DIRECT_UPLOAD_LIMIT = 60 * 1024 * 1024
const RATE = 16000
const BITRATE = 32_000

export interface PreparedAudio {
  base64: string
  format: string
  /** True when the file was re-encoded locally before upload. */
  transcoded: boolean
  bytes: number
}

/** Uploads the original file when the service accepts it; otherwise compresses to 16 kHz mono Opus. */
export async function prepareAudio(data: Uint8Array, extension: string): Promise<PreparedAudio> {
  const format = DIRECT_FORMATS[extension.toLowerCase()]
  if (format && data.length <= DIRECT_UPLOAD_LIMIT) {
    return { base64: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64"), format, transcoded: false, bytes: data.length }
  }
  const ogg = await toSpeechOpus(data)
  return { base64: Buffer.from(ogg).toString("base64"), format: "ogg", transcoded: true, bytes: ogg.length }
}

async function toSpeechOpus(data: Uint8Array): Promise<Uint8Array> {
  let decoded: AudioBuffer
  try {
    decoded = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(data.slice().buffer)
  } catch {
    throw new Error("无法解码这个音频文件，请先转换为 mp3、m4a 或 wav")
  }
  const length = decoded.length
  const mono = new Float32Array(length)
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const channel = decoded.getChannelData(c)
    for (let i = 0; i < length; i++) mono[i] += channel[i] / decoded.numberOfChannels
  }

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
  for (let offset = 0; offset < length && !failure; offset += RATE) {
    const frames = Math.min(RATE, length - offset)
    const audio = new AudioData({ format: "f32-planar", sampleRate: RATE, numberOfFrames: frames, numberOfChannels: 1, timestamp: (offset / RATE) * 1_000_000, data: mono.subarray(offset, offset + frames) })
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
