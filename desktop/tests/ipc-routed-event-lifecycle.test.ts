import { EventEmitter } from "node:events"
import { basename } from "node:path"
import { describe, expect, it, vi } from "vitest"

const electronMocks = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}))
const muxMocks = vi.hoisted(() => ({
  mux: vi.fn(),
}))

vi.mock("electron", () => ({
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
  ipcMain: {
    handle: electronMocks.handle,
    removeHandler: electronMocks.removeHandler,
  },
  shell: {
    openExternal: vi.fn(),
    showItemInFolder: vi.fn(),
  },
}))

vi.mock("../src/main/audio-stem-mux.js", () => ({
  muxQuickVideoAudio: muxMocks.mux,
}))

import { registerIpcHandlers } from "../src/main/ipc.js"

function media(path: string, kind: "video" | "audio") {
  return {
    id: `${kind}-${basename(path)}`,
    name: basename(path),
    kind,
    origin: "recording" as const,
    mimeType: kind === "video" ? "video/mp4" : "audio/wav",
    byteLength: 1,
    createdAt: new Date(0).toISOString(),
    modifiedAt: new Date(0).toISOString(),
    url: `sharpshot-media://asset/${kind}-${basename(path)}`,
  }
}

describe("routed capture event lifecycle", () => {
  it("keeps the recording and warns when optional cursor metadata cannot register", async () => {
    const engine = new EventEmitter() as EventEmitter & {
      getStatus(): {
        mode: "native"
        available: true
        operationState: "idle"
        protocolVersion: 1
      }
    }
    engine.getStatus = () => ({
      mode: "native",
      available: true,
      operationState: "idle",
      protocolVersion: 1,
    })
    const registered: ReturnType<typeof media>[] = []
    const storage = {
      drainMetadataMutations: vi.fn(async () => undefined),
      getSettings: vi.fn(() => ({ launchAtLogin: false, closeToTray: true })),
      getWorkflowStore: vi.fn(() => ({ schemaVersion: 1, workflows: [], shortcutBindings: [] })),
      listMedia: vi.fn(() => [...registered]),
      registerMediaFile: vi.fn(async (
        path: string,
        _origin: string,
        options?: { cursorMetadataPath?: string },
      ) => {
        if (options?.cursorMetadataPath !== undefined) throw new Error("invalid cursor sidecar")
        const item = media(path, "video")
        registered.push(item)
        return item
      }),
    }
    const windows = {
      broadcast: vi.fn(),
      show: vi.fn(),
      window: null,
    }
    const lifecycle = registerIpcHandlers({
      appVersion: "0.1.0-test",
      storage: storage as never,
      engine: engine as never,
      windows: windows as never,
      resourcesDirectory: "C:\\SharpShot\\resources",
      developmentRoot: "C:\\SharpShot\\desktop",
      exportDirectory: "C:\\SharpShot\\exports",
      allowMediaPathFallback: false,
      updateLoginItem: vi.fn(),
    })

    engine.emit("event", {
      name: "record.completed",
      payload: {
        workflowId: "studio-video",
        operationId: "operation-cursor-failure",
        workflowKind: "video",
        finishClipboard: "none",
        finishAfterCapture: "open-library",
        path: "C:\\SharpShot\\recording.mp4",
        cursorPath: "C:\\SharpShot\\recording.cursor.jsonl",
        width: 1920,
        height: 1080,
        durationMs: 1_000,
        clipboard: false,
      },
    })

    await vi.waitFor(() => expect(windows.broadcast).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: "record.completed",
        warnings: ["The recording was saved, but editable cursor metadata is unavailable."],
      }),
    ))
    expect(storage.registerMediaFile).toHaveBeenNthCalledWith(
      1,
      "C:\\SharpShot\\recording.mp4",
      "recording",
      { cursorMetadataPath: "C:\\SharpShot\\recording.cursor.jsonl" },
    )
    expect(storage.registerMediaFile).toHaveBeenNthCalledWith(
      2,
      "C:\\SharpShot\\recording.mp4",
      "recording",
    )
    expect(registered).toEqual([expect.objectContaining({ name: "recording.mp4", kind: "video" })])

    await lifecycle.dispose()
  })

  it("aborts a stalled Quick audio mux before IPC disposal waits for it", async () => {
    muxMocks.mux.mockImplementationOnce((_request: unknown, options: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("mux aborted for shutdown"), { name: "AbortError" }))
        }, { once: true })
      }))

    const engine = new EventEmitter() as EventEmitter & {
      getStatus(): {
        mode: "native"
        available: true
        operationState: "idle"
        protocolVersion: 1
      }
    }
    engine.getStatus = () => ({
      mode: "native",
      available: true,
      operationState: "idle",
      protocolVersion: 1,
    })
    const registered: ReturnType<typeof media>[] = []
    const storage = {
      drainMetadataMutations: vi.fn(async () => undefined),
      getSettings: vi.fn(() => ({ launchAtLogin: false, closeToTray: true })),
      getWorkflowStore: vi.fn(() => ({ schemaVersion: 1, workflows: [], shortcutBindings: [] })),
      listMedia: vi.fn(() => [...registered]),
      registerMediaFile: vi.fn(async (path: string, _origin: string) => {
        const item = media(path, path.endsWith(".wav") ? "audio" : "video")
        registered.push(item)
        return item
      }),
    }
    const windows = {
      broadcast: vi.fn(),
      show: vi.fn(),
      window: null,
    }
    const lifecycle = registerIpcHandlers({
      appVersion: "0.1.0-test",
      storage: storage as never,
      engine: engine as never,
      windows: windows as never,
      resourcesDirectory: "C:\\SharpShot\\resources",
      developmentRoot: "C:\\SharpShot\\desktop",
      exportDirectory: "C:\\SharpShot\\exports",
      allowMediaPathFallback: false,
      updateLoginItem: vi.fn(),
    })

    engine.emit("event", {
      name: "record.completed",
      payload: {
        workflowId: "quick-video",
        operationId: "operation-1",
        workflowKind: "video",
        finishClipboard: "file",
        finishAfterCapture: "open-library",
        path: "C:\\SharpShot\\recording.mp4",
        systemAudioPath: "C:\\SharpShot\\recording.system.wav",
        width: 1920,
        height: 1080,
        durationMs: 1_000,
        clipboard: false,
      },
    })
    await vi.waitFor(() => expect(muxMocks.mux).toHaveBeenCalledOnce())

    await lifecycle.dispose()

    expect(storage.registerMediaFile).toHaveBeenCalledWith(
      "C:\\SharpShot\\recording.mp4",
      "recording",
    )
    expect(registered.map((item) => item.kind)).toEqual(["video", "audio"])
    expect(windows.show).not.toHaveBeenCalled()
    expect(windows.broadcast).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: "record.completed" }),
    )
  })
})
