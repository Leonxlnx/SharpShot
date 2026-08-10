import { EventEmitter } from "node:events"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  HotkeyHostBinding,
  HotkeyHostCapabilities,
  HotkeyHostController,
  HotkeyHostReplaceResult,
} from "../src/main/hotkey-host-client.js"
import type { ShortcutAction, ShortcutBinding, WorkflowStore } from "../src/shared/workflows.js"
import { createDefaultWorkflowStore } from "../src/shared/workflows.js"

const shortcutState = vi.hoisted(() => {
  const callbacks = new Map<string, () => void>()
  const owned = new Set<string>()
  return {
    callbacks,
    owned,
    register: vi.fn((accelerator: string, callback: () => void): boolean => {
      if (owned.has(accelerator) || callbacks.has(accelerator)) return false
      callbacks.set(accelerator, callback)
      return true
    }),
    unregister: vi.fn((accelerator: string): void => {
      callbacks.delete(accelerator)
    }),
  }
})

vi.mock("electron", () => ({
  globalShortcut: {
    register: shortcutState.register,
    unregister: shortcutState.unregister,
  },
}))

import { replaceWorkflowStoreTransaction } from "../src/main/ipc.js"
import {
  guardNativeOperationPipes,
  NativeEngine,
  type NativeEngineRawEvent,
} from "../src/main/native-engine.js"

const temporaryRoots: string[] = []
const D = "Super+Shift+D"
const E = "Super+Shift+E"
const A = "Super+Shift+A"
const P = "Ctrl+Shift+P"
const X = "Ctrl+Shift+X"

const CAPABILITIES: HotkeyHostCapabilities = {
  registerHotKey: true,
  lowLevelHookFallback: true,
  hookFallbackAccelerators: ["Win+Shift+A", "Win+Shift+D"],
  transactionalReplace: true,
  parentProcessWait: true,
  stdinEofShutdown: true,
  maxBindings: 64,
  maxLineBytes: 65_536,
}

class FakeHotkeyHost extends EventEmitter implements HotkeyHostController {
  available = false
  readonly capabilities = CAPABILITIES
  readonly replaceCalls: Array<{ bindings: HotkeyHostBinding[]; allowHookFallback: boolean }> = []
  activeBindings: HotkeyHostBinding[] = []
  nextResult: HotkeyHostReplaceResult | null = null
  readonly start = vi.fn(async (): Promise<boolean> => {
    this.available = true
    return true
  })
  readonly shutdown = vi.fn(async (): Promise<void> => {
    this.available = false
    this.activeBindings = []
  })

  async replaceBindings(
    bindings: readonly HotkeyHostBinding[],
    allowHookFallback = false,
  ): Promise<HotkeyHostReplaceResult> {
    const copied = bindings.map((binding) => ({ ...binding }))
    this.replaceCalls.push({ bindings: copied, allowHookFallback })
    if (this.nextResult !== null) {
      const result = this.nextResult
      this.nextResult = null
      return structuredClone(result)
    }
    this.activeBindings = copied
    return {
      applied: true,
      rollbackComplete: true,
      hookActive: allowHookFallback && copied.length > 0,
      bindings: copied.map((binding) => ({
        bindingId: binding.bindingId,
        registered: true,
        backend: allowHookFallback ? "hook" : "register-hot-key",
      })),
    }
  }

  emitShortcut(bindingId: string): void {
    this.emit("shortcut", bindingId)
  }

  emitUnavailable(message = "host exited"): void {
    this.available = false
    this.emit("unavailable", new Error(message))
  }
}

function binding(id: string, accelerator: string, action: ShortcutAction): ShortcutBinding {
  return { version: 1, id, accelerator, enabled: true, action }
}

function appOpen(page: "library" | "workflows" | "settings"): ShortcutAction {
  return { type: "app.open", page }
}

function storeWith(...shortcutBindings: ShortcutBinding[]): WorkflowStore {
  return { ...createDefaultWorkflowStore(), shortcutBindings }
}

async function fixture(hostSequence?: FakeHotkeyHost[]): Promise<{
  engine: NativeEngine
  host: FakeHotkeyHost
  hosts: FakeHotkeyHost[]
  factory: ReturnType<typeof vi.fn>
}> {
  const root = await mkdtemp(join(tmpdir(), "sharpshot-hotkey-broker-"))
  temporaryRoots.push(root)
  const helper = join(root, "SharpShot.exe")
  const results = join(root, "results")
  const resources = join(root, "resources")
  await Promise.all([writeFile(helper, "not launched"), mkdir(resources, { recursive: true })])
  const hosts = hostSequence ?? [new FakeHotkeyHost()]
  const host = hosts[0] as FakeHotkeyHost
  let nextHost = 0
  const factory = vi.fn(() => hosts[Math.min(nextHost++, hosts.length - 1)] as FakeHotkeyHost)
  const engine = new NativeEngine({
    resourcesDirectory: resources,
    resultDirectory: results,
    developmentHelperPath: helper,
    hotkeyHostFactory: factory,
  })
  await engine.start()
  return { engine, host, hosts, factory }
}

function memoryStorage(initial: WorkflowStore, failWrite = false) {
  let durable = structuredClone(initial)
  return {
    getWorkflowStore: vi.fn(() => structuredClone(durable)),
    prepareWorkflowStore: vi.fn((value: unknown) => structuredClone(value as WorkflowStore)),
    replaceWorkflowStore: vi.fn(async (value: unknown): Promise<WorkflowStore> => {
      if (failWrite) throw new Error("disk full")
      durable = structuredClone(value as WorkflowStore)
      return structuredClone(durable)
    }),
  }
}

afterEach(async () => {
  shortcutState.callbacks.clear()
  shortcutState.owned.clear()
  shortcutState.register.mockClear()
  shortcutState.unregister.mockClear()
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it("contains native capture stdout and stderr pipe failures exactly once", () => {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const onError = vi.fn()
  guardNativeOperationPipes(
    { stdout, stderr } as unknown as Parameters<typeof guardNativeOperationPipes>[0],
    onError,
  )

  const first = new Error("stdout pipe failed")
  stdout.emit("error", first)
  stderr.emit("error", new Error("stderr pipe failed"))
  stdout.emit("error", new Error("stdout failed again"))

  expect(onError).toHaveBeenCalledOnce()
  expect(onError).toHaveBeenCalledWith(first)
})

describe("NativeEngine lazy hotkey broker", () => {
  it("rejects capture dispatch once shutdown begins", async () => {
    const { engine } = await fixture()
    const workflow = createDefaultWorkflowStore().workflows[0]
    if (workflow === undefined) throw new Error("default capture workflow is missing")

    await engine.shutdown()

    await expect(engine.runWorkflow(workflow)).rejects.toMatchObject({
      code: "ENGINE_SHUTTING_DOWN",
    })
  })

  it("starts lazily and gives every enabled shortcut exactly one backend", async () => {
    const { engine, host, factory } = await fixture()
    expect(factory).not.toHaveBeenCalled()
    shortcutState.owned.add(D)
    const store = storeWith(
      binding("broker-d", "Win+Shift+D", appOpen("library")),
      binding("electron-e", "Win+Shift+E", appOpen("settings")),
    )

    const results = await engine.replaceBindings(store)

    expect(factory).toHaveBeenCalledOnce()
    expect(host.start).toHaveBeenCalledOnce()
    expect(host.replaceCalls).toEqual([{
      bindings: [{ bindingId: "broker-d", accelerator: "Win+Shift+D" }],
      allowHookFallback: true,
    }])
    expect(results).toEqual([
      { bindingId: "broker-d", registered: true, backend: "hook", reason: undefined },
      { bindingId: "electron-e", registered: true, backend: "electron" },
    ])
    expect([...shortcutState.callbacks.keys()]).toEqual([E])
    expect(engine.getStatus()).toMatchObject({ shortcutBrokerAvailable: true, shortcutHookActive: true })

    const events: NativeEngineRawEvent[] = []
    engine.on("event", (event) => events.push(event))
    host.emitShortcut("broker-d")
    expect(events.at(-1)).toEqual({ name: "app.open", payload: { page: "library" } })
  })

  it("keeps successful startup globals live when a custom Windows-owned chord has no eligible fallback", async () => {
    const { engine, factory } = await fixture()
    shortcutState.owned.add(X)
    const store = storeWith(
      binding("electron-e", "Win+Shift+E", appOpen("settings")),
      binding("owned-x", "Ctrl+Shift+X", appOpen("library")),
    )

    const results = await engine.replaceBindings(store)

    expect(factory).not.toHaveBeenCalled()
    expect(results).toEqual([
      { bindingId: "electron-e", registered: true, backend: "electron" },
      {
        bindingId: "owned-x",
        registered: false,
        reason: "The native shortcut broker is unavailable for this Windows-owned shortcut.",
      },
    ])
    expect([...shortcutState.callbacks.keys()]).toEqual([E])
    expect(engine.getStatus().shortcutFailures?.map((failure) => failure.bindingId)).toEqual(["owned-x"])
  })

  it("brokers eligible startup shortcuts without hiding an unrelated custom conflict", async () => {
    const { engine, host, factory } = await fixture()
    shortcutState.owned.add(D)
    shortcutState.owned.add(X)
    const store = storeWith(
      binding("broker-d", "Win+Shift+D", appOpen("library")),
      binding("electron-e", "Win+Shift+E", appOpen("settings")),
      binding("owned-x", "Ctrl+Shift+X", appOpen("workflows")),
    )

    const results = await engine.replaceBindings(store)

    expect(factory).toHaveBeenCalledOnce()
    expect(host.replaceCalls).toEqual([{
      bindings: [{ bindingId: "broker-d", accelerator: "Win+Shift+D" }],
      allowHookFallback: true,
    }])
    expect(results).toEqual([
      { bindingId: "broker-d", registered: true, backend: "hook", reason: undefined },
      { bindingId: "electron-e", registered: true, backend: "electron" },
      {
        bindingId: "owned-x",
        registered: false,
        reason: "The native shortcut broker is unavailable for this Windows-owned shortcut.",
      },
    ])
    expect([...shortcutState.callbacks.keys()]).toEqual([E])
    expect(engine.getStatus()).toMatchObject({
      shortcutBrokerAvailable: true,
      shortcutHookActive: true,
      shortcutFailures: [expect.objectContaining({ bindingId: "owned-x", registered: false })],
    })
  })

  it("restores the prior broker set and removes staged globals when persistence fails", async () => {
    const { engine, host } = await fixture()
    shortcutState.owned.add(D)
    shortcutState.owned.add(A)
    const prior = storeWith(
      binding("broker-d", "Win+Shift+D", appOpen("library")),
      binding("electron-e", "Win+Shift+E", appOpen("settings")),
    )
    await engine.replaceBindings(prior)
    const candidate = storeWith(
      ...prior.shortcutBindings,
      binding("broker-a", "Win+Shift+A", appOpen("workflows")),
      binding("electron-p", "Ctrl+Shift+P", appOpen("library")),
    )

    await expect(replaceWorkflowStoreTransaction(memoryStorage(prior, true), engine, candidate)).rejects.toThrow("disk full")

    expect(host.replaceCalls.map((call) => call.bindings.map((binding) => binding.bindingId))).toEqual([
      ["broker-d"],
      ["broker-d", "broker-a"],
      ["broker-d"],
    ])
    expect(host.replaceCalls.every((call) => call.allowHookFallback)).toBe(true)
    expect(host.activeBindings).toEqual([{ bindingId: "broker-d", accelerator: "Win+Shift+D" }])
    expect([...shortcutState.callbacks.keys()]).toEqual([E])
    expect(shortcutState.unregister).toHaveBeenCalledWith(P)
  })

  it("disables hook fallback for a mixed broker candidate set and preserves the committed set on rejection", async () => {
    const { engine, host } = await fixture()
    shortcutState.owned.add(D)
    shortcutState.owned.add(X)
    const prior = storeWith(binding("broker-d", "Win+Shift+D", appOpen("settings")))
    await engine.replaceBindings(prior)
    host.nextResult = {
      applied: false,
      rollbackComplete: true,
      hookActive: true,
      bindings: [
        { bindingId: "broker-d", registered: false, reason: "replacement rolled back" },
        { bindingId: "owned-x", registered: false, reason: "Windows owns it" },
      ],
    }

    const results = await engine.replaceBindings(storeWith(
      binding("broker-d", "Win+Shift+D", appOpen("library")),
      binding("owned-x", "Ctrl+Shift+X", appOpen("workflows")),
    ))

    expect(host.replaceCalls.at(-1)).toMatchObject({ allowHookFallback: false })
    expect(results.every((result) => !result.registered)).toBe(true)
    expect(host.activeBindings).toEqual([{ bindingId: "broker-d", accelerator: "Win+Shift+D" }])
  })

  it("recovers the committed broker set when the host dies during binding preparation", async () => {
    const host = new FakeHotkeyHost()
    const recoveredHost = new FakeHotkeyHost()
    const { engine, factory } = await fixture([host, recoveredHost])
    shortcutState.owned.add(D)
    shortcutState.owned.add(A)
    const prior = storeWith(binding("broker-d", "Win+Shift+D", appOpen("library")))
    await engine.replaceBindings(prior)
    vi.spyOn(host, "replaceBindings").mockImplementationOnce(async () => {
      host.emitUnavailable("pipe closed during replace")
      throw new Error("pipe closed during replace")
    })
    const candidate = storeWith(
      binding("broker-d", "Win+Shift+D", appOpen("settings")),
      binding("broker-a", "Win+Shift+A", appOpen("workflows")),
    )

    const result = await replaceWorkflowStoreTransaction(memoryStorage(prior), engine, candidate)

    expect(result.applied).toBe(false)
    expect(result.store).toEqual(prior)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(recoveredHost.activeBindings).toEqual([{ bindingId: "broker-d", accelerator: "Win+Shift+D" }])
    expect(engine.getStatus()).toMatchObject({ shortcutBrokerAvailable: true, shortcutHookActive: true })
    expect(engine.getStatus().shortcutFailures).toBeUndefined()
  })

  it("rolls durable storage back and preserves globals if the broker dies between save and commit", async () => {
    const host = new FakeHotkeyHost()
    const recoveredHost = new FakeHotkeyHost()
    const { engine, factory } = await fixture([host, recoveredHost])
    shortcutState.owned.add(D)
    shortcutState.owned.add(A)
    const prior = storeWith(
      binding("broker-d", "Win+Shift+D", appOpen("library")),
      binding("electron-e", "Win+Shift+E", appOpen("settings")),
    )
    await engine.replaceBindings(prior)
    const candidate = storeWith(
      ...prior.shortcutBindings,
      binding("broker-a", "Win+Shift+A", appOpen("workflows")),
      binding("electron-p", "Ctrl+Shift+P", appOpen("library")),
    )
    const storage = memoryStorage(prior)
    storage.replaceWorkflowStore.mockImplementationOnce(async (value: unknown) => {
      host.emitUnavailable("pipe closed during save")
      return structuredClone(value as WorkflowStore)
    })

    await expect(replaceWorkflowStoreTransaction(storage, engine, candidate)).rejects.toMatchObject({
      code: "SHORTCUT_BROKER_LOST",
    })

    expect(storage.getWorkflowStore()).toEqual(prior)
    expect([...shortcutState.callbacks.keys()]).toEqual([E])
    expect(factory).toHaveBeenCalledTimes(2)
    expect(recoveredHost.activeBindings).toEqual([{ bindingId: "broker-d", accelerator: "Win+Shift+D" }])
    expect(engine.getStatus()).toMatchObject({ shortcutBrokerAvailable: true, shortcutHookActive: true })
    expect(engine.getStatus().shortcutFailures).toBeUndefined()
  })

  it("ignores stale or Electron-backed broker events and surfaces broker loss without dropping globals", async () => {
    const { engine, host } = await fixture()
    shortcutState.owned.add(D)
    const store = storeWith(
      binding("broker-d", "Win+Shift+D", appOpen("library")),
      binding("electron-e", "Win+Shift+E", appOpen("settings")),
    )
    await engine.replaceBindings(store)
    const events: NativeEngineRawEvent[] = []
    engine.on("event", (event) => events.push(event))

    host.emitShortcut("electron-e")
    host.emitShortcut("stale-id")
    expect(events).toHaveLength(0)

    host.emitUnavailable("pipe closed")
    expect(engine.getStatus()).toMatchObject({
      shortcutBrokerAvailable: false,
      shortcutHookActive: false,
      shortcutFailures: [expect.objectContaining({ bindingId: "broker-d", registered: false })],
    })
    shortcutState.callbacks.get(E)?.()
    expect(events.at(-1)).toEqual({ name: "app.open", payload: { page: "settings" } })
    host.emitShortcut("broker-d")
    expect(events).toHaveLength(1)
  })

  it("recovers committed broker shortcuts once after an unexpected host exit", async () => {
    const firstHost = new FakeHotkeyHost()
    const recoveredHost = new FakeHotkeyHost()
    const { engine, factory } = await fixture([firstHost, recoveredHost])
    shortcutState.owned.add(D)
    await engine.replaceBindings(storeWith(
      binding("broker-d", "Win+Shift+D", appOpen("library")),
      binding("electron-e", "Win+Shift+E", appOpen("settings")),
    ))
    const events: NativeEngineRawEvent[] = []
    engine.on("event", (event) => events.push(event))

    firstHost.emitUnavailable("pipe closed")

    await vi.waitFor(() => {
      expect(factory).toHaveBeenCalledTimes(2)
      expect(engine.getStatus()).toMatchObject({
        shortcutBrokerAvailable: true,
        shortcutHookActive: true,
      })
      expect(engine.getStatus().shortcutFailures).toBeUndefined()
    })
    expect(recoveredHost.replaceCalls).toEqual([{
      bindings: [{ bindingId: "broker-d", accelerator: "Win+Shift+D" }],
      allowHookFallback: true,
    }])
    firstHost.emitShortcut("broker-d")
    expect(events).toHaveLength(0)
    recoveredHost.emitShortcut("broker-d")
    expect(events.at(-1)).toEqual({ name: "app.open", payload: { page: "library" } })

    recoveredHost.emitUnavailable("second pipe failure")
    await vi.waitFor(() => expect(recoveredHost.shutdown).toHaveBeenCalled())
    expect(factory).toHaveBeenCalledTimes(2)
    expect(engine.getStatus().shortcutFailures).toEqual([
      expect.objectContaining({ bindingId: "broker-d", registered: false }),
    ])
  })

  it("keeps the honest failure state when the one recovery attempt cannot rebind", async () => {
    const firstHost = new FakeHotkeyHost()
    const failedRecoveryHost = new FakeHotkeyHost()
    failedRecoveryHost.nextResult = {
      applied: false,
      rollbackComplete: true,
      hookActive: false,
      bindings: [{ bindingId: "broker-d", registered: false, reason: "Windows still owns it" }],
    }
    const { engine, factory } = await fixture([firstHost, failedRecoveryHost])
    shortcutState.owned.add(D)
    await engine.replaceBindings(storeWith(
      binding("broker-d", "Win+Shift+D", appOpen("library")),
      binding("electron-e", "Win+Shift+E", appOpen("settings")),
    ))
    const events: NativeEngineRawEvent[] = []
    engine.on("event", (event) => events.push(event))

    firstHost.emitUnavailable("pipe closed")

    await vi.waitFor(() => expect(failedRecoveryHost.shutdown).toHaveBeenCalled())
    expect(factory).toHaveBeenCalledTimes(2)
    expect(engine.getStatus()).toMatchObject({
      shortcutBrokerAvailable: false,
      shortcutHookActive: false,
      shortcutFailures: [expect.objectContaining({ bindingId: "broker-d", registered: false })],
    })
    shortcutState.callbacks.get(E)?.()
    expect(events.at(-1)).toEqual({ name: "app.open", payload: { page: "settings" } })
  })

  it("cancels an in-flight recovery cleanly when the engine shuts down", async () => {
    const firstHost = new FakeHotkeyHost()
    const recoveryHost = new FakeHotkeyHost()
    let finishStarting: (() => void) | undefined
    recoveryHost.start.mockImplementation(() => new Promise<boolean>((resolve) => {
      finishStarting = () => {
        recoveryHost.available = true
        resolve(true)
      }
    }))
    const { engine, factory } = await fixture([firstHost, recoveryHost])
    shortcutState.owned.add(D)
    await engine.replaceBindings(storeWith(
      binding("broker-d", "Win+Shift+D", appOpen("library")),
      binding("electron-e", "Win+Shift+E", appOpen("settings")),
    ))
    firstHost.emitUnavailable("pipe closed")
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))

    const shutdown = engine.shutdown()
    finishStarting?.()
    await shutdown

    expect(recoveryHost.replaceCalls).toHaveLength(0)
    expect(recoveryHost.shutdown).toHaveBeenCalledOnce()
    expect(factory).toHaveBeenCalledTimes(2)
    expect(shortcutState.callbacks.size).toBe(0)
  })

  it("waits for an in-flight broker preparation before shutdown completes", async () => {
    const host = new FakeHotkeyHost()
    let finishStarting: (() => void) | undefined
    host.start.mockImplementation(() => new Promise<boolean>((resolve) => {
      finishStarting = () => {
        host.available = true
        resolve(true)
      }
    }))
    const { engine, factory } = await fixture([host])
    shortcutState.owned.add(D)
    const bindingUpdate = engine.replaceBindings(storeWith(
      binding("broker-d", "Win+Shift+D", appOpen("library")),
    ))
    await vi.waitFor(() => expect(host.start).toHaveBeenCalledOnce())

    const shutdown = engine.shutdown()
    finishStarting?.()
    await shutdown

    await expect(bindingUpdate).rejects.toMatchObject({ code: "ENGINE_SHUTTING_DOWN" })
    expect(host.shutdown).toHaveBeenCalledOnce()
    expect(factory).toHaveBeenCalledOnce()
    expect(engine.getStatus()).toMatchObject({
      shortcutBrokerAvailable: false,
      shortcutHookActive: false,
    })
    expect(shortcutState.callbacks.size).toBe(0)
  })

  it("shuts the lazy broker down after a durable commit no longer needs fallback bindings", async () => {
    const { engine, host } = await fixture()
    shortcutState.owned.add(D)
    const prior = storeWith(binding("broker-d", "Win+Shift+D", appOpen("library")))
    await engine.replaceBindings(prior)
    shortcutState.owned.delete(D)
    const candidate = storeWith(binding("electron-e", "Win+Shift+E", appOpen("settings")))

    const result = await replaceWorkflowStoreTransaction(memoryStorage(prior), engine, candidate)

    expect(result.applied).toBe(true)
    expect(host.replaceCalls.at(-1)).toMatchObject({ bindings: [] })
    expect(host.shutdown).toHaveBeenCalledOnce()
    expect(engine.getStatus()).toMatchObject({ shortcutBrokerAvailable: false, shortcutHookActive: false })
    expect([...shortcutState.callbacks.keys()]).toEqual([E])
  })
})
