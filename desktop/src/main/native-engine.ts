import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { access, mkdir, readFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { globalShortcut } from "electron"
import type {
  BindingRegistration,
  EngineActionAccepted,
  EngineOperationState,
  EngineStatus,
} from "../shared/api.js"
import type { ShortcutAction, Workflow, WorkflowStore } from "../shared/workflows.js"
import {
  HotkeyHostClient,
  type HotkeyHostBinding,
  type HotkeyHostBindingResult,
  type HotkeyHostController,
  type HotkeyHostReplaceResult,
} from "./hotkey-host-client.js"
import { recordingCursorPolicyForWorkflow } from "./capture-completion-policy.js"

const PROTOCOL_VERSION = 1
const MAX_RESULT_BYTES = 64 * 1024
const MAX_ERROR_LENGTH = 512

type NativeEngineEvents = {
  status: [EngineStatus]
  event: [NativeEngineRawEvent]
}

export type NativeEngineRawEvent = {
  name: string
  payload: unknown
}

type ActiveOperation = {
  id: string
  child: ChildProcessWithoutNullStreams
  command: "screenshot" | "recording"
  workflow: Workflow
  resultPath: string
}

type HotkeyHostListeners = {
  readonly host: HotkeyHostController
  readonly generation: number
  readonly shortcut: (bindingId: string) => void
  readonly unavailable: (error: Error) => void
}

export type PreparedBindingReplacement = {
  readonly store: WorkflowStore
  readonly candidateElectronAccelerators: ReadonlySet<string>
  readonly stagedElectronAccelerators: ReadonlySet<string>
  readonly previousBrokerBindings: readonly HotkeyHostBinding[]
  readonly candidateBrokerBindings: readonly HotkeyHostBinding[]
  readonly brokerHost: HotkeyHostController | null
  readonly brokerApplied: boolean
  readonly hookActive: boolean
  readonly bindings: readonly BindingRegistration[]
}

export type BindingReplacementPreparation =
  | {
      readonly ready: true
      readonly transaction: PreparedBindingReplacement
      readonly bindings: readonly BindingRegistration[]
    }
  | {
      readonly ready: false
      readonly bindings: readonly BindingRegistration[]
      readonly failedBindingIds: readonly string[]
    }

type OneShotResult = {
  status: "completed" | "cancelled" | "failed"
  path?: string
  width: number
  height: number
  durationMs: number
  clipboard: boolean
  cursorPath?: string
  systemAudioPath?: string
  microphonePath?: string
  error?: string
}

export class NativeEngineError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "NativeEngineError"
    this.code = code
  }
}

export class NativeEngine extends EventEmitter<NativeEngineEvents> {
  private readonly resourcesDirectory: string
  private readonly developmentHelperPath?: string
  private readonly resultDirectory: string
  private readonly mockMode: boolean
  private readonly hotkeyHostFactory: (executablePath: string) => HotkeyHostController
  private helperPath: string | null = null
  private active: ActiveOperation | null = null
  private readonly completionTasks = new Set<Promise<void>>()
  private workflowStore: WorkflowStore | null = null
  private readonly registeredAccelerators = new Set<string>()
  private pendingBindingReplacement: PreparedBindingReplacement | null = null
  private bindingPreparationTask: Promise<BindingReplacementPreparation> | null = null
  private bindingReplacementInProgress = false
  private hotkeyHost: HotkeyHostController | null = null
  private hotkeyHostListeners: HotkeyHostListeners | null = null
  private hotkeyHostGeneration = 0
  private brokerBindingGeneration = 0
  private lastBrokerRecoveryGeneration: number | null = null
  private brokerRecoveryTask: Promise<void> | null = null
  private shuttingDown = false
  private brokerBindings: HotkeyHostBinding[] = []
  private brokerRegistrations: BindingRegistration[] = []
  private status: EngineStatus = {
    mode: "connecting",
    available: false,
    operationState: "unavailable",
    protocolVersion: null,
  }

  constructor(options: {
    resourcesDirectory: string
    resultDirectory: string
    developmentHelperPath?: string
    mockMode?: boolean
    hotkeyHostFactory?: (executablePath: string) => HotkeyHostController
  }) {
    super()
    this.resourcesDirectory = options.resourcesDirectory
    this.resultDirectory = options.resultDirectory
    this.developmentHelperPath = options.developmentHelperPath
    this.mockMode = options.mockMode === true
    this.hotkeyHostFactory = options.hotkeyHostFactory ?? ((executablePath) =>
      new HotkeyHostClient({ executablePath }))
  }

  getStatus(): EngineStatus {
    return {
      ...this.status,
      shortcutFailures: this.status.shortcutFailures?.map((failure) => ({ ...failure })),
    }
  }

  async start(): Promise<EngineStatus> {
    await mkdir(this.resultDirectory, { recursive: true })
    if (this.mockMode) {
      this.setStatus({
        mode: "mock",
        available: false,
        operationState: "unavailable",
        protocolVersion: PROTOCOL_VERSION,
        reason: "Native capture is running in explicit mock mode.",
      })
      return this.getStatus()
    }

    const candidates = [
      join(this.resourcesDirectory, "native", "win32-x64", "SharpShot.Native.exe"),
      this.developmentHelperPath,
    ].filter((candidate): candidate is string => typeof candidate === "string")

    for (const candidate of candidates) {
      try {
        await access(candidate)
        this.helperPath = candidate
        break
      } catch {
        // Try the next explicit, allowlisted helper location.
      }
    }

    if (this.helperPath === null) {
      this.setStatus({
        mode: "degraded",
        available: false,
        operationState: "unavailable",
        protocolVersion: null,
        reason: "The native SharpShot capture helper is not installed. The editor and library remain available.",
      })
      return this.getStatus()
    }

    this.setStatus({
      mode: "native",
      available: true,
      operationState: "idle",
      protocolVersion: PROTOCOL_VERSION,
    })
    return this.getStatus()
  }

  async replaceBindings(store: WorkflowStore): Promise<BindingRegistration[]> {
    const startupRegistration = this.workflowStore === null
    const preparation = await this.prepareBindingReplacement(store)
    if (!preparation.ready) {
      const bindings = startupRegistration
        ? await this.activateStartupSubset(store, preparation.bindings)
        : [...preparation.bindings]
      this.setShortcutFailures(bindings)
      return bindings
    }
    try {
      await this.commitBindingReplacement(preparation.transaction)
    } catch (error) {
      await this.abortBindingReplacement(preparation.transaction).catch(() => undefined)
      if (!startupRegistration) throw error
      const bindings = await this.activateStartupSubset(store, preparation.bindings)
      this.setShortcutFailures(bindings)
      return bindings
    }
    return [...preparation.bindings]
  }

  async prepareBindingReplacement(store: WorkflowStore): Promise<BindingReplacementPreparation> {
    if (this.bindingPreparationTask !== null) {
      throw new NativeEngineError("BINDING_UPDATE_IN_PROGRESS", "Another shortcut update is still being saved.")
    }
    const task = this.prepareBindingReplacementCore(store)
    this.bindingPreparationTask = task
    try {
      return await task
    } finally {
      if (this.bindingPreparationTask === task) this.bindingPreparationTask = null
    }
  }

  private async prepareBindingReplacementCore(store: WorkflowStore): Promise<BindingReplacementPreparation> {
    if (this.shuttingDown) {
      throw new NativeEngineError("ENGINE_SHUTTING_DOWN", "SharpShot is shutting down.")
    }
    const recoveryTask = this.brokerRecoveryTask
    if (recoveryTask !== null) await recoveryTask
    if (this.shuttingDown) {
      throw new NativeEngineError("ENGINE_SHUTTING_DOWN", "SharpShot is shutting down.")
    }
    if (this.bindingReplacementInProgress || this.pendingBindingReplacement !== null) {
      throw new NativeEngineError("BINDING_UPDATE_IN_PROGRESS", "Another shortcut update is still being saved.")
    }

    this.bindingReplacementInProgress = true
    const candidateStore = structuredClone(store)
    const candidateElectronAccelerators = new Set<string>()
    const stagedElectronAccelerators = new Set<string>()
    const resultByBindingId = new Map<string, BindingRegistration>()
    const candidateBrokerBindings: HotkeyHostBinding[] = []

    try {
      for (const binding of candidateStore.shortcutBindings) {
        if (!binding.enabled) {
          resultByBindingId.set(binding.id, { bindingId: binding.id, registered: false, reason: "Disabled" })
          continue
        }
        const electronAccelerator = toElectronAccelerator(binding.accelerator)
        const alreadyRegistered = this.registeredAccelerators.has(electronAccelerator)
        const registered = alreadyRegistered || this.registerAccelerator(electronAccelerator)
        if (registered) {
          candidateElectronAccelerators.add(electronAccelerator)
          if (!alreadyRegistered) stagedElectronAccelerators.add(electronAccelerator)
          resultByBindingId.set(binding.id, {
            bindingId: binding.id,
            registered: true,
            backend: "electron",
          })
        } else {
          candidateBrokerBindings.push({ bindingId: binding.id, accelerator: binding.accelerator })
          resultByBindingId.set(binding.id, {
            bindingId: binding.id,
            registered: false,
            reason: "Windows or another app already owns this shortcut.",
          })
        }
      }

      const allowHookFallback = allowsExactHookFallback(candidateBrokerBindings)
      let brokerHost = this.hotkeyHost
      if (brokerHost !== null && !brokerHost.available) {
        await this.markHotkeyHostUnavailable(
          brokerHost,
          new NativeEngineError("SHORTCUT_BROKER_LOST", "The native shortcut broker is unavailable."),
        )
        brokerHost = null
      }
      if (
        brokerHost === null &&
        candidateBrokerBindings.length > 0 &&
        allowHookFallback
      ) {
        brokerHost = await this.ensureHotkeyHost()
      }
      if (this.shuttingDown) {
        throw new NativeEngineError("ENGINE_SHUTTING_DOWN", "SharpShot is shutting down.")
      }

      let brokerResult: HotkeyHostReplaceResult | null = null
      if (brokerHost !== null && brokerHost.available) {
        try {
          brokerResult = await replaceBrokerBindings(
            brokerHost,
            candidateBrokerBindings,
            allowHookFallback,
          )
        } catch (error) {
          await this.markHotkeyHostUnavailable(brokerHost, asNativeEngineError(error))
          brokerHost = null
        }
      }
      if (this.shuttingDown) {
        throw new NativeEngineError("ENGINE_SHUTTING_DOWN", "SharpShot is shutting down.")
      }

      if (brokerResult !== null) {
        for (const result of brokerResult.bindings) {
          resultByBindingId.set(result.bindingId, brokerRegistration(result))
        }
        if (!brokerResult.applied && !brokerResult.rollbackComplete && brokerHost !== null) {
          await this.markHotkeyHostUnavailable(
            brokerHost,
            new NativeEngineError("SHORTCUT_ROLLBACK_FAILED", "The native shortcut broker could not restore its previous bindings."),
          )
          brokerHost = null
        }
      }

      if (brokerResult === null && candidateBrokerBindings.length > 0) {
        for (const binding of candidateBrokerBindings) {
          resultByBindingId.set(binding.bindingId, {
            bindingId: binding.bindingId,
            registered: false,
            reason: "The native shortcut broker is unavailable for this Windows-owned shortcut.",
          })
        }
      }

      const bindings = candidateStore.shortcutBindings.map((binding) =>
        resultByBindingId.get(binding.id) ?? {
          bindingId: binding.id,
          registered: false,
          reason: "SharpShot could not determine a shortcut backend.",
        },
      )
      const failedBindingIds = bindings
        .filter((binding) => !binding.registered && binding.reason !== "Disabled")
        .map((binding) => binding.bindingId)

      if (failedBindingIds.length > 0 || (brokerResult !== null && !brokerResult.applied)) {
        this.releaseStagedElectronAccelerators(stagedElectronAccelerators)
        this.bindingReplacementInProgress = false
        if (this.brokerBindings.length === 0 && brokerHost !== null && brokerHost.available) {
          await this.stopHotkeyHost(brokerHost)
        }
        await this.attemptCommittedBrokerRecovery()
        return { ready: false, bindings, failedBindingIds }
      }

      const transaction: PreparedBindingReplacement = {
        store: candidateStore,
        candidateElectronAccelerators,
        stagedElectronAccelerators,
        previousBrokerBindings: this.brokerBindings.map((binding) => ({ ...binding })),
        candidateBrokerBindings: candidateBrokerBindings.map((binding) => ({ ...binding })),
        brokerHost,
        brokerApplied: brokerResult?.applied === true,
        hookActive: brokerResult?.hookActive === true,
        bindings,
      }
      this.pendingBindingReplacement = transaction
      return { ready: true, transaction, bindings }
    } catch (error) {
      this.releaseStagedElectronAccelerators(stagedElectronAccelerators)
      this.bindingReplacementInProgress = false
      await this.attemptCommittedBrokerRecovery()
      throw error
    }
  }

  async commitBindingReplacement(transaction: PreparedBindingReplacement): Promise<void> {
    this.assertPendingBindingReplacement(transaction)
    if (
      transaction.brokerApplied &&
      (transaction.brokerHost === null || !transaction.brokerHost.available || this.hotkeyHost !== transaction.brokerHost)
    ) {
      throw new NativeEngineError("SHORTCUT_BROKER_LOST", "The native shortcut broker exited before the workflow was committed.")
    }

    this.workflowStore = structuredClone(transaction.store)
    for (const accelerator of transaction.stagedElectronAccelerators) {
      this.registeredAccelerators.add(accelerator)
    }
    for (const accelerator of [...this.registeredAccelerators]) {
      if (transaction.candidateElectronAccelerators.has(accelerator)) continue
      if (this.unregisterAccelerator(accelerator)) this.registeredAccelerators.delete(accelerator)
    }
    this.brokerBindings = transaction.candidateBrokerBindings.map((binding) => ({ ...binding }))
    this.brokerRegistrations = transaction.bindings
      .filter((binding) => binding.backend === "register-hot-key" || binding.backend === "hook")
      .map((binding) => ({ ...binding }))
    this.advanceBrokerBindingGeneration()
    this.pendingBindingReplacement = null
    this.bindingReplacementInProgress = false
    this.clearShortcutFailures(transaction.hookActive)

    if (this.brokerBindings.length === 0 && transaction.brokerHost !== null) {
      await this.stopHotkeyHost(transaction.brokerHost)
    }
  }

  async abortBindingReplacement(transaction: PreparedBindingReplacement): Promise<void> {
    this.assertPendingBindingReplacement(transaction)
    let rollbackError: NativeEngineError | null = null
    try {
      if (transaction.brokerApplied) {
        const host = transaction.brokerHost
        if (host === null || !host.available || this.hotkeyHost !== host) {
          rollbackError = new NativeEngineError(
            "SHORTCUT_ROLLBACK_FAILED",
            "The native shortcut broker exited before it could restore the previous shortcuts.",
          )
        } else {
          try {
            const restored = await replaceBrokerBindings(
              host,
              transaction.previousBrokerBindings,
              allowsExactHookFallback(transaction.previousBrokerBindings),
            )
            if (
              !restored.applied ||
              !restored.rollbackComplete ||
              restored.bindings.some((binding) => !binding.registered)
            ) {
              rollbackError = new NativeEngineError(
                "SHORTCUT_ROLLBACK_FAILED",
                "The native shortcut broker could not restore the previous shortcuts.",
              )
              await this.markHotkeyHostUnavailable(host, rollbackError)
            } else {
              this.updateBrokerStatus(restored.hookActive)
            }
          } catch (error) {
            rollbackError = new NativeEngineError(
              "SHORTCUT_ROLLBACK_FAILED",
              asNativeEngineError(error).message,
            )
            await this.markHotkeyHostUnavailable(host, rollbackError)
          }
        }
      }
    } finally {
      this.releaseStagedElectronAccelerators(transaction.stagedElectronAccelerators)
      this.pendingBindingReplacement = null
      this.bindingReplacementInProgress = false
    }

    if (
      rollbackError === null &&
      transaction.previousBrokerBindings.length === 0 &&
      transaction.brokerHost !== null
    ) {
      await this.stopHotkeyHost(transaction.brokerHost)
    }
    if (
      rollbackError !== null &&
      transaction.previousBrokerBindings.length > 0 &&
      !this.shuttingDown
    ) {
      if (await this.attemptCommittedBrokerRecovery()) rollbackError = null
    }
    if (rollbackError !== null) {
      this.surfaceLostBrokerBindings(rollbackError.message)
      throw rollbackError
    }
  }

  async runWorkflow(workflow: Workflow): Promise<EngineActionAccepted> {
    this.requireAvailable()
    if (this.active !== null) {
      if (this.active.command === "recording" && this.active.workflow.id === workflow.id) {
        return this.stopRecording()
      }
      throw new NativeEngineError("ENGINE_BUSY", "Finish or cancel the current capture first.")
    }
    return workflow.kind === "screenshot"
      ? this.startScreenshot(workflow)
      : this.startRecording(workflow)
  }

  async stopRecording(): Promise<EngineActionAccepted> {
    const active = this.active
    if (active === null || active.command !== "recording") return { accepted: false }
    if (this.status.operationState !== "finalizing") {
      this.setOperationState("finalizing", active.workflow.id)
      requestRecordingStop(active.child)
    }
    return { accepted: true, operationId: active.id }
  }

  async cancelOperation(): Promise<EngineActionAccepted> {
    const active = this.active
    if (active === null) return { accepted: false }
    if (active.command === "recording") return this.stopRecording()
    // The native screenshot picker owns Esc/right-click cancellation. Killing a
    // modal UI process from the renderer is intentionally not exposed.
    return { accepted: false, operationId: active.id }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    this.advanceBrokerBindingGeneration()
    const bindingPreparationTask = this.bindingPreparationTask
    if (bindingPreparationTask !== null) await bindingPreparationTask.catch(() => undefined)
    const recoveryTask = this.brokerRecoveryTask
    if (recoveryTask !== null) await recoveryTask.catch(() => undefined)
    const host = this.hotkeyHost
    if (host !== null) await this.stopHotkeyHost(host)
    this.brokerBindings = []
    this.brokerRegistrations = []
    this.unregisterTrackedShortcuts()
    const active = this.active
    if (active !== null && active.command === "recording") {
      requestRecordingStop(active.child)
      await waitForExit(active.child, 7_000)
      if (active.child.exitCode === null) {
        active.child.kill()
        await waitForExit(active.child, 2_000)
      }
    } else if (active !== null) {
      active.child.kill()
      await waitForExit(active.child, 2_000)
    }
    await Promise.allSettled([...this.completionTasks])
  }

  private async startScreenshot(workflow: Workflow): Promise<EngineActionAccepted> {
    const resultPath = join(this.resultDirectory, `${randomUUID()}.ini`)
    const args = [
      "--studio-screenshot",
      "--result",
      resultPath,
      "--quality",
      "0",
      "--clipboard",
      String(workflow.finish.clipboard === "image"),
      "--paste-selection-size",
      String(workflow.finish.clipboard === "image"),
    ]
    return this.spawnOperation("screenshot", workflow, resultPath, args)
  }

  private async startRecording(workflow: Workflow): Promise<EngineActionAccepted> {
    const resultPath = join(this.resultDirectory, `${randomUUID()}.ini`)
    const hasSeparateAudio = workflow.video?.systemAudio === true ||
      workflow.video?.microphoneDeviceId !== undefined
    // The native recorder intentionally returns lossless editor stems today;
    // it does not yet mux those stems into the H.264 original. Never put a
    // silent MP4 on the clipboard while implying the requested audio is in it.
    const copyFinishedFile = workflow.finish.clipboard === "file" && !hasSeparateAudio
    const cursorPolicy = recordingCursorPolicyForWorkflow(workflow)
    const args = [
      "--studio-record",
      "--result",
      resultPath,
      "--countdown-ms",
      String(workflow.capture.countdownMs),
      "--clipboard",
      String(copyFinishedFile),
      "--include-cursor",
      String(cursorPolicy.includeInVideo),
      "--editable-cursor",
      String(cursorPolicy.captureMetadata),
      "--system-audio",
      String(workflow.video?.systemAudio === true),
    ]
    if (workflow.video?.fps === 30 || workflow.video?.fps === 60) {
      args.push("--fps", String(workflow.video.fps))
    }
    if (
      workflow.video?.quality === "balanced" ||
      workflow.video?.quality === "high" ||
      workflow.video?.quality === "maximum"
    ) {
      args.push("--video-quality", workflow.video.quality)
    }
    const microphoneDeviceId = workflow.video?.microphoneDeviceId
    if (microphoneDeviceId !== undefined) {
      args.push("--microphone-device-id", microphoneDeviceId)
    }
    return this.spawnOperation("recording", workflow, resultPath, args)
  }

  private async spawnOperation(
    command: "screenshot" | "recording",
    workflow: Workflow,
    resultPath: string,
    args: string[],
  ): Promise<EngineActionAccepted> {
    const helperPath = this.helperPath
    if (helperPath === null) throw new NativeEngineError("ENGINE_UNAVAILABLE", "Native capture is unavailable.")

    const child = spawn(helperPath, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const operation: ActiveOperation = {
      id: randomUUID(),
      child,
      command,
      workflow: structuredClone(workflow),
      resultPath,
    }
    this.active = operation
    this.setOperationState(command === "recording" ? "recording" : "selecting", workflow.id)

    child.once("error", (error) => this.trackCompletion(this.completeOperation(operation, error)))
    child.once("exit", () => this.trackCompletion(this.completeOperation(operation)))
    guardNativeOperationPipes(child, (error) => {
      if (this.active?.id !== operation.id) return
      if (child.exitCode === null) {
        try {
          child.kill()
        } catch {
          // Completion below is authoritative even if process teardown races.
        }
      }
      this.trackCompletion(this.completeOperation(operation, error))
    })
    child.stdout.resume()
    child.stderr.resume()
    child.stdin.on("error", () => {
      // The helper may finish naturally between a stop request and the pipe
      // write. EPIPE is a normal completion race, not a main-process failure.
    })

    if (command === "recording") {
      this.emit("event", {
        name: "record.started",
        payload: { workflowId: workflow.id, operationId: operation.id },
      })
    }
    return { accepted: true, operationId: operation.id }
  }

  private async completeOperation(operation: ActiveOperation, processError?: Error): Promise<void> {
    if (this.active?.id !== operation.id) return
    this.active = null
    try {
      if (processError !== undefined) throw processError
      const result = await readOneShotResult(operation.resultPath)
      if (result.status === "cancelled") {
        this.emit("event", { name: "operation.cancelled", payload: { workflowId: operation.workflow.id } })
      } else if (result.status === "failed") {
        throw new NativeEngineError("CAPTURE_FAILED", result.error ?? "Windows did not complete the capture.")
      } else if (result.path === undefined) {
        throw new NativeEngineError("INVALID_RESULT", "The native helper did not return a media path.")
      } else {
        const cursorMetadataUnavailable = operation.command === "recording" &&
          recordingCursorPolicyForWorkflow(operation.workflow).captureMetadata &&
          result.cursorPath === undefined
        const common = {
          workflowId: operation.workflow.id,
          operationId: operation.id,
          workflowKind: operation.workflow.kind,
          finishClipboard: operation.workflow.finish.clipboard,
          finishAfterCapture: operation.workflow.finish.afterCapture,
          path: result.path,
          width: result.width,
          height: result.height,
          durationMs: result.durationMs,
          clipboard: result.clipboard,
          cursorPath: result.cursorPath,
          cursorMetadataUnavailable,
          systemAudioPath: result.systemAudioPath,
          microphonePath: result.microphonePath,
        }
        this.emit("event", {
          name: operation.command === "screenshot" ? "screenshot.completed" : "record.completed",
          payload: common,
        })
      }
    } catch (error) {
      this.emitFailure(error, operation.workflow.id)
    } finally {
      await unlink(operation.resultPath).catch(() => undefined)
      this.setOperationState("idle")
    }
  }

  private trackCompletion(task: Promise<void>): void {
    this.completionTasks.add(task)
    void task.finally(() => this.completionTasks.delete(task)).catch(() => undefined)
  }

  private async handleShortcut(action: ShortcutAction): Promise<void> {
    if (action.type === "workflow.run") {
      const workflow = this.workflowStore?.workflows.find((item) => item.id === action.workflowId)
      if (workflow === undefined || !workflow.enabled) {
        throw new NativeEngineError("WORKFLOW_NOT_FOUND", "This shortcut's workflow is unavailable.")
      }
      this.emit("event", { name: "shortcut.triggered", payload: { workflowId: workflow.id } })
      await this.runWorkflow(workflow)
      return
    }
    if (action.type === "recording.stop") {
      await this.stopRecording()
      return
    }
    if (action.type === "capture.cancel") {
      await this.cancelOperation()
      return
    }
    if (action.type === "app.open") {
      this.emit("event", { name: "app.open", payload: { page: action.page } })
      return
    }
    throw new NativeEngineError("UNSUPPORTED_ACTION", "This shortcut action is not supported yet.")
  }

  private registerAccelerator(accelerator: string): boolean {
    try {
      return globalShortcut.register(accelerator, () => {
        if (this.bindingReplacementInProgress) return
        const binding = this.workflowStore?.shortcutBindings.find((candidate) =>
          candidate.enabled && toElectronAccelerator(candidate.accelerator) === accelerator,
        )
        // A newly reserved chord is intentionally inert until its workflow file
        // is durable and the two-phase transaction commits.
        if (binding === undefined) return
        void this.handleShortcut(binding.action).catch((error: unknown) => {
          this.emitFailure(
            error,
            binding.action.type === "workflow.run" ? binding.action.workflowId : undefined,
          )
        })
      })
    } catch {
      return false
    }
  }

  private async ensureHotkeyHost(): Promise<HotkeyHostController | null> {
    if (this.hotkeyHost?.available === true) return this.hotkeyHost
    const helperPath = this.helperPath
    if (helperPath === null) return null

    let host: HotkeyHostController
    try {
      host = this.hotkeyHostFactory(helperPath)
    } catch {
      this.updateBrokerStatus(false)
      return null
    }
    let started = false
    try {
      started = await host.start()
    } catch {
      started = false
    }
    if (this.shuttingDown || !started || !host.available) {
      await host.shutdown().catch(() => undefined)
      this.updateBrokerStatus(false)
      return null
    }

    const generation = ++this.hotkeyHostGeneration
    const listeners: HotkeyHostListeners = {
      host,
      generation,
      shortcut: (bindingId) => this.handleHotkeyHostShortcut(host, generation, bindingId),
      unavailable: (error) => this.handleHotkeyHostUnavailable(host, generation, error),
    }
    this.hotkeyHost = host
    this.hotkeyHostListeners = listeners
    host.on("shortcut", listeners.shortcut)
    host.on("unavailable", listeners.unavailable)
    this.updateBrokerStatus(false)
    return host
  }

  private async stopHotkeyHost(host: HotkeyHostController): Promise<void> {
    this.detachHotkeyHost(host)
    if (this.hotkeyHost === host) this.hotkeyHost = null
    await host.shutdown().catch(() => undefined)
    this.updateBrokerStatus(false)
  }

  private async markHotkeyHostUnavailable(host: HotkeyHostController, error: Error): Promise<void> {
    this.detachHotkeyHost(host)
    if (this.hotkeyHost === host) this.hotkeyHost = null
    await host.shutdown().catch(() => undefined)
    this.surfaceLostBrokerBindings(error.message)
  }

  private handleHotkeyHostShortcut(
    host: HotkeyHostController,
    generation: number,
    bindingId: string,
  ): void {
    if (!this.isCurrentHotkeyHost(host, generation)) return
    if (this.bindingReplacementInProgress) return
    if (!this.brokerBindings.some((binding) => binding.bindingId === bindingId)) return
    const binding = this.workflowStore?.shortcutBindings.find((candidate) =>
      candidate.enabled && candidate.id === bindingId,
    )
    // Unknown/stale IDs are ignored. The broker never receives actions and the
    // committed workflow document remains the only action authority.
    if (binding === undefined) return
    void this.handleShortcut(binding.action).catch((error: unknown) => {
      this.emitFailure(
        error,
        binding.action.type === "workflow.run" ? binding.action.workflowId : undefined,
      )
    })
  }

  private handleHotkeyHostUnavailable(
    host: HotkeyHostController,
    generation: number,
    error: Error,
  ): void {
    if (!this.isCurrentHotkeyHost(host, generation)) return
    this.detachHotkeyHost(host)
    this.hotkeyHost = null
    this.surfaceLostBrokerBindings(error.message)
    const bindingGeneration = this.brokerBindingGeneration
    const shouldRecover = !this.shuttingDown &&
      !this.bindingReplacementInProgress &&
      this.brokerBindings.length > 0 &&
      this.lastBrokerRecoveryGeneration !== bindingGeneration
    if (shouldRecover) this.lastBrokerRecoveryGeneration = bindingGeneration

    const cleanup = host.shutdown().catch(() => undefined)
    if (this.brokerRecoveryTask !== null) {
      void cleanup
      return
    }
    const task = cleanup.then(async () => {
      if (shouldRecover) await this.recoverHotkeyHostOnce(bindingGeneration)
    })
    this.trackBrokerRecoveryTask(task)
  }

  private async attemptCommittedBrokerRecovery(): Promise<boolean> {
    if (this.shuttingDown || this.bindingReplacementInProgress || this.brokerBindings.length === 0) {
      return false
    }
    const lifecycleTask = this.brokerRecoveryTask
    if (lifecycleTask !== null) await lifecycleTask.catch(() => undefined)
    if (this.shuttingDown || this.bindingReplacementInProgress || this.brokerBindings.length === 0) {
      return false
    }
    if (this.hotkeyHost?.available === true) return true

    const bindingGeneration = this.brokerBindingGeneration
    if (this.lastBrokerRecoveryGeneration === bindingGeneration) return false
    this.lastBrokerRecoveryGeneration = bindingGeneration
    const recovery = this.recoverHotkeyHostOnce(bindingGeneration)
    this.trackBrokerRecoveryTask(recovery.then(() => undefined))
    return recovery
  }

  private async recoverHotkeyHostOnce(bindingGeneration: number): Promise<boolean> {
    if (
      this.shuttingDown ||
      this.bindingReplacementInProgress ||
      bindingGeneration !== this.brokerBindingGeneration ||
      this.brokerBindings.length === 0
    ) return false

    const expectedBindings = this.brokerBindings.map((binding) => ({ ...binding }))
    const host = await this.ensureHotkeyHost()
    if (host === null) return false
    if (
      this.shuttingDown ||
      this.bindingReplacementInProgress ||
      bindingGeneration !== this.brokerBindingGeneration
    ) {
      await this.stopHotkeyHost(host)
      return false
    }

    try {
      const result = await replaceBrokerBindings(
        host,
        expectedBindings,
        allowsExactHookFallback(expectedBindings),
      )
      if (
        this.shuttingDown ||
        this.bindingReplacementInProgress ||
        bindingGeneration !== this.brokerBindingGeneration ||
        this.hotkeyHost !== host
      ) {
        await this.stopHotkeyHost(host)
        return false
      }
      const fullyApplied = result.applied &&
        result.rollbackComplete &&
        result.bindings.length === expectedBindings.length &&
        result.bindings.every((binding, index) =>
          binding.registered && binding.bindingId === expectedBindings[index]?.bindingId,
        )
      if (!fullyApplied) {
        if (!result.rollbackComplete) {
          await this.markHotkeyHostUnavailable(
            host,
            new NativeEngineError(
              "SHORTCUT_ROLLBACK_FAILED",
              "The native shortcut broker could not recover its previous bindings.",
            ),
          )
        } else {
          await this.stopHotkeyHost(host)
        }
        return false
      }
      this.brokerRegistrations = result.bindings.map(brokerRegistration)
      this.clearRecoveredBrokerFailures(result.hookActive)
      return true
    } catch (recoveryError) {
      await this.markHotkeyHostUnavailable(host, asNativeEngineError(recoveryError))
      return false
    }
  }

  private trackBrokerRecoveryTask(task: Promise<void>): void {
    const tracked = task.finally(() => {
      if (this.brokerRecoveryTask === tracked) this.brokerRecoveryTask = null
    })
    this.brokerRecoveryTask = tracked
    void tracked.catch(() => undefined)
  }

  private detachHotkeyHost(host: HotkeyHostController): void {
    const listeners = this.hotkeyHostListeners
    if (listeners === null || listeners.host !== host) return
    host.off("shortcut", listeners.shortcut)
    host.off("unavailable", listeners.unavailable)
    this.hotkeyHostListeners = null
  }

  private isCurrentHotkeyHost(host: HotkeyHostController, generation: number): boolean {
    const listeners = this.hotkeyHostListeners
    return this.hotkeyHost === host &&
      listeners?.host === host &&
      listeners.generation === generation
  }

  private releaseStagedElectronAccelerators(accelerators: ReadonlySet<string>): void {
    for (const accelerator of accelerators) {
      if (!this.unregisterAccelerator(accelerator)) this.registeredAccelerators.add(accelerator)
    }
  }

  private async activateStartupSubset(
    store: WorkflowStore,
    attempted: readonly BindingRegistration[],
  ): Promise<BindingRegistration[]> {
    if (this.shuttingDown) {
      throw new NativeEngineError("ENGINE_SHUTTING_DOWN", "SharpShot is shutting down.")
    }
    this.bindingReplacementInProgress = true
    this.workflowStore = structuredClone(store)
    const attemptedById = new Map(attempted.map((binding) => [binding.bindingId, binding] as const))
    const results = store.shortcutBindings.map((binding): BindingRegistration => {
      const result = attemptedById.get(binding.id)
      if (result?.registered === true && result.backend !== "electron") {
        return {
          bindingId: binding.id,
          registered: false,
          reason: "The native shortcut broker exited during startup.",
        }
      }
      if (!binding.enabled || result?.backend !== "electron" || !result.registered) {
        return result === undefined ? {
          bindingId: binding.id,
          registered: false,
          reason: binding.enabled ? "This shortcut could not be registered at startup." : "Disabled",
        } : { ...result }
      }
      const accelerator = toElectronAccelerator(binding.accelerator)
      const registered = this.registeredAccelerators.has(accelerator) || this.registerAccelerator(accelerator)
      if (registered) {
        this.registeredAccelerators.add(accelerator)
        return { bindingId: binding.id, registered: true, backend: "electron" }
      }
      return {
        bindingId: binding.id,
        registered: false,
        reason: "Windows or another app claimed this shortcut during startup.",
      }
    })

    const resultById = new Map(results.map((result) => [result.bindingId, result] as const))
    const eligibleBrokerBindings = store.shortcutBindings
      .filter((binding) => {
        const result = resultById.get(binding.id)
        return binding.enabled && result?.registered !== true &&
          (binding.accelerator === "Win+Shift+A" || binding.accelerator === "Win+Shift+D")
      })
      .map((binding) => ({ bindingId: binding.id, accelerator: binding.accelerator }))

    try {
      if (eligibleBrokerBindings.length > 0) {
        const host = await this.ensureHotkeyHost()
        if (host !== null) {
          try {
            const brokerResult = await replaceBrokerBindings(host, eligibleBrokerBindings, true)
            if (brokerResult.applied && brokerResult.rollbackComplete) {
              this.brokerBindings = eligibleBrokerBindings.map((binding) => ({ ...binding }))
              this.brokerRegistrations = brokerResult.bindings.map(brokerRegistration)
              this.advanceBrokerBindingGeneration()
              for (const registration of this.brokerRegistrations) {
                resultById.set(registration.bindingId, registration)
              }
              this.updateBrokerStatus(brokerResult.hookActive)
            } else if (!brokerResult.rollbackComplete) {
              await this.markHotkeyHostUnavailable(
                host,
                new NativeEngineError("SHORTCUT_ROLLBACK_FAILED", "The native shortcut broker failed during startup."),
              )
            } else {
              await this.stopHotkeyHost(host)
            }
          } catch (error) {
            await this.markHotkeyHostUnavailable(host, asNativeEngineError(error))
          }
        }
      }
      return store.shortcutBindings.map((binding) => resultById.get(binding.id) as BindingRegistration)
    } finally {
      this.bindingReplacementInProgress = false
    }
  }

  private setShortcutFailures(bindings: readonly BindingRegistration[]): void {
    const shortcutFailures = bindings
      .filter((binding) => !binding.registered && binding.reason !== "Disabled")
      .map((binding) => ({ ...binding }))
    this.setStatus({
      ...this.status,
      shortcutBrokerAvailable: this.hotkeyHost?.available === true,
      shortcutHookActive: this.brokerRegistrations.some((binding) => binding.backend === "hook"),
      shortcutFailures,
    })
  }

  private clearShortcutFailures(hookActive: boolean): void {
    const { shortcutFailures: _shortcutFailures, ...status } = this.status
    this.setStatus({
      ...status,
      shortcutBrokerAvailable: this.hotkeyHost?.available === true,
      shortcutHookActive: hookActive,
    })
  }

  private clearRecoveredBrokerFailures(hookActive: boolean): void {
    const brokerBindingIds = new Set(this.brokerBindings.map((binding) => binding.bindingId))
    const shortcutFailures = this.status.shortcutFailures
      ?.filter((failure) => !brokerBindingIds.has(failure.bindingId))
      .map((failure) => ({ ...failure }))
    const { shortcutFailures: _shortcutFailures, ...status } = this.status
    this.setStatus({
      ...status,
      shortcutBrokerAvailable: this.hotkeyHost?.available === true,
      shortcutHookActive: hookActive,
      ...(shortcutFailures !== undefined && shortcutFailures.length > 0 ? { shortcutFailures } : {}),
    })
  }

  private updateBrokerStatus(hookActive: boolean): void {
    this.setStatus({
      ...this.status,
      shortcutBrokerAvailable: this.hotkeyHost?.available === true,
      shortcutHookActive: hookActive,
    })
  }

  private surfaceLostBrokerBindings(message: string): void {
    const brokerBindingIds = new Set(this.brokerBindings.map((binding) => binding.bindingId))
    const otherFailures = this.status.shortcutFailures
      ?.filter((failure) => !brokerBindingIds.has(failure.bindingId))
      .map((failure) => ({ ...failure })) ?? []
    const shortcutFailures = this.brokerBindings.map((binding) => ({
      bindingId: binding.bindingId,
      registered: false,
      reason: `The native shortcut broker stopped; this shortcut is unavailable. ${message}`.slice(0, MAX_ERROR_LENGTH),
    }))
    this.setStatus({
      ...this.status,
      shortcutBrokerAvailable: false,
      shortcutHookActive: false,
      shortcutFailures: [...otherFailures, ...shortcutFailures],
    })
  }

  private advanceBrokerBindingGeneration(): void {
    this.brokerBindingGeneration += 1
    this.lastBrokerRecoveryGeneration = null
  }

  private assertPendingBindingReplacement(transaction: PreparedBindingReplacement): void {
    if (this.pendingBindingReplacement !== transaction) {
      throw new NativeEngineError("INVALID_BINDING_TRANSACTION", "That shortcut update is no longer pending.")
    }
  }

  private unregisterAccelerator(accelerator: string): boolean {
    try {
      globalShortcut.unregister(accelerator)
      return true
    } catch {
      // Electron's API is specified as void, but teardown must remain safe if
      // the app is already quitting or the platform shortcut service is gone.
      return false
    }
  }

  private requireAvailable(): void {
    if (this.shuttingDown) {
      throw new NativeEngineError("ENGINE_SHUTTING_DOWN", "SharpShot is shutting down.")
    }
    if (!this.status.available || this.helperPath === null) {
      throw new NativeEngineError("ENGINE_UNAVAILABLE", this.status.reason ?? "Native capture is unavailable.")
    }
  }

  private setOperationState(state: EngineOperationState, workflowId?: string): void {
    this.setStatus({ ...this.status, operationState: state })
    this.emit("event", { name: "state.changed", payload: { state, workflowId } })
  }

  private setStatus(status: EngineStatus): void {
    this.status = {
      ...status,
      shortcutFailures: status.shortcutFailures?.map((failure) => ({ ...failure })),
    }
    this.emit("status", this.getStatus())
  }

  private emitFailure(error: unknown, workflowId?: string): void {
    const code = error instanceof NativeEngineError ? error.code : "ENGINE_ERROR"
    const message = error instanceof Error ? error.message.slice(0, MAX_ERROR_LENGTH) : "Native capture failed."
    this.emit("event", {
      name: "operation.failed",
      payload: { workflowId, code, message },
    })
  }

  private unregisterTrackedShortcuts(): void {
    if (this.pendingBindingReplacement !== null) {
      for (const accelerator of this.pendingBindingReplacement.stagedElectronAccelerators) {
        this.unregisterAccelerator(accelerator)
      }
      this.pendingBindingReplacement = null
    }
    this.bindingReplacementInProgress = false
    for (const accelerator of this.registeredAccelerators) this.unregisterAccelerator(accelerator)
    this.registeredAccelerators.clear()
  }
}

function allowsExactHookFallback(bindings: readonly HotkeyHostBinding[]): boolean {
  return bindings.length > 0 && bindings.every((binding) =>
    binding.accelerator === "Win+Shift+A" || binding.accelerator === "Win+Shift+D",
  )
}

function replaceBrokerBindings(
  host: HotkeyHostController,
  bindings: readonly HotkeyHostBinding[],
  allowHookFallback: boolean,
): Promise<HotkeyHostReplaceResult> {
  return host.replaceBindings(bindings, allowHookFallback)
}

function brokerRegistration(result: HotkeyHostBindingResult): BindingRegistration {
  return {
    bindingId: result.bindingId,
    registered: result.registered,
    backend: result.backend,
    reason: result.reason,
  }
}

function asNativeEngineError(error: unknown): Error {
  return error instanceof Error ? error : new Error("The native shortcut broker failed.")
}

export function guardNativeOperationPipes(
  child: Pick<ChildProcessWithoutNullStreams, "stdout" | "stderr">,
  onError: (error: Error) => void,
): void {
  let handled = false
  const handleError = (error: Error): void => {
    if (handled) return
    handled = true
    onError(error)
  }
  child.stdout.on("error", handleError)
  child.stderr.on("error", handleError)
}

function toElectronAccelerator(accelerator: string): string {
  return accelerator
    .split("+")
    .map((token) => (token === "Win" ? "Super" : token))
    .join("+")
}

async function readOneShotResult(path: string): Promise<OneShotResult> {
  const contents = await readFile(path)
  if (contents.length > MAX_RESULT_BYTES) throw new NativeEngineError("INVALID_RESULT", "Native result is too large.")
  const values = new Map<string, string>()
  for (const rawLine of contents.toString("utf8").split(/\r?\n/)) {
    const index = rawLine.indexOf("=")
    if (index <= 0) continue
    values.set(rawLine.slice(0, index), rawLine.slice(index + 1))
  }
  if (values.get("protocol") !== String(PROTOCOL_VERSION)) {
    throw new NativeEngineError("PROTOCOL_MISMATCH", "Native result uses an unsupported protocol.")
  }
  const status = values.get("status")
  if (status !== "completed" && status !== "cancelled" && status !== "failed") {
    throw new NativeEngineError("INVALID_RESULT", "Native result has an invalid status.")
  }
  return {
    status,
    path: decodeBase64(values.get("path64")),
    width: parseResultInteger(values.get("width")),
    height: parseResultInteger(values.get("height")),
    durationMs: parseResultInteger(values.get("durationMs")),
    clipboard: values.get("clipboard") === "true",
    cursorPath: decodeBase64(values.get("cursorPath64")),
    systemAudioPath: decodeBase64(values.get("systemAudioPath64")),
    microphonePath: decodeBase64(values.get("microphonePath64")),
    error: decodeBase64(values.get("error64")),
  }
}

function parseResultInteger(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function decodeBase64(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined
  try {
    const result = Buffer.from(value, "base64").toString("utf8")
    return result.length > 32_767 ? undefined : result
  } catch {
    return undefined
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs)
    child.once("exit", () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

function requestRecordingStop(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.stdin.destroyed || child.stdin.writableEnded) return
  try {
    child.stdin.write("stop\n", () => undefined)
  } catch {
    // Exit won the race; the exit/completion handler owns finalization.
  }
}
