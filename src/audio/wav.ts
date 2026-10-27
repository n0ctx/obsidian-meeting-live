// 16-bit PCM WAV with a header that is rewritten as data grows, so the file stays playable
// at any moment and can be repaired from its byte length after a crash.

export const WAV_HEADER_BYTES = 44

export function wavHeader(sampleRate: number, channels: number, dataBytes: number): Uint8Array {
  const header = new Uint8Array(WAV_HEADER_BYTES)
  const view = new DataView(header.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) header[offset + i] = text.charCodeAt(i)
  }
  ascii(0, "RIFF")
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, "WAVE")
  ascii(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  ascii(36, "data")
  view.setUint32(40, dataBytes, true)
  return header
}

/** Interleaves planar float channels into little-endian PCM16. */
export function interleavePcm16(channels: Float32Array[]): Uint8Array {
  const frames = channels[0]?.length ?? 0
  const out = new Uint8Array(frames * channels.length * 2)
  const view = new DataView(out.buffer)
  let offset = 0
  for (let i = 0; i < frames; i++) {
    for (const channel of channels) {
      const s = Math.max(-1, Math.min(1, channel[i]))
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      offset += 2
    }
  }
  return out
}

export interface WavRepair {
  header: Uint8Array
  /** Data length rounded down to whole frames. */
  dataBytes: number
  durationMs: number
}

export function repairWav(fileBytes: number, sampleRate: number, channels: number): WavRepair {
  const frameBytes = channels * 2
  const dataBytes = Math.max(0, Math.floor((fileBytes - WAV_HEADER_BYTES) / frameBytes) * frameBytes)
  return {
    header: wavHeader(sampleRate, channels, dataBytes),
    dataBytes,
    durationMs: (dataBytes / frameBytes / sampleRate) * 1000,
  }
}
