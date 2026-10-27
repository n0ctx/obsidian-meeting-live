// Binary frame codec for the Volcengine big-model streaming ASR (v3 WebSocket).
// Adapted from obsidian-voice2text by chenxuan (MIT), see THIRD_PARTY_NOTICES.md.
import zlib from "node:zlib"

const HEADER = 0x11
export const MSG_FULL_CLIENT_REQUEST = 0x1
export const MSG_AUDIO_ONLY = 0x2
export const MSG_FULL_SERVER_RESPONSE = 0x9
export const MSG_ERROR = 0xf
const SERIAL_NONE = 0x0
const SERIAL_JSON = 0x1
const GZIP = 0x1

export type ServerFrame =
  | { kind: "result"; last: boolean; data: unknown }
  | { kind: "error"; code: number; message: string }

function frame(type: number, flags: number, serialization: number, payload: Buffer): Buffer {
  const body = zlib.gzipSync(payload)
  const head = Buffer.from([HEADER, (type << 4) | flags, (serialization << 4) | GZIP, 0, 0, 0, 0, 0])
  head.writeUInt32BE(body.length, 4)
  return Buffer.concat([head, body])
}

export function encodeFullRequest(request: unknown): Buffer {
  return frame(MSG_FULL_CLIENT_REQUEST, 0x0, SERIAL_JSON, Buffer.from(JSON.stringify(request), "utf8"))
}

export function encodeAudio(pcm: Buffer, last: boolean): Buffer {
  return frame(MSG_AUDIO_ONLY, last ? 0x2 : 0x0, SERIAL_NONE, pcm)
}

export function decodeServerFrame(message: Buffer): ServerFrame {
  if (message.length < 8) throw new Error("火山引擎返回了无效的数据帧")
  const headerSize = (message[0] & 0x0f) * 4
  const type = message[1] >> 4
  const flags = message[1] & 0x0f
  const serialization = message[2] >> 4
  const compression = message[2] & 0x0f
  let offset = headerSize
  const unpack = (payload: Buffer) => (compression === GZIP ? zlib.gunzipSync(payload) : payload)

  if (type === MSG_ERROR) {
    const code = message.readUInt32BE(offset)
    const size = message.readUInt32BE(offset + 4)
    const payload = message.subarray(offset + 8, offset + 8 + size)
    let text: string
    try {
      text = unpack(payload).toString("utf8")
    } catch {
      text = payload.toString("utf8")
    }
    return { kind: "error", code, message: text }
  }

  if (flags & 0x1) offset += 4
  if (offset + 4 > message.length) throw new Error("火山引擎响应缺少数据长度")
  const size = message.readUInt32BE(offset)
  offset += 4
  const body = unpack(message.subarray(offset, offset + size))
  const data: unknown = serialization === SERIAL_JSON && body.length > 0 ? JSON.parse(body.toString("utf8")) : null
  return { kind: "result", last: (flags & 0x2) !== 0, data }
}

/** Server-side encoder, used by the local mock server in tests and dev tooling. */
export function encodeServerResult(sequence: number, data: unknown, last: boolean): Buffer {
  const body = zlib.gzipSync(Buffer.from(JSON.stringify(data), "utf8"))
  const head = Buffer.alloc(12)
  head[0] = HEADER
  head[1] = (MSG_FULL_SERVER_RESPONSE << 4) | (last ? 0x3 : 0x1)
  head[2] = (SERIAL_JSON << 4) | GZIP
  head.writeInt32BE(last ? -sequence : sequence, 4)
  head.writeUInt32BE(body.length, 8)
  return Buffer.concat([head, body])
}

export function encodeServerError(code: number, message: string): Buffer {
  const text = Buffer.from(message, "utf8")
  const head = Buffer.alloc(12)
  head[0] = HEADER
  head[1] = MSG_ERROR << 4
  head[2] = SERIAL_JSON << 4
  head.writeUInt32BE(code, 4)
  head.writeUInt32BE(text.length, 8)
  return Buffer.concat([head, text])
}

/** Parses a client frame; used by the mock server. */
export function decodeClientFrame(message: Buffer): { type: number; last: boolean; payload: Buffer } {
  const type = message[1] >> 4
  const flags = message[1] & 0x0f
  const compression = message[2] & 0x0f
  const size = message.readUInt32BE(4)
  const raw = message.subarray(8, 8 + size)
  return { type, last: (flags & 0x2) !== 0, payload: compression === GZIP ? zlib.gunzipSync(raw) : raw }
}
