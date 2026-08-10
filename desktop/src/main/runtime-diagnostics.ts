import type { App, RenderProcessGoneDetails } from "electron"
import { redactLocalPaths } from "./path-redaction.js"

export type RendererLoadTarget = "development-loopback" | "packaged-app"

export type RuntimeDiagnostic =
  | {
      event: "renderer-load-failed"
      target: RendererLoadTarget
      errorName: string
      errorMessage: string
      errorCode?: string | number
    }
  | {
      event: "render-process-gone"
      processType: "renderer"
      reason: RenderProcessGoneDetails["reason"]
      exitCode: number
      exitCodeHex: string
    }
  | {
      event: "child-process-gone"
      processType: ChildProcessGoneDetails["type"]
      reason: ChildProcessGoneDetails["reason"]
      exitCode: number
      exitCodeHex: string
      serviceName: string | null
      name: string | null
    }

export type RuntimeDiagnosticReporter = (diagnostic: RuntimeDiagnostic) => void

export interface SafeErrorRecord {
  errorName: string
  errorMessage: string
  errorCode?: string | number
}

interface ChildProcessGoneDetails {
  type: "Utility" | "Zygote" | "Sandbox helper" | "GPU" | "Pepper Plugin" | "Pepper Plugin Broker" | "Unknown"
  reason: RenderProcessGoneDetails["reason"]
  exitCode: number
  serviceName?: string
  name?: string
}

export function reportRuntimeDiagnostic(diagnostic: RuntimeDiagnostic): void {
  // Keep this record deliberately structured and path-free. Opaque Electron
  // event objects and Error stacks can contain usernames or installation paths.
  console.error("SharpShot runtime diagnostic.", diagnostic)
}

export function rendererLoadFailureDiagnostic(
  target: RendererLoadTarget,
  error: unknown,
): RuntimeDiagnostic {
  const safeError = safeErrorRecord(error)
  return {
    event: "renderer-load-failed",
    target,
    ...safeError,
  }
}

export function renderProcessGoneDiagnostic(details: RenderProcessGoneDetails): RuntimeDiagnostic {
  return {
    event: "render-process-gone",
    processType: "renderer",
    reason: details.reason,
    exitCode: details.exitCode,
    exitCodeHex: exitCodeHex(details.exitCode),
  }
}

export function installAppProcessDiagnostics(
  targetApp: Pick<App, "on">,
  report: RuntimeDiagnosticReporter = reportRuntimeDiagnostic,
): void {
  targetApp.on("child-process-gone", (_event, details) => {
    const safeDetails: ChildProcessGoneDetails = details
    const diagnostic: RuntimeDiagnostic = {
      event: "child-process-gone",
      processType: safeDetails.type,
      reason: safeDetails.reason,
      exitCode: safeDetails.exitCode,
      exitCodeHex: exitCodeHex(safeDetails.exitCode),
      serviceName: safeOptionalText(safeDetails.serviceName, 128),
      name: safeOptionalText(safeDetails.name, 128),
    }
    try {
      report(diagnostic)
    } catch (error) {
      console.error("SharpShot's runtime diagnostic reporter failed.", safeErrorRecord(error))
    }
  })
}

export function exitCodeHex(exitCode: number): string {
  return `0x${(exitCode >>> 0).toString(16).padStart(8, "0").toUpperCase()}`
}

export function safeErrorRecord(error: unknown): SafeErrorRecord {
  if (!(error instanceof Error)) {
    return {
      errorName: "UnknownError",
      errorMessage: "The operation failed with a non-Error value.",
    }
  }

  const result: SafeErrorRecord = {
    errorName: safeOptionalText(error.name, 128) ?? "Error",
    errorMessage: boundedText(redactLocalPaths(error.message), 512) ?? "No error message was provided.",
  }
  const code = (error as Error & { code?: unknown }).code
  if (typeof code === "string") result.errorCode = code.slice(0, 128)
  else if (typeof code === "number") result.errorCode = code
  return result
}

function boundedText(value: string | undefined, maximumLength: number): string | null {
  if (value === undefined) return null
  return value.slice(0, maximumLength)
}

function safeOptionalText(value: string | undefined, maximumLength: number): string | null {
  return value === undefined ? null : boundedText(redactLocalPaths(value), maximumLength)
}
