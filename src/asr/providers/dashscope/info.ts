import type { FileCapabilities, LiveCapabilities } from "../types.ts"

export const DASHSCOPE_ID = "dashscope"

export type DashScopeRegion = "cn" | "intl"

/**
 * The accounts and keys of the two regions are separate, so the region is the one choice a user makes besides the key.
 * These are the original hosts, which need only the key. The documentation recommends moving to per-workspace hosts
 * (`{WorkspaceId}.<region>.maas.aliyuncs.com`) and says the Beijing legacy host still works; for the international host it says
 * only that the workspace host replaces it (not confirmed that it still answers).
 *   https://www.alibabacloud.com/help/en/model-studio/websocket-for-paraformer-real-time-service  (Beijing: legacy host still works)
 *   https://www.alibabacloud.com/help/en/model-studio/fun-asr-realtime-websocket-api  (both regions, workspace hosts recommended)
 */
export const DASHSCOPE_REGIONS: Record<DashScopeRegion, { live: string; api: string }> = {
  cn: { live: "wss://dashscope.aliyuncs.com/api-ws/v1/inference", api: "https://dashscope.aliyuncs.com" },
  intl: { live: "wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference", api: "https://dashscope-intl.aliyuncs.com" },
}

export const isDashScopeRegion = (value: unknown): value is DashScopeRegion => value === "cn" || value === "intl"

/**
 * The meeting model the documentation names for continuous transcription (https://www.alibabacloud.com/help/en/model-studio/asr-model);
 * it takes inline hotwords. Fun-ASR (`fun-asr-realtime`) takes only a pre-created vocabulary id.
 */
export const DASHSCOPE_LIVE_MODEL = "qwen-audio-3.1-asr-flash-streaming"

/** Inline hotwords are documented for the Qwen-Audio streaming models only. */
export const takesInlineHotwords = (model: string): boolean => /^qwen-audio/i.test(model.trim())

/** Takes a language hint; speakers are not separated while streaming (the model table lists no live diarization). */
export const dashScopeLiveCapabilities = (model: string): LiveCapabilities => ({ hotwords: takesInlineHotwords(model), endWindow: false, language: true, diarization: false })

/** The file model that separates speakers and takes up to 12 hours (https://www.alibabacloud.com/help/en/model-studio/asr-model). */
export const DASHSCOPE_FILE_MODEL = "fun-asr"

/**
 * A file goes through temporary storage, which holds at most 1 GB (https://www.alibabacloud.com/help/en/model-studio/get-temporary-file-url);
 * the model's own limit is 2 GB. Speakers are separated for mono audio and the job takes one language hint. The documentation advises
 * keeping diarized recordings within 2 hours.
 */
export const DASHSCOPE_FILE_CAPABILITIES: FileCapabilities = { language: true, diarization: true, fileSizeLimit: 1024 * 1024 * 1024 }
