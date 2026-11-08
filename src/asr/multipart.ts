// multipart/form-data bodies, built by hand because requestUrl takes bytes and a content type, not a FormData.

export interface MultipartForm {
  body: ArrayBuffer
  contentType: string
}

/** Builds a multipart/form-data body by hand, since requestUrl takes bytes and a content type, not a FormData. */
export function buildMultipart(fields: [string, string][], file: { name: string; mime: string; data: Uint8Array }, boundary = `----MeetingLive${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`): MultipartForm {
  const encoder = new TextEncoder()
  const head = encoder.encode(fields.map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("") + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`)
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`)
  const body = new Uint8Array(head.length + file.data.length + tail.length)
  body.set(head, 0)
  body.set(file.data, head.length)
  body.set(tail, head.length + file.data.length)
  return { body: body.buffer, contentType: `multipart/form-data; boundary=${boundary}` }
}
