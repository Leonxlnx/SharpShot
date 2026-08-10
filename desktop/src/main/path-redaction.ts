const REDACTED_PATH = "<redacted-path>"

export function redactLocalPaths(value: string): string {
  return value
    .replace(/file:\/\/[^\r\n]*/gi, REDACTED_PATH)
    .replace(/[a-z]:[\\/][^\r\n]*/gi, REDACTED_PATH)
    .replace(/\\\\[^\\/\s]+[\\/][^\r\n]*/g, REDACTED_PATH)
}
