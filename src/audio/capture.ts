const WORKLET_NAME = "meeting-live-capture"
const WORKLET_SOURCE = `
class MeetingLiveCapture extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.channels = options.processorOptions.channels
    this.size = 2048
    this.reset()
  }
  reset() {
    this.buffers = Array.from({ length: this.channels }, () => new Float32Array(this.size))
    this.offset = 0
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const frames = input[0].length
    let read = 0
    while (read < frames) {
      const count = Math.min(this.size - this.offset, frames - read)
      for (let c = 0; c < this.channels; c++) {
        const source = input[Math.min(c, input.length - 1)]
        this.buffers[c].set(source.subarray(read, read + count), this.offset)
      }
      this.offset += count
      read += count
      if (this.offset === this.size) {
        const out = this.buffers
        this.port.postMessage(out, out.map((b) => b.buffer))
        this.reset()
      }
    }
    return true
  }
}
registerProcessor("${WORKLET_NAME}", MeetingLiveCapture)
`

export interface CaptureOptions {
  deviceId: string
  /** Browser echo cancellation / noise suppression / AGC. Off keeps the raw microphone signal. */
  voiceProcessing: boolean
}

export class AudioCapture {
  readonly sampleRate: number
  readonly channels: number
  readonly deviceLabel: string
  private readonly stream: MediaStream
  private readonly context: AudioContext
  private readonly nodes: AudioNode[]

  private constructor(stream: MediaStream, context: AudioContext, channels: number, nodes: AudioNode[]) {
    this.stream = stream
    this.context = context
    this.sampleRate = context.sampleRate
    this.channels = channels
    this.nodes = nodes
    this.deviceLabel = stream.getAudioTracks()[0]?.label ?? ""
  }

  static async open(options: CaptureOptions, onFrames: (channels: Float32Array[]) => void, onEnded: () => void): Promise<AudioCapture> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前环境无法访问麦克风")
    const processing = options.voiceProcessing
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
          echoCancellation: processing,
          noiseSuppression: processing,
          autoGainControl: processing,
          channelCount: { ideal: 2 },
        },
      })
    } catch (error) {
      const name = (error as DOMException)?.name
      if (name === "NotAllowedError") throw new Error("麦克风权限被拒绝。请在 系统设置 → 隐私与安全性 → 麦克风 中允许 Obsidian")
      if (name === "NotFoundError" || name === "OverconstrainedError") throw new Error("找不到所选麦克风，请在插件设置中重新选择输入设备")
      throw error
    }
    const track = stream.getAudioTracks()[0]
    const channels = Math.min(2, Math.max(1, track?.getSettings().channelCount ?? 1))
    const context = new AudioContext({ latencyHint: "playback" })
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }))
    try {
      await context.audioWorklet.addModule(url)
    } catch (error) {
      stream.getTracks().forEach((t) => t.stop())
      await context.close().catch(() => undefined)
      throw error
    } finally {
      URL.revokeObjectURL(url)
    }
    const source = context.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(context, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: channels,
      channelCountMode: "explicit",
      processorOptions: { channels },
    })
    node.port.onmessage = (event: MessageEvent<Float32Array[]>) => onFrames(event.data)
    const mute = context.createGain()
    mute.gain.value = 0
    source.connect(node)
    node.connect(mute)
    mute.connect(context.destination)
    track?.addEventListener("ended", onEnded)
    if (context.state === "suspended") await context.resume()
    return new AudioCapture(stream, context, channels, [source, node, mute])
  }

  async close(): Promise<void> {
    for (const node of this.nodes) {
      try {
        node.disconnect()
      } catch {
        // Already disconnected.
      }
    }
    const worklet = this.nodes.find((n): n is AudioWorkletNode => n instanceof AudioWorkletNode)
    if (worklet) worklet.port.onmessage = null
    this.stream.getTracks().forEach((t) => t.stop())
    await this.context.close().catch(() => undefined)
  }
}

export async function listInputDevices(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((d) => d.kind === "audioinput" && d.deviceId !== "default")
}
