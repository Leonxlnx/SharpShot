import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { spawn } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import { TextDecoder } from "node:util"

const PROTOCOL_VERSION = 1
const DEFAULT_READY_TIMEOUT_MS = 2_500
const DEFAULT_REQUEST_TIMEOUT_MS = 2_500
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_500
const MAX_BINDINGS = 64
const MAX_LINE_BYTES = 65_536
const MAX_REQUEST_ID_LENGTH = 128
const MAX_BINDING_ID_LENGTH = 128
const MAX_ACCELERATOR_LENGTH = 64
const MAX_ERROR_LENGTH = 512

export type HotkeyHostBinding = {
  bindingId: string
  accelerator: string
}

export type HotkeyHostBindingResult = {
  bindingId: string
  registered: boolean
  backend?: "register-hot-key" | "hook"
  reason?: string
}

export type HotkeyHostReplaceResult = {
  applied: boolean
  rollbackComplete: boolean
  hookActive: boolean
  bindings: HotkeyHostBindingResult[]
}

export type HotkeyHostCapabilities = {
  registerHotKey: true
  lowLevelHookFallback: true
  hookFallbackAccelerators: string[]
  transactionalReplace: true
  parentProcessWait: true
  stdinEofShutdown: true
  maxBindings: number
  maxLineBytes: number
}

export type HotkeyHostProcess = EventEmitter & {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  exitCode: number | null
  kill(signal?: NodeJS.Signals | number): boolean
}

export type HotkeyHostSpawnOptions = {
  windowsHide: true
  stdio: ["pipe", "pipe", "pipe"]
}

export type HotkeyHostSpawner = (
  executablePath: string,
  args: string[],
  options: HotkeyHostSpawnOptions,
) => HotkeyHostProcess

export interface HotkeyHostController {
  readonly available: boolean
  readonly capabilities: HotkeyHostCapabilities | null
  start(): Promise<boolean>
  replaceBindings(
    bindings: readonly HotkeyHostBinding[],
    allowHookFallback: boolean,
  ): Promise<HotkeyHostReplaceResult>
  shutdown(): Promise<void>
  on(event: "shortcut", listener: (bindingId: string) => void): this
  on(event: "unavailable", listener: (error: Error) => void): this
  off(event: "shortcut", listener: (bindingId: string) => void): this
  off(event: "unavailable", listener: (error: Error) => void): this
}

type HotkeyHostEvents = {
  shortcut: [bindingId: string]
  unavailable: [error: Error]
}

type ClientState = "stopped" | "starting" | "ready" | "shutting-down" | "unavailable"
type PendingRequest = {
  kind: "replace" | "shutdown"
  expectedBindingIds: readonly string[]
  resolve(value: HotkeyHostReplaceResult | string): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export class HotkeyHostProtocolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "HotkeyHostProtocolError"
    this.code = code
  }
}

export class HotkeyHostClient extends EventEmitter<HotkeyHostEvents> implements HotkeyHostController {
  private readonly executablePath: string
  private readonly parentProcessId: number
  private readonly spawnHost: HotkeyHostSpawner
  private readonly readyTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly shutdownTimeoutMs: number
  private child: HotkeyHostProcess | null = null
  private state: ClientState = "stopped"
  private startTask: Promise<boolean> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private readyTimer: NodeJS.Timeout | null = null
  private stdoutBuffer = Buffer.alloc(0)
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private readonly activeBindingIds = new Set<string>()
  private parsedCapabilities: HotkeyHostCapabilities | null = null
  private unavailableEmitted = false

  constructor(options: {
    executablePath: string
    parentProcessId?: number
    spawnHost?: HotkeyHostSpawner
    readyTimeoutMs?: number
    requestTimeoutMs?: number
    shutdownTimeoutMs?: number
  }) {
    super()
    if (options.executablePath.length === 0) throw new TypeError("Hotkey host path is required.")
    const parentProcessId = options.parentProcessId ?? process.pid
    if (!Number.isSafeInteger(parentProcessId) || parentProcessId <= 0) {
      throw new TypeError("Hotkey host parent process ID must be a positive integer.")
    }
    this.executablePath = options.executablePath
    this.parentProcessId = parentProcessId
    this.spawnHost = options.spawnHost ?? defaultSpawnHost
    this.readyTimeoutMs = positiveTimeout(options.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS)
    this.requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS)
    this.shutdownTimeoutMs = positiveTimeout(options.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS)
  }

  get available(): boolean {
    return this.state === "ready"
  }

  get capabilities(): HotkeyHostCapabilities | null {
    return this.parsedCapabilities === null
      ? null
      : { ...this.parsedCapabilities, hookFallbackAccelerators: [...this.parsedCapabilities.hookFallbackAccelerators] }
  }

  start(): Promise<boolean> {
    if (this.state === "ready") return Promise.resolve(true)
    if (this.startTask !== null) return this.startTask
    if (this.state === "unavailable" || this.state === "shutting-down") return Promise.resolve(false)
    this.unavailableEmitted = false
    this.state = "starting"
    this.startTask = this.startCore().finally(() => {
      this.startTask = null
    })
    return this.startTask
  }

  async replaceBindings(
    bindings: readonly HotkeyHostBinding[],
    allowHookFallback: boolean,
  ): Promise<HotkeyHostReplaceResult> {
    if (this.state !== "ready") throw new HotkeyHostProtocolError("HOST_UNAVAILABLE", "The native hotkey host is unavailable.")
    const normalized = validateRequestedBindings(bindings)
    const normalizedHookFallback = requireBoolean(allowHookFallback, "allowHookFallback")
    const result = await this.sendRequest(
      "replace",
      {
        v: PROTOCOL_VERSION,
        id: randomUUID(),
        cmd: "bindings.replace",
        bindings: normalized,
        allowHookFallback: normalizedHookFallback,
      },
      normalized.map((binding) => binding.bindingId),
    )
    return result as HotkeyHostReplaceResult
  }

  async shutdown(): Promise<void> {
    if (this.state === "stopped") return
    const child = this.child
    if (child === null) {
      this.state = "stopped"
      return
    }

    if (this.state === "ready") {
      const request = this.sendRequest(
        "shutdown",
        { v: PROTOCOL_VERSION, id: randomUUID(), cmd: "shutdown" },
        [],
      )
      this.state = "shutting-down"
      await withTimeout(request.then(() => undefined), this.shutdownTimeoutMs).catch(() => undefined)
    } else {
      this.state = "shutting-down"
    }

    child.stdin.end()
    if (!(await waitForExit(child, this.shutdownTimeoutMs))) {
      child.kill()
      await waitForExit(child, Math.min(this.shutdownTimeoutMs, 500))
    }
    this.detachChild(child)
    this.child = null
    this.state = "stopped"
    this.clearProtocolState(new HotkeyHostProtocolError("HOST_STOPPED", "The native hotkey host stopped."))
  }

  private async startCore(): Promise<boolean> {
    let child: HotkeyHostProcess
    try {
      child = this.spawnHost(
        this.executablePath,
        ["--studio-hotkey-host", "--parent-pid", String(this.parentProcessId)],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      )
    } catch (error) {
      this.markUnavailable(asError(error, "The native hotkey host could not start."))
      return false
    }
    this.child = child
    this.attachChild(child)

    try {
      await new Promise<void>((resolve, reject) => {
        this.readyResolve = resolve
        this.readyReject = reject
        this.readyTimer = setTimeout(() => {
          this.failTransport(new HotkeyHostProtocolError("READY_TIMEOUT", "The native hotkey host did not become ready in time."))
        }, this.readyTimeoutMs)
      })
      return this.state === "ready"
    } catch {
      return false
    }
  }

  private attachChild(child: HotkeyHostProcess): void {
    child.stdout.on("data", this.onStdoutData)
    child.stdout.on("end", this.onStdoutEnd)
    child.stdout.on("error", this.onOutputError)
    child.stderr.on("data", discardBoundedStderr)
    child.stderr.on("error", this.onOutputError)
    child.stdin.on("error", this.onStdinError)
    child.on("error", this.onChildError)
    child.on("exit", this.onChildExit)
  }

  private detachChild(child: HotkeyHostProcess): void {
    child.stdout.off("data", this.onStdoutData)
    child.stdout.off("end", this.onStdoutEnd)
    child.stdout.off("error", this.onOutputError)
    child.stderr.off("data", discardBoundedStderr)
    child.stderr.off("error", this.onOutputError)
    child.stdin.off("error", this.onStdinError)
    child.off("error", this.onChildError)
    child.off("exit", this.onChildExit)
  }

  private readonly onStdoutData = (value: Buffer | string): void => {
    if (this.state === "stopped" || this.state === "unavailable") return
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    this.stdoutBuffer = this.stdoutBuffer.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.stdoutBuffer, chunk])

    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a)
      if (newline < 0) break
      let line = this.stdoutBuffer.subarray(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1)
      if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1)
      if (line.length > MAX_LINE_BYTES) {
        this.failTransport(new HotkeyHostProtocolError("LINE_TOO_LARGE", "A native hotkey host line exceeded 65536 bytes."))
        return
      }
      try {
        this.handleLine(new TextDecoder("utf-8", { fatal: true }).decode(line))
      } catch (error) {
        this.failTransport(asProtocolError(error))
        return
      }
    }

    const pendingLengthAllowed = this.stdoutBuffer.length === MAX_LINE_BYTES + 1 && this.stdoutBuffer.at(-1) === 0x0d
    if (this.stdoutBuffer.length > MAX_LINE_BYTES && !pendingLengthAllowed) {
      this.failTransport(new HotkeyHostProtocolError("LINE_TOO_LARGE", "A native hotkey host line exceeded 65536 bytes."))
    }
  }

  private readonly onStdoutEnd = (): void => {
    if (this.stdoutBuffer.length > 0 && this.state !== "stopped" && this.state !== "unavailable") {
      this.failTransport(new HotkeyHostProtocolError("TRUNCATED_LINE", "The native hotkey host ended with an incomplete protocol line."))
    }
  }

  private readonly onStdinError = (error: Error): void => {
    if (this.state !== "shutting-down" && this.state !== "stopped") this.failTransport(error)
  }

  private readonly onOutputError = (error: Error): void => {
    if (this.state !== "shutting-down" && this.state !== "stopped") this.failTransport(error)
  }

  private readonly onChildError = (error: Error): void => {
    if (this.state !== "shutting-down" && this.state !== "stopped") this.failTransport(error)
  }

  private readonly onChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (this.state === "shutting-down" || this.state === "stopped") return
    this.failTransport(new HotkeyHostProtocolError(
      "HOST_EXITED",
      `The native hotkey host exited unexpectedly (${code ?? signal ?? "unknown"}).`,
    ))
  }

  private handleLine(line: string): void {
    if (line.length === 0) throw new HotkeyHostProtocolError("INVALID_JSON", "The native hotkey host sent an empty line.")
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new HotkeyHostProtocolError("INVALID_JSON", "The native hotkey host sent invalid JSON.")
    }
    const message = requireRecord(value, "protocol message")
    if (message.v !== PROTOCOL_VERSION) throw new HotkeyHostProtocolError("PROTOCOL_MISMATCH", "The native hotkey host protocol version does not match.")
    const type = requireString(message.type, "type", 32)
    if (type === "ready") {
      this.handleReady(message)
      return
    }
    if (type === "response") {
      this.handleResponse(message)
      return
    }
    if (type === "shortcut") {
      this.handleShortcut(message)
      return
    }
    if (type === "fatal") {
      requireOnlyKeys(message, ["v", "type", "code", "message"])
      throw new HotkeyHostProtocolError(
        requireString(message.code, "code", 128),
        requireString(message.message, "message", MAX_ERROR_LENGTH),
      )
    }
    throw new HotkeyHostProtocolError("UNKNOWN_MESSAGE", `The native hotkey host sent unsupported message type ${type}.`)
  }

  private handleReady(message: Record<string, unknown>): void {
    if (this.state !== "starting" || this.readyResolve === null) {
      throw new HotkeyHostProtocolError("UNEXPECTED_READY", "The native hotkey host sent ready more than once.")
    }
    requireOnlyKeys(message, ["v", "type", "capabilities"])
    const capabilities = parseCapabilities(message.capabilities)
    this.parsedCapabilities = capabilities
    this.state = "ready"
    this.clearReadyTimer()
    const resolve = this.readyResolve
    this.readyResolve = null
    this.readyReject = null
    resolve()
  }

  private handleResponse(message: Record<string, unknown>): void {
    if (this.state !== "ready" && this.state !== "shutting-down") {
      throw new HotkeyHostProtocolError("UNEXPECTED_RESPONSE", "The native hotkey host responded before ready.")
    }
    const id = requireString(message.id, "id", MAX_REQUEST_ID_LENGTH)
    const pending = this.pendingRequests.get(id)
    if (pending === undefined) throw new HotkeyHostProtocolError("UNKNOWN_RESPONSE", "The native hotkey host responded with an unknown request ID.")
    const ok = requireBoolean(message.ok, "ok")

    if (!ok) {
      requireOnlyKeys(message, ["v", "type", "id", "ok", "error"])
      const error = requireRecord(message.error, "error")
      requireOnlyKeys(error, ["code", "message"])
      const responseError = new HotkeyHostProtocolError(
        requireString(error.code, "error.code", 128),
        requireString(error.message, "error.message", MAX_ERROR_LENGTH),
      )
      this.pendingRequests.delete(id)
      clearTimeout(pending.timer)
      pending.reject(responseError)
      return
    }

    requireOnlyKeys(message, ["v", "type", "id", "ok", "result"])
    if (pending.kind === "replace") {
      const result = parseReplaceResult(message.result, pending.expectedBindingIds)
      this.pendingRequests.delete(id)
      clearTimeout(pending.timer)
      if (result.applied) {
        this.activeBindingIds.clear()
        for (const bindingId of pending.expectedBindingIds) this.activeBindingIds.add(bindingId)
      }
      pending.resolve(result)
      return
    }

    const result = requireRecord(message.result, "result")
    requireOnlyKeys(result, ["state"])
    const state = requireString(result.state, "result.state", 32)
    if (state !== "shutdown") throw new HotkeyHostProtocolError("INVALID_RESPONSE", "The native hotkey host returned an invalid shutdown state.")
    this.pendingRequests.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(state)
  }

  private handleShortcut(message: Record<string, unknown>): void {
    if (this.state !== "ready") throw new HotkeyHostProtocolError("UNEXPECTED_SHORTCUT", "The native hotkey host emitted a shortcut while unavailable.")
    requireOnlyKeys(message, ["v", "type", "bindingId"])
    const bindingId = requireString(message.bindingId, "bindingId", MAX_BINDING_ID_LENGTH)
    if (!this.activeBindingIds.has(bindingId)) {
      throw new HotkeyHostProtocolError("UNKNOWN_BINDING", "The native hotkey host emitted an inactive binding ID.")
    }
    this.emit("shortcut", bindingId)
  }

  private sendRequest(
    kind: PendingRequest["kind"],
    request: Record<string, unknown>,
    expectedBindingIds: readonly string[],
  ): Promise<HotkeyHostReplaceResult | string> {
    const child = this.child
    if (child === null || (this.state !== "ready" && kind !== "shutdown")) {
      return Promise.reject(new HotkeyHostProtocolError("HOST_UNAVAILABLE", "The native hotkey host is unavailable."))
    }
    const id = requireString(request.id, "id", MAX_REQUEST_ID_LENGTH)
    const serialized = `${JSON.stringify(request)}\n`
    if (Buffer.byteLength(serialized, "utf8") > MAX_LINE_BYTES) {
      return Promise.reject(new HotkeyHostProtocolError("REQUEST_TOO_LARGE", "The native hotkey host request is too large."))
    }

    return new Promise<HotkeyHostReplaceResult | string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failTransport(new HotkeyHostProtocolError("REQUEST_TIMEOUT", "The native hotkey host did not respond in time."))
      }, this.requestTimeoutMs)
      this.pendingRequests.set(id, { kind, expectedBindingIds, resolve, reject, timer })
      try {
        child.stdin.write(serialized, "utf8", (error?: Error | null) => {
          if (error !== undefined && error !== null) this.failTransport(error)
        })
      } catch (error) {
        this.failTransport(asError(error, "The native hotkey host input failed."))
      }
    })
  }

  private failTransport(error: Error): void {
    if (this.state === "unavailable" || this.state === "stopped") return
    const child = this.child
    this.state = "unavailable"
    this.clearProtocolState(error)
    if (child !== null && child.exitCode === null) child.kill()
    this.markUnavailable(error)
  }

  private markUnavailable(error: Error): void {
    this.state = "unavailable"
    if (this.unavailableEmitted) return
    this.unavailableEmitted = true
    this.emit("unavailable", error)
  }

  private clearProtocolState(error: Error): void {
    this.clearReadyTimer()
    const rejectReady = this.readyReject
    this.readyResolve = null
    this.readyReject = null
    rejectReady?.(error)
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingRequests.clear()
    this.stdoutBuffer = Buffer.alloc(0)
    this.activeBindingIds.clear()
    this.parsedCapabilities = null
  }

  private clearReadyTimer(): void {
    if (this.readyTimer !== null) clearTimeout(this.readyTimer)
    this.readyTimer = null
  }
}

function defaultSpawnHost(
  executablePath: string,
  args: string[],
  options: HotkeyHostSpawnOptions,
): HotkeyHostProcess {
  return spawn(executablePath, args, options) as HotkeyHostProcess
}

function validateRequestedBindings(bindings: readonly HotkeyHostBinding[]): HotkeyHostBinding[] {
  if (!Array.isArray(bindings) || bindings.length > MAX_BINDINGS) {
    throw new HotkeyHostProtocolError("TOO_MANY_BINDINGS", "At most 64 hotkey bindings are accepted.")
  }
  const ids = new Set<string>()
  const accelerators = new Set<string>()
  return bindings.map((binding) => {
    const bindingId = requireString(binding?.bindingId, "bindingId", MAX_BINDING_ID_LENGTH)
    const accelerator = requireString(binding?.accelerator, "accelerator", MAX_ACCELERATOR_LENGTH)
    if (!ids.add(bindingId)) throw new HotkeyHostProtocolError("DUPLICATE_BINDING_ID", "Hotkey binding IDs must be unique.")
    if (!accelerators.add(accelerator)) throw new HotkeyHostProtocolError("DUPLICATE_ACCELERATOR", "Hotkey accelerators must be unique.")
    return { bindingId, accelerator }
  })
}

function parseCapabilities(value: unknown): HotkeyHostCapabilities {
  const capabilities = requireRecord(value, "capabilities")
  requireOnlyKeys(capabilities, [
    "registerHotKey",
    "lowLevelHookFallback",
    "hookFallbackAccelerators",
    "transactionalReplace",
    "parentProcessWait",
    "stdinEofShutdown",
    "maxBindings",
    "maxLineBytes",
  ])
  if (
    capabilities.registerHotKey !== true ||
    capabilities.lowLevelHookFallback !== true ||
    capabilities.transactionalReplace !== true ||
    capabilities.parentProcessWait !== true ||
    capabilities.stdinEofShutdown !== true
  ) {
    throw new HotkeyHostProtocolError("MISSING_CAPABILITY", "The native hotkey host lacks a required protocol-v1 capability.")
  }
  const maximumBindings = requireInteger(capabilities.maxBindings, "capabilities.maxBindings")
  const maximumLineBytes = requireInteger(capabilities.maxLineBytes, "capabilities.maxLineBytes")
  if (maximumBindings !== MAX_BINDINGS || maximumLineBytes !== MAX_LINE_BYTES) {
    throw new HotkeyHostProtocolError("CAPABILITY_MISMATCH", "The native hotkey host limits do not match protocol v1.")
  }
  if (!Array.isArray(capabilities.hookFallbackAccelerators)) {
    throw new HotkeyHostProtocolError("INVALID_FIELD", "capabilities.hookFallbackAccelerators must be an array.")
  }
  const hookFallbackAccelerators = capabilities.hookFallbackAccelerators.map((accelerator) =>
    requireString(accelerator, "capabilities.hookFallbackAccelerators", MAX_ACCELERATOR_LENGTH),
  )
  if (new Set(hookFallbackAccelerators).size !== hookFallbackAccelerators.length) {
    throw new HotkeyHostProtocolError("INVALID_FIELD", "Hook fallback accelerators must be unique.")
  }
  return {
    registerHotKey: true,
    lowLevelHookFallback: true,
    hookFallbackAccelerators,
    transactionalReplace: true,
    parentProcessWait: true,
    stdinEofShutdown: true,
    maxBindings: maximumBindings,
    maxLineBytes: maximumLineBytes,
  }
}

function parseReplaceResult(value: unknown, expectedBindingIds: readonly string[]): HotkeyHostReplaceResult {
  const result = requireRecord(value, "result")
  requireOnlyKeys(result, ["applied", "rollbackComplete", "hookActive", "bindings"])
  const applied = requireBoolean(result.applied, "result.applied")
  const rollbackComplete = requireBoolean(result.rollbackComplete, "result.rollbackComplete")
  const hookActive = requireBoolean(result.hookActive, "result.hookActive")
  if (!Array.isArray(result.bindings) || result.bindings.length !== expectedBindingIds.length) {
    throw new HotkeyHostProtocolError("INVALID_RESPONSE", "The native hotkey host returned the wrong number of binding results.")
  }
  const bindings = result.bindings.map((raw, index): HotkeyHostBindingResult => {
    const binding = requireRecord(raw, `result.bindings[${index}]`)
    requireOnlyKeys(binding, ["bindingId", "registered", "backend", "reason"])
    const bindingId = requireString(binding.bindingId, "bindingId", MAX_BINDING_ID_LENGTH)
    if (bindingId !== expectedBindingIds[index]) {
      throw new HotkeyHostProtocolError("INVALID_RESPONSE", "The native hotkey host returned binding results out of order.")
    }
    const registered = requireBoolean(binding.registered, "registered")
    let backend: HotkeyHostBindingResult["backend"]
    if (binding.backend !== undefined) {
      const value = requireString(binding.backend, "backend", 32)
      if (value !== "register-hot-key" && value !== "hook") {
        throw new HotkeyHostProtocolError("INVALID_RESPONSE", "The native hotkey host returned an unknown backend.")
      }
      backend = value
    }
    const reason = binding.reason === undefined
      ? undefined
      : requireString(binding.reason, "reason", MAX_ERROR_LENGTH)
    if (registered !== (backend !== undefined)) {
      throw new HotkeyHostProtocolError("INVALID_RESPONSE", "The native hotkey host returned an inconsistent binding result.")
    }
    return { bindingId, registered, backend, reason }
  })
  if (applied && (!rollbackComplete || bindings.some((binding) => !binding.registered))) {
    throw new HotkeyHostProtocolError("INVALID_RESPONSE", "The native hotkey host reported an inconsistent applied transaction.")
  }
  if (!applied && bindings.some((binding) => binding.registered)) {
    throw new HotkeyHostProtocolError("INVALID_RESPONSE", "The native hotkey host reported active candidate bindings after rollback.")
  }
  return { applied, rollbackComplete, hookActive, bindings }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HotkeyHostProtocolError("INVALID_FIELD", `${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function requireOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const accepted = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) throw new HotkeyHostProtocolError("UNKNOWN_FIELD", `Unknown protocol field: ${key}.`)
  }
  for (const key of keys) {
    if (!(key in value) && key !== "backend" && key !== "reason") {
      throw new HotkeyHostProtocolError("MISSING_FIELD", `Missing protocol field: ${key}.`)
    }
  }
}

function requireString(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength) {
    throw new HotkeyHostProtocolError("INVALID_FIELD", `${label} must be a non-empty string.`)
  }
  return value
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new HotkeyHostProtocolError("INVALID_FIELD", `${label} must be a boolean.`)
  return value
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new HotkeyHostProtocolError("INVALID_FIELD", `${label} must be an integer.`)
  }
  return value
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0 || value > 60_000) throw new TypeError("Hotkey host timeouts must be positive integers.")
  return value
}

function asProtocolError(error: unknown): HotkeyHostProtocolError {
  if (error instanceof HotkeyHostProtocolError) return error
  return new HotkeyHostProtocolError("INVALID_MESSAGE", "The native hotkey host sent an invalid protocol message.")
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback)
}

function discardBoundedStderr(_value: Buffer | string): void {
  // Draining stderr prevents a blocked native child. Protocol diagnostics are
  // deliberately not copied into renderer-visible errors or unbounded logs.
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out.")), timeoutMs)
    void task.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}

function waitForExit(child: HotkeyHostProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.off("exit", onExit)
      resolve(false)
    }, timeoutMs)
    child.once("exit", onExit)
  })
}
