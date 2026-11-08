export const OPENAI_COMPAT_ID = "openai-compat"
export const OPENAI_COMPAT_NAME = "OpenAI 兼容接口"

/** OpenAI documents 25 MB per upload (https://developers.openai.com/api/docs/guides/speech-to-text); Groq's free tier says the same, https://console.groq.com/docs/speech-to-text. */
export const OPENAI_FILE_LIMIT = 25 * 1024 * 1024
