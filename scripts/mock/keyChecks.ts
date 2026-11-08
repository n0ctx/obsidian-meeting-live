// The free calls the settings page makes to check a pasted key and to list models, as the services answer them.
// The key "bad" is refused everywhere with the status each service uses (401); anything else is accepted.
import type { IncomingMessage, ServerResponse } from "node:http"

/** Answers with JSON; true, so a route can `return answer(...)` to say it handled the request. */
const answer = (res: ServerResponse, status: number, body: unknown): true => {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(body))
  return true
}

const bearer = (req: IncomingMessage) => req.headers.authorization?.replace(/^Bearer /, "") ?? ""

/** Models in the OpenAI list shape. */
export const MOCK_MODELS = ["mock-chat-large", "mock-chat-small"]

/** GET /v1/models (OpenAI and everything compatible), GET /api/v1/models (DashScope's own list), Deepgram's auth test and AssemblyAI's transcript list. */
export function keyCheckRoutes(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "GET" || !req.url) return false
  const path = new URL(req.url, "http://mock").pathname
  if (path === "/api/v1/models") {
    if (bearer(req) === "bad") return answer(res, 401, { code: "InvalidApiKey", message: "Invalid API-key provided." })
    return answer(res, 200, { output: { total: 2, page_no: 1, page_size: 100, models: MOCK_MODELS.map((model) => ({ model })) } })
  }
  if (path.endsWith("/v1/models")) {
    if (bearer(req) === "bad") return answer(res, 401, { error: { message: "Incorrect API key provided: bad", type: "invalid_request_error" } })
    return answer(res, 200, { object: "list", data: MOCK_MODELS.map((id) => ({ id, object: "model", owned_by: "mock" })) })
  }
  if (path === "/v1/auth/token") {
    if (req.headers.authorization?.replace(/^Token /, "") === "bad") return answer(res, 401, { err_code: "INVALID_AUTH", err_msg: "Invalid credentials." })
    return answer(res, 200, { accessor: "mock", scopes: ["member"] })
  }
  if (path === "/v2/transcript") {
    if (req.headers.authorization === "bad") return answer(res, 401, { error: "Authentication error, API token missing/invalid" })
    return answer(res, 200, { transcripts: [], page_details: { limit: 1 } })
  }
  return false
}
