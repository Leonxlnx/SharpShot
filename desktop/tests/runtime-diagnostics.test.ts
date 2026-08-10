import { describe, expect, it, vi } from "vitest"
import {
  installAppProcessDiagnostics,
  safeErrorRecord,
} from "../src/main/runtime-diagnostics.js"

describe("runtime diagnostics", () => {
  it("records every documented child-process-gone field without opaque Electron objects", () => {
    let listener: ((event: unknown, details: unknown) => void) | undefined
    const fakeApp = {
      on(event: string, next: (event: unknown, details: unknown) => void): unknown {
        expect(event).toBe("child-process-gone")
        listener = next
        return this
      },
    }
    const report = vi.fn()
    installAppProcessDiagnostics(
      fakeApp as unknown as Parameters<typeof installAppProcessDiagnostics>[0],
      report,
    )

    listener?.({ privatePath: "C:\\Users\\Alice" }, {
      type: "GPU",
      reason: "launch-failed",
      exitCode: -1_073_741_515,
      serviceName: "gpu-service",
      name: "GPU Process",
    })

    expect(report).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith({
      event: "child-process-gone",
      processType: "GPU",
      reason: "launch-failed",
      exitCode: -1_073_741_515,
      exitCodeHex: "0xC0000135",
      serviceName: "gpu-service",
      name: "GPU Process",
    })
  })

  it("redacts local paths and bounds opaque error text", () => {
    const error = Object.assign(
      new Error(`Could not read C:\\Users\\Alice\\secret.txt '${"x".repeat(1_000)}'`),
      { code: "E_PATH" },
    )

    const record = safeErrorRecord(error)

    expect(record.errorMessage).not.toContain("Alice")
    expect(record.errorMessage.length).toBeLessThanOrEqual(512)
    expect(record.errorCode).toBe("E_PATH")
  })
})
