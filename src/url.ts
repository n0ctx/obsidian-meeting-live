/** Host of a URL, or an empty string when it is not one. */
export function hostOf(url: string): string {
  try {
    return new URL(url.trim()).host
  } catch {
    return ""
  }
}

/** Whether a host (with or without port) is this machine or a private network address, where a key is not needed. */
export function isLocalHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "").toLowerCase()
  return name === "localhost" || name === "[::1]" || name.endsWith(".local") || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(name)
}
