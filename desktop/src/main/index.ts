import { statSync } from "node:fs"
import { dirname, extname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  app,
  dialog,
  Menu,
  nativeImage,
  protocol,
  shell,
  Tray,
} from "electron"
import type { WorkflowKind } from "../shared/workflows.js"
import { resolveSharpShotUserDataDirectory } from "./development-profile.js"
import { registerIpcHandlers, type IpcHandlerLifecycle } from "./ipc.js"
import { NativeEngine } from "./native-engine.js"
import { RuntimeDiagnosticLog } from "./runtime-diagnostic-log.js"
import {
  installAppProcessDiagnostics,
  reportRuntimeDiagnostic,
  safeErrorRecord,
  type RuntimeDiagnostic,
} from "./runtime-diagnostics.js"
import { StorageService } from "./storage.js"
import { loadBundledTrayIcon } from "./tray-icon.js"
import {
  installSessionHardening,
  registerRendererProtocol,
  WindowManager,
} from "./windows.js"

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const developmentServerUrl = app.isPackaged
  ? undefined
  : validatedDevelopmentServerUrl(process.env.ELECTRON_RENDERER_URL)

protocol.registerSchemesAsPrivileged([
  {
    scheme: "sharpshot-app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
    },
  },
  {
    scheme: "sharpshot-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
])

app.enableSandbox()
const isolatedUserDataDirectory = resolveSharpShotUserDataDirectory({
  isPackaged: app.isPackaged,
  appDataDirectory: app.getPath("appData"),
  override: process.env.SHARPSHOT_USER_DATA_DIR,
  allowPackagedOverride: process.argv.includes("--sharpshot-packaged-smoke"),
})
if (isolatedUserDataDirectory !== undefined) app.setPath("userData", isolatedUserDataDirectory)
const ownsSingleInstance = app.requestSingleInstanceLock()
if (!ownsSingleInstance) app.quit()

let windows: WindowManager | null = null
let engine: NativeEngine | null = null
let storage: StorageService | null = null
let tray: Tray | null = null
let ipcLifecycle: IpcHandlerLifecycle | null = null
let runtimeDiagnosticLog: RuntimeDiagnosticLog | null = null
let libraryIndexTask: Promise<void> | null = null
const bufferedRuntimeDiagnostics: RuntimeDiagnostic[] = []
let shutdownStarted = false
let shutdownFinished = false
let loggedShortcutFailureSignature = ""

if (ownsSingleInstance) {
  installAppProcessDiagnostics(app, recordRuntimeDiagnostic)
  app.on("second-instance", () => windows?.show("home"))
  app.on("activate", () => windows?.show("home"))
  app.on("window-all-closed", () => {
    // SharpShot is a tray application. Renderer windows are created lazily and
    // destroyed on close so Chromium memory is released between editing sessions.
  })

  app.whenReady().then(initialize).catch((error: unknown) => {
    console.error("SharpShot failed to initialize.", error)
    app.quit()
  })

  app.on("before-quit", (event) => {
    if (shutdownFinished) return
    event.preventDefault()
    if (shutdownStarted) return
    shutdownStarted = true
    void shutdown().then(() => {
      shutdownFinished = true
      app.quit()
    }).catch((error: unknown) => {
      shutdownStarted = false
      console.error("SharpShot Studio could not shut down safely.", error)
      dialog.showErrorBox(
        "SharpShot Studio could not quit",
        "A project or active capture could not be saved safely. SharpShot Studio is still running; free disk space and try again.",
      )
      windows?.show("home")
    })
  })
}

async function initialize(): Promise<void> {
  app.setAppUserModelId("com.leonlin.sharpshot.studio")

  const resourcesDirectory = app.isPackaged
    ? process.resourcesPath
    : join(app.getAppPath(), "resources")
  const rendererDirectory = join(currentDirectory, "../renderer")
  const preloadPath = resolveSandboxedPreloadPath()
  const userDataDirectory = app.getPath("userData")
  const screenshotsDirectory = join(app.getPath("pictures"), "SharpShot Studio", "Screenshots")
  const recordingsDirectory = join(app.getPath("videos"), "SharpShot Studio", "Recordings")
  const exportDirectory = join(app.getPath("videos"), "SharpShot Studio", "Exports")

  runtimeDiagnosticLog = new RuntimeDiagnosticLog(userDataDirectory)
  try {
    await runtimeDiagnosticLog.initialize()
  } catch (error) {
    console.error("SharpShot could not initialize its local runtime diagnostics.", safeErrorRecord(error))
  }
  for (const diagnostic of bufferedRuntimeDiagnostics.splice(0)) runtimeDiagnosticLog.record(diagnostic)

  registerRendererProtocol(rendererDirectory)
  installSessionHardening(developmentServerUrl)

  storage = new StorageService({
    rootDirectory: userDataDirectory,
    captureDirectory: screenshotsDirectory,
    recordingDirectory: recordingsDirectory,
    resourcesDirectory,
    mediaAccessOrigin: developmentServerUrl ?? "sharpshot-app://app",
  })
  await storage.initialize()

  protocol.handle("sharpshot-media", (request) => {
    if (storage === null) return Promise.resolve(new Response("Unavailable", { status: 503 }))
    return storage.handleMediaRequest(request)
  })

  windows = new WindowManager({
    preloadPath,
    developmentServerUrl,
    reportDiagnostic: recordRuntimeDiagnostic,
    onWindowClosed: () => {
      const currentStorage = storage
      if (shutdownStarted || currentStorage === null) return
      void currentStorage.drainMetadataMutations().then(() => {
        if (!shutdownStarted && storage === currentStorage && currentStorage.getSettings().closeToTray === false) {
          app.quit()
        }
      }).catch((error: unknown) => {
        console.error("SharpShot could not confirm its close-to-tray preference.", safeErrorRecord(error))
      })
    },
    onCloseFlushFailed: (error) => {
      dialog.showErrorBox(
        "SharpShot Studio stayed open",
        `Your latest editor changes were not confirmed as saved, so SharpShot did not close the window. ${error.message}`,
      )
    },
  })
  engine = new NativeEngine({
    resourcesDirectory,
    resultDirectory: join(userDataDirectory, "native-results"),
    developmentHelperPath: join(app.getAppPath(), "..", "artifacts", "SharpShot", "SharpShot.exe"),
    mockMode: process.env.SHARPSHOT_NATIVE_ENGINE_MOCK === "1",
  })

  ipcLifecycle = registerIpcHandlers({
    appVersion: app.getVersion(),
    storage,
    engine,
    windows,
    resourcesDirectory,
    developmentRoot: app.getAppPath(),
    exportDirectory,
    allowMediaPathFallback: !app.isPackaged,
    updateLoginItem,
  })

  try {
    updateLoginItem(storage.getSettings().launchAtLogin)
  } catch (error) {
    console.error("SharpShot could not synchronize its Windows startup preference.", safeErrorRecord(error))
  }
  await engine.start()
  await engine.replaceBindings(storage.getWorkflowStore())

  tray = createTray(resourcesDirectory)
  engine.on("status", rebuildTrayMenu)
  rebuildTrayMenu()

  // Reconcile media committed by the short-lived native helper even if Studio
  // was closed before its completion event arrived. Only SharpShot's exact
  // Screenshots and Recordings directories are scanned.
  const initializedStorage = storage
  libraryIndexTask = initializedStorage.indexExistingCaptures().then(() => {
    windows?.broadcast("event:library-changed", initializedStorage.listMedia())
  }).catch(() => undefined)

  const silentStartup = process.argv.some((argument) => argument === "--startup")
  if (!silentStartup) windows.show("home")
}

function createTray(resourcesDirectory: string): Tray {
  const icon = loadBundledTrayIcon(resourcesDirectory, (path) => nativeImage.createFromPath(path))
  const nextTray = new Tray(icon)
  nextTray.setToolTip("SharpShot Studio")
  nextTray.on("click", () => windows?.show("home"))
  nextTray.on("double-click", () => windows?.show("home"))
  return nextTray
}

function rebuildTrayMenu(): void {
  if (tray === null || storage === null) return
  const settings = storage.getSettings()
  const status = engine?.getStatus()
  const shortcutFailures = status?.shortcutFailures ?? []
  reportShortcutFailures(shortcutFailures)
  const menu = Menu.buildFromTemplate([
    {
      label: "Open SharpShot Studio",
      click: () => windows?.show("home"),
    },
    { type: "separator" },
    {
      label: "Quick screenshot",
      click: () => void runFirstWorkflow("screenshot"),
    },
    {
      label: "Quick recording",
      click: () => void runFirstWorkflow("video"),
    },
    {
      label: "Stop recording",
      enabled: status?.operationState === "recording" || status?.operationState === "finalizing",
      click: () => void engine?.stopRecording(),
    },
    ...(shortcutFailures.length === 0 ? [] : [{
      label: shortcutFailures.length === 1
        ? "Shortcut conflict · Open workflows"
        : `${shortcutFailures.length} shortcut conflicts · Open workflows`,
      click: () => windows?.show("workflows"),
    }]),
    { type: "separator" },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: settings.launchAtLogin,
      click: (item) => {
        void updateLaunchAtLoginFromTray(item.checked).catch((error: unknown) => {
          console.error("SharpShot's startup-setting handler failed.", safeErrorRecord(error))
        })
      },
    },
    {
      label: "Settings",
      click: () => windows?.show("settings"),
    },
    {
      label: "Open diagnostics",
      click: () => void openRuntimeDiagnostics(),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit(),
    },
  ])
  tray.setContextMenu(menu)
}

function recordRuntimeDiagnostic(diagnostic: RuntimeDiagnostic): void {
  reportRuntimeDiagnostic(diagnostic)
  if (runtimeDiagnosticLog !== null) {
    runtimeDiagnosticLog.record(diagnostic)
    return
  }
  if (bufferedRuntimeDiagnostics.length === 64) bufferedRuntimeDiagnostics.shift()
  bufferedRuntimeDiagnostics.push(diagnostic)
}

async function openRuntimeDiagnostics(): Promise<void> {
  const diagnosticLog = runtimeDiagnosticLog
  if (diagnosticLog === null) return
  try {
    await diagnosticLog.flush()
    const errorMessage = await shell.openPath(diagnosticLog.directory)
    if (errorMessage.length > 0) {
      console.error("Windows could not open SharpShot's diagnostics folder.", safeErrorRecord(new Error(errorMessage)))
    }
  } catch (error) {
    console.error("SharpShot could not open its diagnostics folder.", safeErrorRecord(error))
  }
}

function reportShortcutFailures(failures: ReadonlyArray<{ bindingId: string; reason?: string }>): void {
  const signature = JSON.stringify(failures.map((failure) => [failure.bindingId, failure.reason ?? "Unknown"]))
  if (signature === loggedShortcutFailureSignature) return
  loggedShortcutFailureSignature = signature
  if (failures.length === 0) return
  console.error("SharpShot could not register one or more shortcuts.", {
    count: failures.length,
    failures: failures.slice(0, 8).map((failure) => ({
      bindingId: failure.bindingId.slice(0, 128),
      reason: safeErrorRecord(new Error(failure.reason ?? "Unknown")).errorMessage.slice(0, 256),
    })),
    omitted: Math.max(0, failures.length - 8),
  })
}

async function updateLaunchAtLoginFromTray(requested: boolean): Promise<void> {
  const currentStorage = storage
  if (currentStorage === null) return
  const previous = currentStorage.getSettings().launchAtLogin
  try {
    await currentStorage.updateSettingsWithLoginItem({ launchAtLogin: requested }, updateLoginItem)
  } catch (error) {
    console.error("SharpShot could not update its Windows startup preference.", {
      requested,
      previous,
      failure: safeErrorRecord(error),
    })
    try {
      dialog.showErrorBox(
        "Could not update startup setting",
        error instanceof AggregateError
          ? "Windows did not confirm or restore the startup preference. Check SharpShot in Windows Settings > Apps > Startup."
          : "SharpShot kept your previous Start with Windows preference. Try again or change startup apps in Windows Settings.",
      )
    } catch (reportingError) {
      // Keep even secondary reporting failures from becoming an unhandled
      // rejection in Electron's synchronous tray click callback.
      console.error("SharpShot could not show its startup-setting warning.", safeErrorRecord(reportingError))
    }
  } finally {
    try {
      rebuildTrayMenu()
    } catch (error) {
      console.error("SharpShot could not restore its tray menu state.", safeErrorRecord(error))
    }
  }
}

async function runFirstWorkflow(kind: WorkflowKind): Promise<void> {
  if (storage === null || engine === null) return
  const workflow = storage.getWorkflowStore().workflows.find((candidate) => candidate.enabled && candidate.kind === kind)
  if (workflow === undefined || !engine.getStatus().available) {
    windows?.show("workflows")
    return
  }
  try {
    await engine.runWorkflow(workflow)
    rebuildTrayMenu()
  } catch {
    windows?.show("workflows")
  }
}

function updateLoginItem(enabled: boolean): void {
  if (!app.isPackaged) return
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: ["--startup"],
  })
}

async function shutdown(): Promise<void> {
  await windows?.requestRendererFlush("quit")
  await libraryIndexTask
  await storage?.flushProjectAutosaves()
  // Stop accepting renderer work and drain the serialized workflow binding
  // transaction before the engine snapshots/stops its native broker. Engine
  // event routing remains attached until capture shutdown has committed media.
  await ipcLifecycle?.quiesce()
  await engine?.shutdown()
  if (ipcLifecycle !== null) await ipcLifecycle.dispose()
  ipcLifecycle = null
  tray?.destroy()
  tray = null
  windows?.destroy()
  // Let any loadURL rejection caused by window destruction enqueue its
  // sanitized record before the final diagnostics drain.
  await Promise.resolve()
  await runtimeDiagnosticLog?.flush()
  engine = null
  storage = null
  libraryIndexTask = null
}

function validatedDevelopmentServerUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const url = new URL(value)
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  if (url.protocol !== "http:" || !loopback || url.port.length === 0 || url.username.length > 0 || url.password.length > 0) {
    throw new Error("ELECTRON_RENDERER_URL must be an HTTP loopback URL with an explicit port.")
  }
  return url.origin
}

function resolveSandboxedPreloadPath(): string {
  const preloadPath = join(currentDirectory, "../preload/index.cjs")
  if (extname(preloadPath).toLowerCase() !== ".cjs") {
    throw new Error("SharpShot's sandboxed preload must use a CommonJS artifact.")
  }
  try {
    if (statSync(preloadPath).isFile()) return preloadPath
  } catch {
    // Fall through to one clear initialization error below.
  }
  throw new Error("SharpShot's bundled sandboxed preload is missing: out/preload/index.cjs")
}
