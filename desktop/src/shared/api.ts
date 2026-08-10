import type { WorkflowStore } from "./workflows.js"
import type { ZoomSegment } from "./cursor-zoom.js"
import {
  validateProject,
  type EditorProject,
  type OutputFormat,
} from "./project.js"

export type { ShortcutBinding, Workflow, WorkflowStore } from "./workflows.js"
export type { EditorProject, OutputFormat } from "./project.js"

export const IPC_CHANNELS = {
  bootstrap: "app:bootstrap",
  windowAction: "window:action",
  windowCloseReady: "window:close-ready",
  windowRouteReady: "window:route-ready",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  workflowsGet: "workflows:get",
  workflowsReplace: "workflows:replace",
  workflowsRemove: "workflows:remove",
  libraryList: "library:list",
  libraryImport: "library:import",
  libraryRemove: "library:remove",
  libraryReveal: "library:reveal",
  foldersReveal: "folders:reveal",
  engineStatus: "engine:status",
  engineRunWorkflow: "engine:run-workflow",
  engineStop: "engine:stop",
  engineCancel: "engine:cancel",
  projectsList: "projects:list",
  projectsLoad: "projects:load",
  projectsSave: "projects:save",
  projectsAutosave: "projects:autosave",
  projectsFlush: "projects:flush",
  projectsGenerateAutoZoom: "projects:generate-auto-zoom",
  exportStart: "export:start",
  exportCancel: "export:cancel",
  exportProbe: "export:probe",
  exportStatus: "export:status",
  systemOpenExternal: "system:open-external",
} as const

export const IPC_EVENTS = {
  engine: "event:engine",
  navigate: "event:navigate",
  libraryChanged: "event:library-changed",
  export: "event:export",
  windowCloseRequested: "event:window-close-requested",
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
export type IpcEventChannel = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS]

export type ApiError = {
  code: string
  message: string
}

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ApiError }

export type ThemePreference = "system" | "light" | "dark"
export type OutputFolderId = "screenshots" | "recordings" | "exports"

export type AppSettings = {
  schemaVersion: 1
  launchAtLogin: boolean
  closeToTray: boolean
  showNotifications: boolean
  theme: ThemePreference
}

export type AppCapabilities = {
  quickVideoAudioMux: boolean
}

export type SettingsPatch = Partial<
  Pick<AppSettings, "launchAtLogin" | "closeToTray" | "showNotifications" | "theme">
>

export type MediaKind = "image" | "video" | "audio"
export type MediaOrigin = "capture" | "recording" | "import" | "export" | "background"

export type MediaItem = {
  id: string
  name: string
  kind: MediaKind
  origin: MediaOrigin
  mimeType: string
  byteLength: number
  createdAt: string
  modifiedAt: string
  url: string
  cursorMetadataAvailable?: boolean
}

export type ProjectSummary = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  durationUs: number
  clipCount: number
  thumbnailMediaId?: string
}

export type ProjectSaveResult = {
  project: EditorProject
  autosave: boolean
}

export type ProjectFlushResult = {
  flushedProjectIds: string[]
}

export type AutoZoomGenerateRequest = {
  projectId: string
  assetId: string
}

export type ExportQuality = "small" | "balanced" | "high" | "lossless-ish"

export type ExportStartRequest = {
  projectId: string
  format?: OutputFormat
  width?: number
  height?: number
  fps?: 15 | 30 | 60
  quality?: ExportQuality
  includeAudio?: boolean
  suggestedName?: string
}

export type ExportStartResult =
  | { started: false }
  | { started: true; jobId: string; fileName: string }

export type MediaVideoProbe = {
  codec: string
  profile?: string
  pixelFormat?: string
  width: number
  height: number
  frameRate?: number
  durationUs?: number
  rotationDegrees: number
}

export type MediaAudioProbe = {
  codec: string
  sampleRate?: number
  channels?: number
  channelLayout?: string
  durationUs?: number
}

export type MediaProbe = {
  mediaId: string
  formatName?: string
  formatLongName?: string
  durationUs?: number
  sizeBytes?: number
  bitRate?: number
  video?: MediaVideoProbe
  audio?: MediaAudioProbe
}

export type ExportEvent =
  | {
      type: "progress"
      jobId: string
      phase: "preparing" | "palette" | "rendering" | "validating"
      fraction: number
      outTimeUs: number
      frame?: number
      fps?: number
      speed?: string
    }
  | {
      type: "completed"
      jobId: string
      media: MediaItem
      durationUs: number
      warnings: string[]
    }
  | { type: "cancelled"; jobId: string }
  | {
      type: "completed-unindexed"
      jobId: string
      fileName: string
      durationUs: number
      warnings: string[]
      error: ApiError
    }
  | { type: "failed"; jobId: string; error: ApiError }

export type ExportJobSnapshot = {
  jobId: string
  fileName: string
  state: "queued" | "running" | "completed" | "completed-unindexed" | "cancelled" | "failed"
  progress?: Extract<ExportEvent, { type: "progress" }>
  media?: MediaItem
  durationUs?: number
  warnings?: string[]
  error?: ApiError
}

export type EngineMode = "connecting" | "native" | "mock" | "degraded"
export type EngineOperationState =
  | "idle"
  | "selecting"
  | "countdown"
  | "recording"
  | "finalizing"
  | "unavailable"

export type BindingRegistration = {
  bindingId: string
  registered: boolean
  backend?: "electron" | "register-hot-key" | "hook"
  reason?: string
}

export type EngineStatus = {
  mode: EngineMode
  available: boolean
  operationState: EngineOperationState
  protocolVersion: number | null
  reason?: string
  shortcutBrokerAvailable?: boolean
  shortcutHookActive?: boolean
  shortcutFailures?: BindingRegistration[]
}

export type WorkflowRegistrationFailure = {
  code: "SHORTCUT_REGISTRATION_FAILED"
  message: string
  bindingIds: string[]
}

export type WorkflowStoreUpdate =
  | {
      store: WorkflowStore
      bindings: BindingRegistration[]
      applied: true
    }
  | {
      store: WorkflowStore
      bindings: BindingRegistration[]
      applied: false
      registrationFailure: WorkflowRegistrationFailure
    }

export type EngineActionRequest = {
  workflowId: string
}

export type EngineActionAccepted = {
  accepted: boolean
  operationId?: string
}

export type EngineEvent =
  | { type: "status"; status: EngineStatus }
  | { type: "state.changed"; state: EngineOperationState; workflowId?: string }
  | { type: "shortcut.triggered"; workflowId: string }
  | { type: "screenshot.completed"; workflowId: string; media?: MediaItem }
  | {
      type: "record.started"
      workflowId: string
      operationId?: string
      width?: number
      height?: number
      framesPerSecond?: number
    }
  | {
      type: "record.processing"
      workflowId: string
      stage: "muxing-audio"
      fraction: number
    }
  | {
      type: "record.completed"
      workflowId: string
      media?: MediaItem
      systemAudio?: MediaItem
      microphoneAudio?: MediaItem
      clipboardReady?: boolean
      audioRequiresMux?: boolean
      warnings?: string[]
      durationMs?: number
      framesCaptured?: number
      framesDropped?: number
    }
  | { type: "operation.cancelled"; workflowId?: string }
  | { type: "operation.failed"; workflowId?: string; code: string; message: string }

export type AppRoute = "home" | "library" | "workflows" | "settings" | `editor/${string}`
export type WindowAction = "minimize" | "maximize" | "close"
export type WindowCloseRequest = {
  requestId: string
  reason: "window" | "quit"
}

export type BundledAudioTrack = {
  id: string
  title: string
  creator: string
  durationUs: number
  sampleRate: number
  channels: number
  license: "CC0-1.0"
  url: string
}

export type AppBootstrap = {
  appVersion: string
  capabilities: AppCapabilities
  settings: AppSettings
  workflowStore: WorkflowStore
  library: MediaItem[]
  audioCatalog: BundledAudioTrack[]
  engine: EngineStatus
}

export type SharpShotApi = {
  getBootstrap(): Promise<ApiResult<AppBootstrap>>
  windowAction(action: WindowAction): Promise<ApiResult<boolean>>
  completeWindowClose(requestId: string): Promise<ApiResult<boolean>>
  completeRouteReady(): Promise<ApiResult<boolean>>
  onWindowCloseRequested(listener: (request: WindowCloseRequest) => void): () => void
  settings: {
    get(): Promise<ApiResult<AppSettings>>
    update(patch: SettingsPatch): Promise<ApiResult<AppSettings>>
  }
  workflows: {
    get(): Promise<ApiResult<WorkflowStore>>
    replace(store: WorkflowStore): Promise<ApiResult<WorkflowStoreUpdate>>
    remove(workflowId: string): Promise<ApiResult<WorkflowStoreUpdate>>
  }
  library: {
    list(): Promise<ApiResult<MediaItem[]>>
    import(): Promise<ApiResult<MediaItem[]>>
    remove(id: string): Promise<ApiResult<boolean>>
    reveal(id: string): Promise<ApiResult<boolean>>
  }
  folders: {
    reveal(id: OutputFolderId): Promise<ApiResult<boolean>>
  }
  engine: {
    status(): Promise<ApiResult<EngineStatus>>
    runWorkflow(request: EngineActionRequest): Promise<ApiResult<EngineActionAccepted>>
    stop(): Promise<ApiResult<EngineActionAccepted>>
    cancel(): Promise<ApiResult<EngineActionAccepted>>
    onEvent(listener: (event: EngineEvent) => void): () => void
  }
  projects: {
    list(): Promise<ApiResult<ProjectSummary[]>>
    load(projectId: string): Promise<ApiResult<EditorProject>>
    save(project: EditorProject): Promise<ApiResult<ProjectSaveResult>>
    autosave(project: EditorProject): Promise<ApiResult<ProjectSaveResult>>
    flush(projectId?: string): Promise<ApiResult<ProjectFlushResult>>
    generateAutoZoom(request: AutoZoomGenerateRequest): Promise<ApiResult<ZoomSegment[]>>
  }
  exporter: {
    start(request: ExportStartRequest): Promise<ApiResult<ExportStartResult>>
    cancel(jobId: string): Promise<ApiResult<boolean>>
    probe(mediaId: string): Promise<ApiResult<MediaProbe>>
    status(jobId?: string): Promise<ApiResult<ExportJobSnapshot | null>>
    onEvent(listener: (event: ExportEvent) => void): () => void
  }
  system: {
    openExternal(url: string): Promise<ApiResult<boolean>>
  }
  onNavigate(listener: (route: AppRoute) => void): () => void
  onLibraryChanged(listener: (items: MediaItem[]) => void): () => void
}

export class ValidationError extends Error {
  readonly code = "INVALID_ARGUMENT"

  constructor(message: string) {
    super(message)
    this.name = "ValidationError"
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ValidationError(`${name} contains an unsupported field: ${key}`)
  }
}

function parseBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new ValidationError(`${name} must be a boolean.`)
  return value
}

function parseEnum<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new ValidationError(`${name} has an unsupported value.`)
  }
  return value as T
}

export function parseIdentifier(value: unknown, name = "id"): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new ValidationError(`${name} is invalid.`)
  }
  return value
}

export function parseSettings(value: unknown): AppSettings {
  if (!isPlainObject(value)) throw new ValidationError("Settings must be an object.")
  assertOnlyKeys(
    value,
    ["schemaVersion", "launchAtLogin", "closeToTray", "showNotifications", "theme"],
    "Settings",
  )
  if (value.schemaVersion !== 1) throw new ValidationError("Unsupported settings schema.")
  return {
    schemaVersion: 1,
    launchAtLogin: parseBoolean(value.launchAtLogin, "launchAtLogin"),
    closeToTray: parseBoolean(value.closeToTray, "closeToTray"),
    showNotifications: parseBoolean(value.showNotifications, "showNotifications"),
    theme: parseEnum(value.theme, ["system", "light", "dark"] as const, "theme"),
  }
}

export function parseSettingsPatch(value: unknown): SettingsPatch {
  if (!isPlainObject(value)) throw new ValidationError("Settings update must be an object.")
  assertOnlyKeys(value, ["launchAtLogin", "closeToTray", "showNotifications", "theme"], "Settings update")
  const patch: SettingsPatch = {}
  if ("launchAtLogin" in value) patch.launchAtLogin = parseBoolean(value.launchAtLogin, "launchAtLogin")
  if ("closeToTray" in value) patch.closeToTray = parseBoolean(value.closeToTray, "closeToTray")
  if ("showNotifications" in value) {
    patch.showNotifications = parseBoolean(value.showNotifications, "showNotifications")
  }
  if ("theme" in value) patch.theme = parseEnum(value.theme, ["system", "light", "dark"] as const, "theme")
  if (Object.keys(patch).length === 0) throw new ValidationError("Settings update is empty.")
  return patch
}

export function parseEngineActionRequest(value: unknown): EngineActionRequest {
  if (!isPlainObject(value)) throw new ValidationError("Engine request must be an object.")
  assertOnlyKeys(value, ["workflowId"], "Engine request")
  return { workflowId: parseIdentifier(value.workflowId, "workflowId") }
}

export function parseProject(value: unknown): EditorProject {
  if (!isPlainObject(value)) throw new ValidationError("Project must be an object.")
  assertOnlyKeys(
    value,
    ["magic", "schemaVersion", "id", "title", "createdAt", "updatedAt", "assets", "clips", "canvas", "export", "zoom", "overlays", "audio"],
    "Project",
  )
  validateProject(value)
  return structuredClone(value)
}

export function parseAutoZoomGenerateRequest(value: unknown): AutoZoomGenerateRequest {
  if (!isPlainObject(value)) throw new ValidationError("Auto zoom request must be an object.")
  assertOnlyKeys(value, ["projectId", "assetId"], "Auto zoom request")
  return {
    projectId: parseIdentifier(value.projectId, "projectId"),
    assetId: parseIdentifier(value.assetId, "assetId"),
  }
}

export function parseOptionalIdentifier(value: unknown, name = "id"): string | undefined {
  if (value === undefined || value === null) return undefined
  return parseIdentifier(value, name)
}

export function parseExportStartRequest(value: unknown): ExportStartRequest {
  if (!isPlainObject(value)) throw new ValidationError("Export request must be an object.")
  assertOnlyKeys(
    value,
    ["projectId", "format", "width", "height", "fps", "quality", "includeAudio", "suggestedName"],
    "Export request",
  )
  const request: ExportStartRequest = {
    projectId: parseIdentifier(value.projectId, "projectId"),
  }
  if ("format" in value) request.format = parseEnum(value.format, ["mp4", "gif"] as const, "format")
  if ("width" in value) request.width = parseEvenInteger(value.width, "width", 64, 7_680)
  if ("height" in value) request.height = parseEvenInteger(value.height, "height", 64, 7_680)
  if ("fps" in value) request.fps = parseNumberEnum(value.fps, [15, 30, 60] as const, "fps")
  if ("quality" in value) {
    request.quality = parseEnum(
      value.quality,
      ["small", "balanced", "high", "lossless-ish"] as const,
      "quality",
    )
  }
  if ("includeAudio" in value) request.includeAudio = parseBoolean(value.includeAudio, "includeAudio")
  if ("suggestedName" in value) request.suggestedName = parseSuggestedName(value.suggestedName)
  return request
}

export function parseAllowedExternalUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new ValidationError("External URL is invalid.")
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ValidationError("External URL is invalid.")
  }
  const allowedHosts = new Set(["www.apple.com", "developer.apple.com", "support.apple.com"])
  if (
    url.protocol !== "https:" ||
    !allowedHosts.has(url.hostname.toLowerCase()) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.port.length > 0 && url.port !== "443")
  ) {
    throw new ValidationError("Only approved official Apple HTTPS pages can be opened.")
  }
  return url.href
}

export function parseWindowAction(value: unknown): WindowAction {
  return parseEnum(value, ["minimize", "maximize", "close"] as const, "window action")
}

export function parseOutputFolderId(value: unknown): OutputFolderId {
  return parseEnum(value, ["screenshots", "recordings", "exports"] as const, "output folder")
}

function parseEvenInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ValidationError(`${name} must be an integer from ${minimum} to ${maximum}.`)
  }
  if ((value as number) % 2 !== 0) throw new ValidationError(`${name} must be even.`)
  return value as number
}

function parseNumberEnum<T extends number>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== "number" || !values.includes(value as T)) {
    throw new ValidationError(`${name} has an unsupported value.`)
  }
  return value as T
}

function parseSuggestedName(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("suggestedName must be a string.")
  const name = value.trim()
  if (name.length === 0 || name.length > 120 || /[\\/:*?"<>|\u0000-\u001f]/.test(name)) {
    throw new ValidationError("suggestedName contains unsupported filename characters.")
  }
  return name
}

export function parseAppRoute(value: unknown): AppRoute {
  if (value === "home" || value === "library" || value === "workflows" || value === "settings") return value
  if (typeof value === "string" && /^editor\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    return value as `editor/${string}`
  }
  throw new ValidationError("Route is invalid.")
}

declare global {
  interface Window {
    sharpShot: SharpShotApi
  }
}
