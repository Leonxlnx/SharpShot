import { afterEach, describe, expect, it, vi } from "vitest"
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
  BrowserWindow: class {},
  dialog: {},
  globalShortcut: {
    register: shortcutState.register,
    unregister: shortcutState.unregister,
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  protocol: { handle: vi.fn() },
  session: {
    defaultSession: {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      webRequest: { onHeadersReceived: vi.fn() },
    },
  },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
}))

import { replaceWorkflowStoreTransaction } from "../src/main/ipc.js"
import { NativeEngine, type NativeEngineRawEvent } from "../src/main/native-engine.js"

const OLD_ACCELERATOR = "Super+Shift+D"
const NEW_ACCELERATOR = "Super+Shift+X"

function binding(
  id: string,
  accelerator: string,
  action: ShortcutAction,
  enabled = true,
): ShortcutBinding {
  return { version: 1, id, accelerator, enabled, action }
}

function storeWith(...shortcutBindings: ShortcutBinding[]): WorkflowStore {
  return { ...createDefaultWorkflowStore(), shortcutBindings }
}

function appOpen(page: "library" | "workflows" | "settings"): ShortcutAction {
  return { type: "app.open", page }
}

function createEngine(): NativeEngine {
  return new NativeEngine({
    resourcesDirectory: "C:\\SharpShot\\resources",
    resultDirectory: "C:\\SharpShot\\results",
    mockMode: true,
  })
}

function memoryStorage(initial: WorkflowStore, options?: { failWrite?: boolean }) {
  let durable = structuredClone(initial)
  return {
    getWorkflowStore: vi.fn(() => structuredClone(durable)),
    prepareWorkflowStore: vi.fn((value: unknown) => structuredClone(value as WorkflowStore)),
    replaceWorkflowStore: vi.fn(async (value: unknown): Promise<WorkflowStore> => {
      if (options?.failWrite === true) throw new Error("disk full")
      durable = structuredClone(value as WorkflowStore)
      return structuredClone(durable)
    }),
  }
}

afterEach(() => {
  shortcutState.callbacks.clear()
  shortcutState.owned.clear()
  shortcutState.register.mockClear()
  shortcutState.unregister.mockClear()
})

describe("workflow binding transaction", () => {
  it("keeps the prior durable store and live actions when Windows owns a candidate accelerator", async () => {
    const prior = storeWith(binding("old", "Win+Shift+D", appOpen("settings")))
    const candidate = storeWith(
      binding("old", "Win+Shift+D", appOpen("library")),
      binding("owned", "Win+Shift+X", appOpen("workflows")),
    )
    const engine = createEngine()
    await engine.replaceBindings(prior)
    const storage = memoryStorage(prior)
    shortcutState.owned.add(NEW_ACCELERATOR)

    const result = await replaceWorkflowStoreTransaction(storage, engine, candidate)

    expect(result).toMatchObject({
      applied: false,
      store: prior,
      registrationFailure: {
        code: "SHORTCUT_REGISTRATION_FAILED",
        bindingIds: ["owned"],
      },
    })
    expect(storage.replaceWorkflowStore).not.toHaveBeenCalled()
    expect([...shortcutState.callbacks.keys()]).toEqual([OLD_ACCELERATOR])

    const events: NativeEngineRawEvent[] = []
    engine.on("event", (event) => events.push(event))
    shortcutState.callbacks.get(OLD_ACCELERATOR)?.()
    expect(events.at(-1)).toEqual({ name: "app.open", payload: { page: "settings" } })
  })

  it("rejects a partial first registration when there is no prior live binding set", async () => {
    const prior = storeWith()
    const candidate = storeWith(
      binding("available", "Win+Shift+D", appOpen("library")),
      binding("owned", "Win+Shift+X", appOpen("settings")),
    )
    const engine = createEngine()
    const storage = memoryStorage(prior)
    shortcutState.owned.add(NEW_ACCELERATOR)

    const result = await replaceWorkflowStoreTransaction(storage, engine, candidate)

    expect(result.applied).toBe(false)
    expect(shortcutState.unregister).toHaveBeenCalledWith(OLD_ACCELERATOR)
    expect(shortcutState.callbacks.size).toBe(0)
    expect(storage.replaceWorkflowStore).not.toHaveBeenCalled()
  })

  it("retains non-disabled startup registration failures in the surfaced engine status", async () => {
    const candidate = storeWith(
      binding("available", "Win+Shift+D", appOpen("library")),
      binding("owned", "Win+Shift+X", appOpen("settings")),
      binding("disabled", "Ctrl+Shift+P", appOpen("workflows"), false),
    )
    const engine = createEngine()
    shortcutState.owned.add(NEW_ACCELERATOR)

    await engine.replaceBindings(candidate)

    expect(engine.getStatus().shortcutFailures).toEqual([
      {
        bindingId: "owned",
        registered: false,
        reason: "The native shortcut broker is unavailable for this Windows-owned shortcut.",
      },
    ])
    expect([...shortcutState.callbacks.keys()]).toEqual([OLD_ACCELERATOR])
  })

  it("suppresses old and staged shortcut events until durable persistence completes", async () => {
    const prior = storeWith(binding("old", "Win+Shift+D", appOpen("settings")))
    const candidate = storeWith(
      binding("old", "Win+Shift+D", appOpen("library")),
      binding("new", "Win+Shift+X", appOpen("workflows")),
    )
    const engine = createEngine()
    await engine.replaceBindings(prior)
    const events: NativeEngineRawEvent[] = []
    engine.on("event", (event) => events.push(event))
    const storage = memoryStorage(prior)
    storage.replaceWorkflowStore.mockImplementationOnce(async (value: unknown) => {
      expect([...shortcutState.callbacks.keys()].sort()).toEqual([OLD_ACCELERATOR, NEW_ACCELERATOR].sort())
      shortcutState.callbacks.get(OLD_ACCELERATOR)?.()
      expect(events).toHaveLength(0)
      shortcutState.callbacks.get(NEW_ACCELERATOR)?.()
      expect(events).toHaveLength(0)
      return structuredClone(value as WorkflowStore)
    })

    const result = await replaceWorkflowStoreTransaction(storage, engine, candidate)

    expect(result.applied).toBe(true)
    shortcutState.callbacks.get(OLD_ACCELERATOR)?.()
    expect(events.at(-1)).toEqual({ name: "app.open", payload: { page: "library" } })
    shortcutState.callbacks.get(NEW_ACCELERATOR)?.()
    expect(events.at(-1)).toEqual({ name: "app.open", payload: { page: "workflows" } })
  })

  it("aborts staged registrations without disturbing the prior live store when persistence fails", async () => {
    const prior = storeWith(binding("old", "Win+Shift+D", appOpen("settings")))
    const candidate = storeWith(
      binding("old", "Win+Shift+D", appOpen("library")),
      binding("new", "Win+Shift+X", appOpen("workflows")),
    )
    const engine = createEngine()
    await engine.replaceBindings(prior)
    const storage = memoryStorage(prior, { failWrite: true })

    await expect(replaceWorkflowStoreTransaction(storage, engine, candidate)).rejects.toThrow("disk full")

    expect([...shortcutState.callbacks.keys()]).toEqual([OLD_ACCELERATOR])
    const events: NativeEngineRawEvent[] = []
    engine.on("event", (event) => events.push(event))
    shortcutState.callbacks.get(OLD_ACCELERATOR)?.()
    expect(events.at(-1)).toEqual({ name: "app.open", payload: { page: "settings" } })
  })

  it("does not treat a disabled Windows-owned binding as a transaction failure", async () => {
    const prior = storeWith(binding("old", "Win+Shift+D", appOpen("settings")))
    const candidate = storeWith(
      binding("old", "Win+Shift+D", appOpen("settings")),
      binding("disabled", "Win+Shift+X", appOpen("library"), false),
    )
    const engine = createEngine()
    await engine.replaceBindings(prior)
    const storage = memoryStorage(prior)
    shortcutState.owned.add(NEW_ACCELERATOR)

    const result = await replaceWorkflowStoreTransaction(storage, engine, candidate)

    expect(result.applied).toBe(true)
    expect(result.bindings).toContainEqual({ bindingId: "disabled", registered: false, reason: "Disabled" })
    expect(shortcutState.register).not.toHaveBeenCalledWith(NEW_ACCELERATOR, expect.any(Function))
  })

  it("commits removal only after persistence and releases removed accelerators", async () => {
    const prior = storeWith(binding("old", "Win+Shift+D", appOpen("settings")))
    const candidate = storeWith()
    const engine = createEngine()
    await engine.replaceBindings(prior)
    const storage = memoryStorage(prior)

    const result = await replaceWorkflowStoreTransaction(storage, engine, candidate)

    expect(result.applied).toBe(true)
    expect(result.store.shortcutBindings).toEqual([])
    expect(shortcutState.callbacks.size).toBe(0)
    expect(shortcutState.unregister).toHaveBeenCalledWith(OLD_ACCELERATOR)
  })
})
