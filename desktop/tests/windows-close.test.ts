import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const electronState = {
  windows: [] as FakeBrowserWindow[],
  loadError: null as Error | null,
  loadedUrls: [] as string[],
}

class TinyEmitter {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  on(name: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(name) ?? []
    listeners.push(listener)
    this.listeners.set(name, listeners)
    return this
  }

  once(name: string, listener: (...args: unknown[]) => void): this {
    const wrapped = (...args: unknown[]): void => {
      this.removeListener(name, wrapped)
      listener(...args)
    }
    return this.on(name, wrapped)
  }

  emit(name: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(...args)
  }

  removeListener(name: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((candidate) => candidate !== listener))
  }
}

class FakeWebContents extends TinyEmitter {
  readonly sent: Array<{ channel: string; value: unknown }> = []
  destroyed = false

  isDestroyed(): boolean { return this.destroyed }
  isLoadingMainFrame(): boolean { return false }
  getURL(): string { return "sharpshot-app://app/index.html" }
  send(channel: string, value: unknown): void { this.sent.push({ channel, value }) }
  setWindowOpenHandler(): void {}
}

class FakeBrowserWindow extends TinyEmitter {
  readonly webContents = new FakeWebContents()
  destroyed = false
  minimized = false
  maximized = false

  constructor(_options: unknown) {
    super()
    electronState.windows.push(this)
  }

  isDestroyed(): boolean { return this.destroyed }
  isMinimized(): boolean { return this.minimized }
  isMaximized(): boolean { return this.maximized }
  restore(): void { this.minimized = false }
  minimize(): void { this.minimized = true }
  maximize(): void { this.maximized = true }
  unmaximize(): void { this.maximized = false }
  show(): void {}
  focus(): void {}
  loadURL(url: string): Promise<void> {
    electronState.loadedUrls.push(url)
    return electronState.loadError === null ? Promise.resolve() : Promise.reject(electronState.loadError)
  }

  close(): void {
    if (this.destroyed) return
    const event = {
      defaultPrevented: false,
      preventDefault(): void { this.defaultPrevented = true },
    }
    this.emit("close", event)
    if (!event.defaultPrevented) this.destroy()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.webContents.destroyed = true
    this.emit("closed")
  }
}

import { IPC_EVENTS, type WindowCloseRequest } from "../src/shared/api.js"

let WindowManager: typeof import("../src/main/windows.js")["WindowManager"]

function closeRequest(window: FakeBrowserWindow): WindowCloseRequest {
  const sent = window.webContents.sent.find((item) => item.channel === IPC_EVENTS.windowCloseRequested)
  expect(sent).toBeDefined()
  return sent?.value as WindowCloseRequest
}

describe("WindowManager close handshake", () => {
  beforeAll(async () => {
    vi.doMock("electron", () => ({
      BrowserWindow: FakeBrowserWindow,
      protocol: { handle: vi.fn() },
      session: {
        defaultSession: {
          setPermissionRequestHandler: vi.fn(),
          setPermissionCheckHandler: vi.fn(),
          setDevicePermissionHandler: vi.fn(),
          webRequest: { onHeadersReceived: vi.fn() },
        },
      },
    }))
    WindowManager = (await import("../src/main/windows.js")).WindowManager
  })

  beforeEach(() => {
    electronState.windows.length = 0
    electronState.loadError = null
    electronState.loadedUrls.length = 0
    vi.useRealTimers()
  })

  it("keeps a native-close window alive until the renderer confirms durable saves", async () => {
    const manager = new WindowManager({ preloadPath: "C:\\app\\preload\\index.cjs" })
    const window = manager.show() as unknown as FakeBrowserWindow

    window.close()
    expect(window.destroyed).toBe(false)
    const request = closeRequest(window)
    expect(request.reason).toBe("window")
    expect(manager.completeRendererFlush(request.requestId)).toBe(true)

    await vi.waitFor(() => expect(window.destroyed).toBe(true))
  })

  it("keeps the window open after a bounded renderer-save timeout", async () => {
    vi.useFakeTimers()
    const onCloseFlushFailed = vi.fn()
    const manager = new WindowManager({
      preloadPath: "C:\\app\\preload\\index.cjs",
      onCloseFlushFailed,
    })
    const window = manager.show() as unknown as FakeBrowserWindow

    window.close()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(window.destroyed).toBe(false)
    expect(onCloseFlushFailed).toHaveBeenCalledOnce()
  })

  it("lets orderly Quit await the same renderer acknowledgement without closing early", async () => {
    const manager = new WindowManager({ preloadPath: "C:\\app\\preload\\index.cjs" })
    const window = manager.show() as unknown as FakeBrowserWindow

    const pending = manager.requestRendererFlush("quit")
    const request = closeRequest(window)
    expect(request.reason).toBe("quit")
    expect(window.destroyed).toBe(false)
    expect(manager.completeRendererFlush(request.requestId)).toBe(true)
    await expect(pending).resolves.toBeUndefined()
    expect(window.destroyed).toBe(false)
  })

  it("replays only the latest cold-window route after the renderer subscribes", () => {
    const manager = new WindowManager({ preloadPath: "C:\\app\\preload\\index.cjs" })
    const window = manager.show("editor/recording-1") as unknown as FakeBrowserWindow

    manager.show("settings")
    expect(window.webContents.sent.filter((item) => item.channel === IPC_EVENTS.navigate)).toEqual([])

    expect(manager.rendererReady()).toBe(true)
    expect(window.webContents.sent.filter((item) => item.channel === IPC_EVENTS.navigate)).toEqual([
      { channel: IPC_EVENTS.navigate, value: "settings" },
    ])

    manager.show("editor/recording-2")
    expect(window.webContents.sent.filter((item) => item.channel === IPC_EVENTS.navigate).at(-1)).toEqual({
      channel: IPC_EVENTS.navigate,
      value: "editor/recording-2",
    })
  })

  it("requires a fresh route-ready handshake after a renderer reload starts", () => {
    const manager = new WindowManager({ preloadPath: "C:\\app\\preload\\index.cjs" })
    const window = manager.show("home") as unknown as FakeBrowserWindow
    expect(manager.rendererReady()).toBe(true)
    const sentBeforeReload = window.webContents.sent.length

    window.webContents.emit("did-start-loading")
    manager.show("settings")
    expect(window.webContents.sent).toHaveLength(sentBeforeReload)

    expect(manager.rendererReady()).toBe(true)
    expect(window.webContents.sent.at(-1)).toEqual({ channel: IPC_EVENTS.navigate, value: "settings" })
  })

  it("catches a packaged custom-protocol load rejection, logs bounded safe details, and permits a fresh retry", async () => {
    electronState.loadError = Object.assign(
      new Error("ERR_FAILED loading C:\\Users\\Alice\\private\\index.html"),
      { code: -2 },
    )
    const reportDiagnostic = vi.fn()
    const manager = new WindowManager({
      preloadPath: "C:\\app\\preload\\index.cjs",
      reportDiagnostic,
    })
    const window = manager.show() as unknown as FakeBrowserWindow

    await vi.waitFor(() => expect(window.destroyed).toBe(true))
    expect(manager.window).toBeNull()
    expect(electronState.loadedUrls).toEqual(["sharpshot-app://app/index.html"])
    expect(reportDiagnostic).toHaveBeenCalledWith({
      event: "renderer-load-failed",
      target: "packaged-app",
      errorName: "Error",
      errorMessage: "ERR_FAILED loading <redacted-path>",
      errorCode: -2,
    })
  })

  it("catches and identifies a development-loopback load rejection", async () => {
    electronState.loadError = new Error("ERR_CONNECTION_REFUSED")
    const reportDiagnostic = vi.fn()
    const manager = new WindowManager({
      preloadPath: "C:\\app\\preload\\index.cjs",
      developmentServerUrl: "http://127.0.0.1:4174",
      reportDiagnostic,
    })
    const window = manager.show() as unknown as FakeBrowserWindow

    await vi.waitFor(() => expect(window.destroyed).toBe(true))
    expect(electronState.loadedUrls).toEqual(["http://127.0.0.1:4174"])
    expect(reportDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      event: "renderer-load-failed",
      target: "development-loopback",
      errorMessage: "ERR_CONNECTION_REFUSED",
    }))
  })

  it("logs all renderer-gone fields in decimal and Windows-friendly hexadecimal", () => {
    const reportDiagnostic = vi.fn()
    const manager = new WindowManager({
      preloadPath: "C:\\app\\preload\\index.cjs",
      reportDiagnostic,
    })
    const window = manager.show() as unknown as FakeBrowserWindow

    window.webContents.emit("render-process-gone", {}, { reason: "launch-failed", exitCode: -1_073_741_515 })

    expect(reportDiagnostic).toHaveBeenCalledWith({
      event: "render-process-gone",
      processType: "renderer",
      reason: "launch-failed",
      exitCode: -1_073_741_515,
      exitCodeHex: "0xC0000135",
    })
    expect(window.destroyed).toBe(true)
    expect(manager.window).toBeNull()
  })
})
