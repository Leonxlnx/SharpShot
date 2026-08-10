import { randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { extname, isAbsolute, relative, resolve, sep } from "node:path"
import { Readable } from "node:stream"
import { BrowserWindow, protocol, session, type WebContents } from "electron"
import {
  IPC_EVENTS,
  parseAppRoute,
  type AppRoute,
  type WindowAction,
  type WindowCloseRequest,
} from "../shared/api.js"
import {
  renderProcessGoneDiagnostic,
  rendererLoadFailureDiagnostic,
  reportRuntimeDiagnostic,
  safeErrorRecord,
  type RendererLoadTarget,
  type RuntimeDiagnostic,
  type RuntimeDiagnosticReporter,
} from "./runtime-diagnostics.js"

const APP_SCHEME = "sharpshot-app"
const APP_HOST = "app"

const PRODUCTION_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: sharpshot-media:",
  "media-src 'self' blob: sharpshot-media:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
].join("; ")

const DEVELOPMENT_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: sharpshot-media:",
  "media-src 'self' blob: sharpshot-media:",
  "font-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:* http://localhost:*",
  "worker-src 'self' blob:",
].join("; ")

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

export function registerRendererProtocol(rendererDirectory: string): void {
  const root = resolve(rendererDirectory)
  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse(405, "Method not allowed", { Allow: "GET, HEAD" })
    }

    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return textResponse(400, "Invalid URL")
    }
    if (url.protocol !== `${APP_SCHEME}:` || url.hostname !== APP_HOST) {
      return textResponse(404, "Not found")
    }

    let decodedPath: string
    try {
      decodedPath = decodeURIComponent(url.pathname)
    } catch {
      return textResponse(400, "Invalid URL")
    }
    const requested = decodedPath.replace(/^\/+/, "") || "index.html"
    const filePath = resolve(root, requested)
    if (!isPathInside(root, filePath)) return textResponse(404, "Not found")

    try {
      const file = await stat(filePath)
      if (!file.isFile()) return textResponse(404, "Not found")
      const headers = new Headers({
        "Cache-Control": requested === "index.html" ? "no-store" : "public, max-age=31536000, immutable",
        "Content-Length": String(file.size),
        "Content-Security-Policy": PRODUCTION_CSP,
        "Content-Type": MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      })
      if (request.method === "HEAD") return new Response(null, { status: 200, headers })
      const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>
      return new Response(body, { status: 200, headers })
    } catch {
      return textResponse(404, "Not found")
    }
  })
}

export function installSessionHardening(developmentServerUrl?: string): void {
  const currentSession = session.defaultSession
  currentSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  currentSession.setPermissionCheckHandler(() => false)
  currentSession.setDevicePermissionHandler(() => false)
  currentSession.webRequest.onHeadersReceived((details, callback) => {
    const trusted = isTrustedRendererUrl(details.url, developmentServerUrl)
    if (!trusted) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [developmentServerUrl === undefined ? PRODUCTION_CSP : DEVELOPMENT_CSP],
        "Cross-Origin-Opener-Policy": ["same-origin"],
        "Referrer-Policy": ["no-referrer"],
        "X-Content-Type-Options": ["nosniff"],
      },
    })
  })
}

export class WindowManager {
  private readonly preloadPath: string
  private readonly developmentServerUrl?: string
  private readonly onWindowClosed?: () => void
  private readonly onCloseFlushFailed?: (error: Error) => void
  private readonly reportDiagnostic: RuntimeDiagnosticReporter
  private mainWindow: BrowserWindow | null = null
  private pendingRoute: AppRoute = "home"
  private routeReadyWindow: BrowserWindow | null = null
  private allowNextWindowClose = false
  private windowCloseTask: Promise<void> | null = null
  private pendingRendererFlush: {
    requestId: string
    window: BrowserWindow
    promise: Promise<void>
    resolve(): void
    reject(error: Error): void
    timeout: NodeJS.Timeout
  } | null = null

  constructor(options: {
    preloadPath: string
    developmentServerUrl?: string
    onWindowClosed?: () => void
    onCloseFlushFailed?: (error: Error) => void
    reportDiagnostic?: RuntimeDiagnosticReporter
  }) {
    this.preloadPath = options.preloadPath
    this.developmentServerUrl = options.developmentServerUrl
    this.onWindowClosed = options.onWindowClosed
    this.onCloseFlushFailed = options.onCloseFlushFailed
    this.reportDiagnostic = options.reportDiagnostic ?? reportRuntimeDiagnostic
  }

  get window(): BrowserWindow | null {
    return this.mainWindow !== null && !this.mainWindow.isDestroyed() ? this.mainWindow : null
  }

  show(routeValue: AppRoute = "home"): BrowserWindow {
    const route = parseAppRoute(routeValue)
    this.pendingRoute = route
    let window = this.window
    if (window === null) {
      window = this.createWindow()
      this.mainWindow = window
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    this.sendPendingRoute(window)
    return window
  }

  rendererReady(): boolean {
    const window = this.window
    if (window === null || window.webContents.isDestroyed()) return false
    this.routeReadyWindow = window
    this.sendPendingRoute(window)
    return true
  }

  performWindowAction(action: WindowAction): boolean {
    const window = this.window
    if (window === null) return false
    if (action === "minimize") window.minimize()
    else if (action === "maximize") {
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
    } else window.close()
    return true
  }

  requestRendererFlush(reason: WindowCloseRequest["reason"]): Promise<void> {
    const window = this.window
    if (window === null || window.webContents.isDestroyed()) return Promise.resolve()
    const pending = this.pendingRendererFlush
    if (pending !== null && pending.window === window) return pending.promise

    const requestId = randomUUID()
    let resolveRequest: (() => void) | undefined
    let rejectRequest: ((error: Error) => void) | undefined
    const promise = new Promise<void>((resolve, reject) => {
      resolveRequest = resolve
      rejectRequest = reject
    })
    const timeout = setTimeout(() => {
      const current = this.pendingRendererFlush
      if (current?.requestId !== requestId) return
      this.pendingRendererFlush = null
      current.reject(new Error("The editor did not confirm its final save within five seconds."))
    }, 5_000)
    this.pendingRendererFlush = {
      requestId,
      window,
      promise,
      resolve: resolveRequest ?? (() => undefined),
      reject: rejectRequest ?? (() => undefined),
      timeout,
    }
    try {
      window.webContents.send(IPC_EVENTS.windowCloseRequested, { requestId, reason } satisfies WindowCloseRequest)
    } catch (error) {
      this.rejectRendererFlush(
        error instanceof Error ? error : new Error("The editor could not receive the final-save request."),
      )
    }
    return promise
  }

  completeRendererFlush(requestId: string): boolean {
    const pending = this.pendingRendererFlush
    if (pending === null || pending.requestId !== requestId || pending.window !== this.window) return false
    this.pendingRendererFlush = null
    clearTimeout(pending.timeout)
    pending.resolve()
    return true
  }

  broadcast(channel: string, value: unknown): void {
    const window = this.window
    if (window === null || window.webContents.isDestroyed()) return
    try {
      window.webContents.send(channel, value)
    } catch {
      // A renderer can disappear between the destroyed check and send. Main-
      // process capture/export work must not fail because a UI window closed.
    }
  }

  isTrustedSender(webContents: WebContents, frameUrl?: string): boolean {
    if (webContents !== this.window?.webContents) return false
    return isTrustedRendererUrl(frameUrl ?? webContents.getURL(), this.developmentServerUrl)
  }

  destroy(): void {
    this.rejectRendererFlush(new Error("The editor window closed before its final save completed."))
    const window = this.window
    this.mainWindow = null
    this.routeReadyWindow = null
    if (window !== null) window.destroy()
  }

  private createWindow(): BrowserWindow {
    const window = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 940,
      minHeight: 640,
      show: false,
      frame: false,
      title: "SharpShot Studio",
      backgroundColor: "#171819",
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
      },
    })

    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    window.webContents.on("did-start-loading", () => {
      if (this.routeReadyWindow === window) this.routeReadyWindow = null
    })
    window.webContents.on("will-navigate", (event, url) => {
      if (!isTrustedRendererUrl(url, this.developmentServerUrl)) event.preventDefault()
    })
    window.webContents.on("will-attach-webview", (event) => event.preventDefault())
    window.webContents.on("render-process-gone", (_event, details) => {
      this.emitDiagnostic(renderProcessGoneDiagnostic(details))
      this.rejectRendererFlush(new Error("The editor stopped before its final save completed."))
      if (!window.isDestroyed()) window.destroy()
    })
    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) window.show()
    })
    window.on("close", (event) => {
      if (this.allowNextWindowClose) {
        this.allowNextWindowClose = false
        return
      }
      event.preventDefault()
      if (this.windowCloseTask !== null) return
      const task = this.requestRendererFlush("window").then(() => {
        if (window.isDestroyed()) return
        this.allowNextWindowClose = true
        window.close()
      }).catch((error: unknown) => {
        this.onCloseFlushFailed?.(
          error instanceof Error ? error : new Error("The editor could not complete its final save."),
        )
      }).finally(() => {
        if (this.windowCloseTask === task) this.windowCloseTask = null
      })
      this.windowCloseTask = task
    })
    window.on("closed", () => {
      this.rejectRendererFlush(new Error("The editor window closed before its final save completed."))
      if (this.mainWindow === window) this.mainWindow = null
      if (this.routeReadyWindow === window) this.routeReadyWindow = null
      this.onWindowClosed?.()
    })

    const rendererUrl = this.developmentServerUrl ?? `${APP_SCHEME}://${APP_HOST}/index.html`
    const loadTarget: RendererLoadTarget = this.developmentServerUrl === undefined
      ? "packaged-app"
      : "development-loopback"
    this.observeRendererLoad(window, loadTarget, () => window.loadURL(rendererUrl))
    return window
  }

  private observeRendererLoad(
    window: BrowserWindow,
    target: RendererLoadTarget,
    load: () => Promise<void>,
  ): void {
    let pending: Promise<void>
    try {
      pending = load()
    } catch (error) {
      pending = Promise.reject(error)
    }
    void pending.catch((error: unknown) => {
      this.emitDiagnostic(rendererLoadFailureDiagnostic(target, error))
      // A failed initial navigation cannot produce a usable editor. Destroying
      // it releases Chromium resources and lets the next tray click retry with
      // a fresh renderer instead of reusing a permanently blank window.
      if (!window.isDestroyed()) window.destroy()
    })
  }

  private emitDiagnostic(diagnostic: RuntimeDiagnostic): void {
    try {
      this.reportDiagnostic(diagnostic)
    } catch (error) {
      // Diagnostics must never turn a caught renderer failure into a second,
      // unhandled main-process exception.
      console.error("SharpShot's window diagnostic reporter failed.", safeErrorRecord(error))
    }
  }

  private sendPendingRoute(window: BrowserWindow): void {
    if (this.routeReadyWindow !== window || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send(IPC_EVENTS.navigate, this.pendingRoute)
  }

  private rejectRendererFlush(error: Error): void {
    const pending = this.pendingRendererFlush
    if (pending === null) return
    this.pendingRendererFlush = null
    clearTimeout(pending.timeout)
    pending.reject(error)
  }
}

export function isTrustedRendererUrl(value: string, developmentServerUrl?: string): boolean {
  try {
    const candidate = new URL(value)
    if (developmentServerUrl !== undefined) {
      const development = new URL(developmentServerUrl)
      return candidate.origin === development.origin
    }
    return candidate.protocol === `${APP_SCHEME}:` && candidate.hostname === APP_HOST
  } catch {
    return false
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
}

function textResponse(status: number, message: string, headers?: Record<string, string>): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  })
}
