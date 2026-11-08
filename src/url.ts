/** Host of a URL, or an empty string when it is not one. */
export function hostOf(url: string): string {
  try {
    return new URL(url.trim()).host
  } catch {
    return ""
  }
}
