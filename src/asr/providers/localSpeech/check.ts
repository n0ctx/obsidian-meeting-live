// The free check: GET <base>/models. No key is a bad key, without asking. A 401 is a bad key.
// No connection means the service is not running. Any other status is named, and the body is never shown.
import type { CheckResult } from "../../../accounts/check.ts"
import { t } from "../../../i18n/index.ts"
import type { HttpGet } from "../../../llm/client.ts"
import { hostOf } from "../../../url.ts"

/** Model ids from an OpenAI-shaped list, in the order the service listed them. Undefined when the body is not a list. */
export function speechModelIds(json: unknown): string[] | undefined {
  const data = json && typeof json === "object" ? (json as { data?: unknown }).data : undefined
  if (!Array.isArray(data)) return undefined
  const ids = data
    .map((entry) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id !== "")
  return [...new Set(ids)]
}

export function modelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "")
  return /\/models$/.test(trimmed) ? trimmed : `${trimmed}/models`
}

export async function checkLocalSpeech(baseUrl: string, key: string, get: HttpGet): Promise<CheckResult> {
  const base = baseUrl.trim()
  if (!base || !hostOf(base)) return { state: "failed", message: t("check.badAddress") }
  if (!key.trim()) return { state: "failed", message: t("localSpeech.check.key") }
  try {
    const response = await get(modelsUrl(base), { Authorization: `Bearer ${key}` })
    if (response.status === 401 || response.status === 403) return { state: "failed", message: t("localSpeech.check.key") }
    if (response.status < 200 || response.status >= 300) return { state: "failed", message: t("check.status", response.status) }
    let json: unknown
    try {
      json = JSON.parse(response.text)
    } catch {
      return { state: "failed", message: t("localSpeech.check.down") }
    }
    const models = speechModelIds(json)
    if (!models?.length) return { state: "failed", message: t("localSpeech.check.noModel") }
    return { state: "ok", models, options: { model: models[0] } }
  } catch {
    return { state: "failed", message: t("localSpeech.check.down") }
  }
}
