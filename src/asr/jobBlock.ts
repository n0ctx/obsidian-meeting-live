// The temporary in-note status bar is a `meeting-live-job` code block; the result replaces it in place.

export const JOB_LANGUAGE = "meeting-live-job"

export function newJobId(): string {
  return `j-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export function jobBlock(id: string, fileName: string): string {
  return `\`\`\`${JOB_LANGUAGE}\nid: ${id}\nfile: ${fileName.replace(/\n/g, " ")}\n\`\`\``
}

export function parseJobBlock(source: string): { id?: string; file?: string } {
  return {
    id: /^\s*id\s*:\s*(j-[\w-]+)\s*$/m.exec(source)?.[1],
    file: /^\s*file\s*:\s*(.+?)\s*$/m.exec(source)?.[1],
  }
}

function blockPattern(id: string): RegExp {
  return new RegExp(`^(\`{3,}|~{3,})${JOB_LANGUAGE}[^\\n]*\\n(?:(?!\\1)[^\\n]*\\n)*?id:\\s*${id.replace(/[-]/g, "\\-")}\\s*\\n[\\s\\S]*?^\\1[ \\t]*$\\n?`, "m")
}

export function hasJobBlock(content: string, id: string): boolean {
  return blockPattern(id).test(content)
}

/** Appends the status block on its own paragraph at the end of the note. */
export function appendJobBlock(content: string, id: string, fileName: string): string {
  const block = jobBlock(id, fileName)
  return content.trim() ? `${content.trimEnd()}\n\n${block}\n` : `${block}\n`
}

/**
 * Replaces the status block with the result, or appends the result when the block was removed.
 * `heading` is prepended when the note has no other content.
 */
export function placeJobResult(content: string, id: string, result: string, heading: string): string {
  const pattern = blockPattern(id)
  const rest = content.replace(pattern, "")
  const body = rest.trim() ? result : `${heading}\n\n${result}`
  if (pattern.test(content)) return rest.trim() ? content.replace(pattern, `${body.trimEnd()}\n`) : `${body.trimEnd()}\n`
  return rest.trim() ? `${content.trimEnd()}\n\n${body.trimEnd()}\n` : `${body.trimEnd()}\n`
}

export function removeJobBlock(content: string, id: string): string {
  return content.replace(blockPattern(id), "").replace(/\n{3,}/g, "\n\n")
}
