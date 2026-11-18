import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  dialog: {},
  globalShortcut: {},
  ipcMain: {},
  shell: {},
}))

import { publicError } from "../src/main/ipc.js"
import { MediaProbeError } from "../src/main/media-probe.js"
import { redactLocalPaths } from "../src/main/path-redaction.js"

describe("local path redaction", () => {
  it.each([
    "C:\\Users\\Alice\\Private\\clip.mp4",
    "C:\\Users\\O'Brien\\Private\\clip.mp4",
    "\\\\media-server\\private-share\\clip.mp4",
    "file:///C:/Users/Alice/Private/clip.mp4",
    "file://media-server/private-share/clip.mp4",
  ])("redacts %s", (path) => {
    const message = redactLocalPaths(`ffprobe failed: ${path}`)

    expect(message).toBe("ffprobe failed: <redacted-path>")
    expect(message).not.toContain("Alice")
    expect(message).not.toContain("media-server")
  })

  it("redacts and bounds a probe failure without changing its public error code", () => {
    const failure = publicError(
      new MediaProbeError(`ffprobe failed: C:\\Users\\Alice\\Private\\clip.mp4 '${"x".repeat(1_000)}'`),
    )

    expect(failure.code).toBe("MEDIA_PROBE_FAILED")
    expect(failure.message).not.toContain("Alice")
    expect(failure.message.length).toBeLessThanOrEqual(512)
  })
})
