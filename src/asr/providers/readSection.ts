/** Reads one provider's stored settings: every key present with the right type is kept, anything else falls back to the default. */
export function readSection<T extends object>(defaults: T, source: unknown): T {
  const stored = source && typeof source === "object" ? (source as Record<string, unknown>) : {}
  const result = { ...defaults }
  for (const key of Object.keys(defaults) as (keyof T & string)[]) {
    if (typeof stored[key] === typeof defaults[key]) result[key] = stored[key] as T[typeof key]
  }
  return result
}
