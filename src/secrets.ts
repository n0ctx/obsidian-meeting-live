/** The part of Obsidian's SecretStorage the plugin reads. Secrets live there, never in data.json. */
export interface SecretReader {
  getSecret(id: string): string | null
}

export function readSecret(secrets: SecretReader, id: string): string {
  return id ? (secrets.getSecret(id) ?? "").trim() : ""
}
