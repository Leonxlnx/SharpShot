import { randomUUID } from "node:crypto"
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises"
import { basename, dirname, extname, join, parse as parsePath, resolve } from "node:path"
import { Readable } from "node:stream"
import type {
  AppSettings,
  BundledAudioTrack,
  MediaItem,
  MediaKind,
  MediaOrigin,
  OutputFolderId,
  ProjectFlushResult,
  ProjectSaveResult,
  ProjectSummary,
  SettingsPatch,
} from "../shared/api.js"
import type { AudioAsset } from "../shared/audio-timeline.js"
import {
  parseIdentifier,
  parseProject as parseProjectInput,
  parseSettings,
  parseSettingsPatch,
  ValidationError,
} from "../shared/api.js"
import {
  parseProject as parseProjectDocument,
  serializeProject,
  type EditorProject,
  type MediaAsset,
} from "../shared/project.js"
import type { WorkflowStore } from "../shared/workflows.js"
import {
  createDefaultWorkflowStore,
  migratePersistedWorkflowStore,
  removeWorkflow,
  validatePersistedWorkflowStore,
} from "../shared/workflows.js"
import { changeLaunchAtLoginPreference } from "./launch-at-login.js"
import {
  completeQuickVideoMuxRecovery,
  discoverQuickVideoMuxRecoveryBundles,
  type QuickVideoMuxRecoveryBundle,
} from "./quick-video-mux-recovery.js"

const STORAGE_SCHEMA_VERSION = 1
const MAX_MEDIA_ITEMS = 100_000
const MAX_PROJECTS = 10_000
const MAX_PROJECT_BYTES = 16 * 1024 * 1024
const PROJECT_AUTOSAVE_DELAY_MS = 300

const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  launchAtLogin: false,
  closeToTray: true,
  showNotifications: true,
  theme: "system",
}

type StoredMediaItem = Omit<MediaItem, "url"> & {
  path: string
  cursorMetadataPath?: string
}

type SettingsFile = {
  schemaVersion: number
  settings: AppSettings
}

type LibraryFile = {
  schemaVersion: number
  items: StoredMediaItem[]
}

type MediaDescriptor = {
  kind: MediaKind
  mimeType: string
}

type MediaRegistration = {
  path: string
  origin: MediaOrigin
  cursorMetadataPath?: string
  optionalCursorMetadata?: boolean
}

type MediaDirectoryDiscovery = {
  registrations: MediaRegistration[]
  recoveryBundles: QuickVideoMuxRecoveryBundle[]
}

type ByteRange = {
  start: number
  end: number
}

type PendingProjectAutosave = {
  project: EditorProject
  timer: NodeJS.Timeout
  firstQueuedAt: number
  promise: Promise<ProjectSaveResult>
  resolve(value: ProjectSaveResult): void
  reject(error: unknown): void
}

type BundledAsset = {
  key: string
  path: string
  mimeType: string
}

type BundledAudioAsset = BundledAudioTrack & {
  key: string
  path: string
  mimeType: string
}

const MEDIA_TYPES: Readonly<Record<string, MediaDescriptor>> = {
  ".png": { kind: "image", mimeType: "image/png" },
  ".jpg": { kind: "image", mimeType: "image/jpeg" },
  ".jpeg": { kind: "image", mimeType: "image/jpeg" },
  ".webp": { kind: "image", mimeType: "image/webp" },
  ".gif": { kind: "image", mimeType: "image/gif" },
  ".mp4": { kind: "video", mimeType: "video/mp4" },
  ".mov": { kind: "video", mimeType: "video/quicktime" },
  ".webm": { kind: "video", mimeType: "video/webm" },
  ".mkv": { kind: "video", mimeType: "video/x-matroska" },
  ".wav": { kind: "audio", mimeType: "audio/wav" },
  ".mp3": { kind: "audio", mimeType: "audio/mpeg" },
  ".m4a": { kind: "audio", mimeType: "audio/mp4" },
  ".aac": { kind: "audio", mimeType: "audio/aac" },
}

export class StorageError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "StorageError"
    this.code = code
  }
}

export class StorageService {
  private readonly rootDirectory: string
  private readonly captureDirectory: string
  private readonly recordingDirectory: string
  private readonly resourcesDirectory: string
  private readonly projectsDirectory: string
  private readonly settingsPath: string
  private readonly workflowsPath: string
  private readonly libraryPath: string
  private readonly mediaAccessOrigin: string

  private settings: AppSettings = { ...DEFAULT_SETTINGS }
  private workflowStore: WorkflowStore = createDefaultWorkflowStore()
  private mediaItems: StoredMediaItem[] = []
  private readonly mediaById = new Map<string, StoredMediaItem>()
  private readonly mediaIdByPath = new Map<string, string>()
  private readonly projects = new Map<string, EditorProject>()
  private readonly pendingProjectAutosaves = new Map<string, PendingProjectAutosave>()
  private readonly activeProjectWrites = new Map<string, Promise<ProjectSaveResult>>()
  private readonly activeProjectSnapshots = new Map<string, EditorProject>()
  private readonly bundledAssets = new Map<string, BundledAsset>()
  private readonly bundledAudioAssets = new Map<string, BundledAudioAsset>()
  private bundledAudioCatalog: BundledAudioTrack[] = []
  private writeQueue: Promise<void> = Promise.resolve()
  private metadataMutationQueue: Promise<void> = Promise.resolve()

  constructor(options: {
    rootDirectory: string
    captureDirectory: string
    recordingDirectory: string
    resourcesDirectory: string
    mediaAccessOrigin: string
  }) {
    this.rootDirectory = resolve(options.rootDirectory)
    this.captureDirectory = resolve(options.captureDirectory)
    this.recordingDirectory = resolve(options.recordingDirectory)
    this.resourcesDirectory = resolve(options.resourcesDirectory)
    this.projectsDirectory = join(this.rootDirectory, "projects")
    this.settingsPath = join(this.rootDirectory, "settings.json")
    this.workflowsPath = join(this.rootDirectory, "workflows.json")
    this.libraryPath = join(this.rootDirectory, "library.json")
    this.mediaAccessOrigin = options.mediaAccessOrigin
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true })
    await mkdir(this.captureDirectory, { recursive: true })
    await mkdir(this.recordingDirectory, { recursive: true })
    await mkdir(this.projectsDirectory, { recursive: true })

    const settingsFile = await this.readJsonFile<SettingsFile>(this.settingsPath)
    if (settingsFile !== null) {
      try {
        if (settingsFile.schemaVersion !== STORAGE_SCHEMA_VERSION) {
          throw new StorageError("UNSUPPORTED_SCHEMA", "The settings file was created by an unsupported SharpShot version.")
        }
        this.settings = parseSettings(settingsFile.settings)
      } catch {
        await this.quarantineFile(this.settingsPath)
        this.settings = { ...DEFAULT_SETTINGS }
        await this.writeSettings()
      }
    } else {
      this.settings = { ...DEFAULT_SETTINGS }
      await this.writeSettings()
    }

    const workflowsFile = await this.readJsonFile<unknown>(this.workflowsPath)
    if (workflowsFile !== null) {
      try {
        const migrated = migratePersistedWorkflowStore(workflowsFile)
        this.workflowStore = normalizeSupportedWorkflowStore(migrated)
        if (JSON.stringify(this.workflowStore) !== JSON.stringify(migrated)) await this.writeWorkflows()
      } catch {
        await this.quarantineFile(this.workflowsPath)
        this.workflowStore = createDefaultWorkflowStore()
        await this.writeWorkflows()
      }
    } else {
      this.workflowStore = createDefaultWorkflowStore()
      await this.writeWorkflows()
    }

    const libraryFile = await this.readJsonFile<LibraryFile>(this.libraryPath)
    if (libraryFile !== null) {
      try {
        this.mediaItems = this.parseStoredLibrary(libraryFile)
      } catch {
        await this.quarantineFile(this.libraryPath)
        this.mediaItems = []
        await this.writeLibrary()
      }
    } else {
      this.mediaItems = []
      await this.writeLibrary()
    }
    this.rebuildMediaIndexes()
    await this.loadBundledAssets()
    await this.loadBundledAudioAssets()
    await this.loadProjects()
  }

  async drainMetadataMutations(): Promise<void> {
    while (true) {
      const pending = this.metadataMutationQueue
      await pending
      if (pending === this.metadataMutationQueue) return
    }
  }

  getSettings(): AppSettings {
    return { ...this.settings }
  }

  getOutputDirectory(id: Exclude<OutputFolderId, "exports">): string {
    return id === "screenshots" ? this.captureDirectory : this.recordingDirectory
  }

  async updateSettings(value: unknown): Promise<AppSettings> {
    return this.enqueueMetadataMutation(async () => {
      const patch: SettingsPatch = parseSettingsPatch(value)
      const next = parseSettings({ ...this.settings, ...patch })
      await this.writeSettings(next)
      this.settings = next
      return this.getSettings()
    })
  }

  async updateSettingsWithLoginItem(
    value: unknown,
    applySystemSetting: (enabled: boolean) => void,
  ): Promise<AppSettings> {
    return this.enqueueMetadataMutation(async () => {
      const patch: SettingsPatch = parseSettingsPatch(value)
      const previous = this.getSettings()
      const next = parseSettings({ ...previous, ...patch })
      if (next.launchAtLogin === previous.launchAtLogin) {
        await this.writeSettings(next)
      } else {
        const result = await changeLaunchAtLoginPreference({
          previous: previous.launchAtLogin,
          requested: next.launchAtLogin,
          applySystemSetting,
          persistSetting: async () => this.writeSettings(next),
        })
        if (!result.ok) {
          if (result.rollbackError !== undefined) {
            throw new AggregateError(
              [result.error, result.rollbackError],
              "The Windows startup preference failed and its previous state could not be confirmed.",
            )
          }
          throw result.error
        }
      }
      this.settings = next
      return this.getSettings()
    })
  }

  getWorkflowStore(): WorkflowStore {
    return cloneWorkflowStore(this.workflowStore)
  }

  prepareWorkflowStore(value: unknown): WorkflowStore {
    const validation = validatePersistedWorkflowStore(value)
    if (!validation.ok) {
      throw new ValidationError(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "))
    }
    return cloneWorkflowStore(normalizeSupportedWorkflowStore(validation.value))
  }

  prepareWorkflowRemoval(idValue: unknown): WorkflowStore {
    const id = parseIdentifier(idValue)
    if (!this.workflowStore.workflows.some((workflow) => workflow.id === id)) {
      throw new StorageError("WORKFLOW_NOT_FOUND", "The workflow no longer exists.")
    }
    return this.prepareWorkflowStore(removeWorkflow(this.workflowStore, id))
  }

  async replaceWorkflowStore(value: unknown): Promise<WorkflowStore> {
    const prepared = this.prepareWorkflowStore(value)
    return this.enqueueMetadataMutation(async () => {
      const next = cloneWorkflowStore(prepared)
      await this.writeWorkflows(next)
      this.workflowStore = next
      return this.getWorkflowStore()
    })
  }

  async removeWorkflow(idValue: unknown): Promise<WorkflowStore> {
    const prepared = this.prepareWorkflowRemoval(idValue)
    return this.enqueueMetadataMutation(async () => {
      const next = cloneWorkflowStore(prepared)
      await this.writeWorkflows(next)
      this.workflowStore = next
      return this.getWorkflowStore()
    })
  }

  listProjects(): ProjectSummary[] {
    const projects = new Map(this.projects)
    for (const [id, pending] of this.pendingProjectAutosaves) projects.set(id, pending.project)
    return [...projects.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(projectSummary)
  }

  async loadProject(idValue: unknown): Promise<EditorProject> {
    const id = parseIdentifier(idValue, "projectId")
    await this.flushProjectAutosaves(id)
    const project = this.projects.get(id)
    if (project === undefined) throw new StorageError("PROJECT_NOT_FOUND", "That project no longer exists.")
    return structuredClone(project)
  }

  async saveProject(value: unknown): Promise<ProjectSaveResult> {
    const project = this.prepareProject(value)
    const pending = this.takePendingAutosave(project.id)
    try {
      const result = await this.persistProject(project, false)
      settleAutosaveWaiters(pending, result)
      return result
    } catch (error) {
      rejectAutosaveWaiters(pending, error)
      throw error
    }
  }

  autosaveProject(value: unknown): Promise<ProjectSaveResult> {
    const project = this.prepareProject(value)
    const previous = this.pendingProjectAutosaves.get(project.id)
    if (previous !== undefined) {
      clearTimeout(previous.timer)
      const maximumDelay = Math.max(0, 5_000 - (Date.now() - previous.firstQueuedAt))
      previous.project = project
      previous.timer = this.createAutosaveTimer(project.id, Math.min(PROJECT_AUTOSAVE_DELAY_MS, maximumDelay))
      return previous.promise
    }

    let resolveAutosave!: (value: ProjectSaveResult) => void
    let rejectAutosave!: (error: unknown) => void
    const promise = new Promise<ProjectSaveResult>((resolvePromise, rejectPromise) => {
      resolveAutosave = resolvePromise
      rejectAutosave = rejectPromise
    })
    const pending: PendingProjectAutosave = {
      project,
      firstQueuedAt: Date.now(),
      promise,
      resolve: resolveAutosave,
      reject: rejectAutosave,
      timer: this.createAutosaveTimer(project.id, PROJECT_AUTOSAVE_DELAY_MS),
    }
    this.pendingProjectAutosaves.set(project.id, pending)
    return promise
  }

  async flushProjectAutosaves(idValue?: unknown): Promise<ProjectFlushResult> {
    const ids = idValue === undefined
      ? [...new Set([...this.pendingProjectAutosaves.keys(), ...this.activeProjectWrites.keys()])]
      : [parseIdentifier(idValue, "projectId")]
    const flushedProjectIds: string[] = []
    const failures: unknown[] = []
    for (const id of ids) {
      try {
        let touched = false
        while (true) {
          if (this.pendingProjectAutosaves.has(id)) {
            touched = true
            await this.flushProjectAutosave(id)
            continue
          }
          const active = this.activeProjectWrites.get(id)
          if (active === undefined) break
          touched = true
          await active
        }
        if (touched) flushedProjectIds.push(id)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "One or more projects could not be saved.")
    return { flushedProjectIds }
  }

  async resolveProjectAssetPath(asset: MediaAsset): Promise<string> {
    const indexed = this.mediaById.get(parseIdentifier(asset.id, "assetId"))
    if (indexed !== undefined) {
      if (indexed.kind !== asset.kind) {
        throw new StorageError("PROJECT_ASSET_MISMATCH", `Project asset ${asset.id} has the wrong media kind.`)
      }
      const canonicalPath = await realpath(indexed.path)
      const file = await stat(canonicalPath)
      if (!file.isFile()) throw new StorageError("PROJECT_ASSET_UNAVAILABLE", `Project asset ${asset.id} is missing.`)
      if (
        asset.signature !== undefined &&
        (asset.signature.byteLength !== file.size || Math.abs(asset.signature.modifiedMs - file.mtimeMs) > 1)
      ) {
        throw new StorageError(
          "PROJECT_ASSET_CHANGED",
          `Project asset ${asset.id} changed since the project was saved. Re-import it before exporting.`,
        )
      }
      return canonicalPath
    }
    if (asset.locator.kind === "bundled") {
      const bundled = this.bundledAssets.get(asset.locator.key)
      if (bundled !== undefined && asset.kind === "image") return bundled.path
    }
    throw new StorageError(
      "PROJECT_ASSET_UNAVAILABLE",
      `Project asset ${asset.id} is not registered in the SharpShot library.`,
    )
  }

  async resolveProjectAudioAssetPath(asset: AudioAsset): Promise<string> {
    if (asset.locator.kind === "library") {
      const indexed = this.mediaById.get(parseIdentifier(asset.id, "audioAssetId"))
      if (indexed === undefined || indexed.kind !== "audio") {
        throw new StorageError(
          "PROJECT_ASSET_UNAVAILABLE",
          `Project audio asset ${asset.id} is not registered in the SharpShot library.`,
        )
      }
      const canonicalPath = await realpath(indexed.path)
      const file = await stat(canonicalPath)
      if (!file.isFile()) {
        throw new StorageError("PROJECT_ASSET_UNAVAILABLE", `Project audio asset ${asset.id} is missing.`)
      }
      if (
        asset.signature !== undefined &&
        (asset.signature.byteLength !== file.size || Math.abs(asset.signature.modifiedMs - file.mtimeMs) > 1)
      ) {
        throw new StorageError(
          "PROJECT_ASSET_CHANGED",
          `Project audio asset ${asset.id} changed since the project was saved. Re-import it before exporting.`,
        )
      }
      return canonicalPath
    }

    const bundled = this.bundledAudioAssets.get(asset.locator.key)
    if (bundled !== undefined && asset.kind === "music") return bundled.path
    throw new StorageError(
      "PROJECT_ASSET_UNAVAILABLE",
      `Bundled audio asset ${asset.id} is unavailable.`,
    )
  }

  listBundledAudio(): BundledAudioTrack[] {
    return this.bundledAudioCatalog.map((track) => ({ ...track }))
  }

  listMedia(): MediaItem[] {
    return [...this.mediaItems]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(toPublicMediaItem)
  }

  getMediaPath(idValue: unknown): string | undefined {
    const id = parseIdentifier(idValue)
    return this.mediaById.get(id)?.path
  }

  getCursorMetadataPath(idValue: unknown): string | undefined {
    const id = parseIdentifier(idValue)
    return this.mediaById.get(id)?.cursorMetadataPath
  }

  async registerMediaFile(
    pathValue: string,
    origin: MediaOrigin,
    options: { cursorMetadataPath?: string } = {},
  ): Promise<MediaItem> {
    const items = await this.registerMediaFiles([pathValue], origin, options)
    if (items.length !== 1) throw new StorageError("MEDIA_NOT_FOUND", "The media file could not be indexed.")
    return items[0] as MediaItem
  }

  async registerMediaFiles(
    paths: readonly string[],
    origin: MediaOrigin,
    options: { cursorMetadataPath?: string } = {},
  ): Promise<MediaItem[]> {
    return this.registerMediaRegistrations(paths.map((path) => ({
      path,
      origin,
      ...(paths.length === 1 && options.cursorMetadataPath !== undefined
        ? { cursorMetadataPath: options.cursorMetadataPath }
        : {}),
    })))
  }

  private async registerMediaRegistrations(registrations: readonly MediaRegistration[]): Promise<MediaItem[]> {
    if (registrations.length === 0) return []
    return this.enqueueMetadataMutation(async () => {
      const nextItems = structuredClone(this.mediaItems)
      const byId = new Map(nextItems.map((item) => [item.id, item] as const))
      const idByPath = new Map(nextItems.map((item) => [pathKey(item.path), item.id] as const))
      const registered: StoredMediaItem[] = []
      let changed = false

      for (const registration of registrations) {
        const candidate = registration.path
        if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 32_767) {
          throw new ValidationError("Media path is invalid.")
        }
        const absolutePath = resolve(candidate)
        const descriptor = mediaDescriptorForPath(absolutePath)
        if (descriptor === undefined) {
          throw new StorageError("UNSUPPORTED_MEDIA", `Unsupported media type: ${extname(absolutePath) || "unknown"}`)
        }
        const canonicalPath = await realpath(absolutePath)
        const file = await stat(canonicalPath)
        if (!file.isFile()) throw new StorageError("MEDIA_NOT_FILE", "The selected media item is not a file.")
        let cursorMetadataPath: string | undefined
        if (registration.cursorMetadataPath !== undefined) {
          try {
            cursorMetadataPath = await validateCursorMetadataPath(canonicalPath, registration.cursorMetadataPath)
          } catch (error) {
            if (!registration.optionalCursorMetadata) throw error
          }
        }

        const canonicalKey = pathKey(canonicalPath)
        const existingId = idByPath.get(canonicalKey)
        const existing = existingId === undefined ? undefined : byId.get(existingId)
        if (existing !== undefined) {
          const modifiedAt = file.mtime.toISOString()
          if (existing.byteLength !== file.size) {
            existing.byteLength = file.size
            changed = true
          }
          if (existing.modifiedAt !== modifiedAt) {
            existing.modifiedAt = modifiedAt
            changed = true
          }
          if (cursorMetadataPath !== undefined && existing.cursorMetadataPath !== cursorMetadataPath) {
            existing.cursorMetadataPath = cursorMetadataPath
            changed = true
          }
          registered.push(existing)
          continue
        }

        if (nextItems.length >= MAX_MEDIA_ITEMS) {
          throw new StorageError("LIBRARY_LIMIT", "The local library index has reached its safety limit.")
        }

        const item: StoredMediaItem = {
          id: randomUUID(),
          name: basename(canonicalPath),
          kind: descriptor.kind,
          origin: registration.origin,
          mimeType: descriptor.mimeType,
          byteLength: file.size,
          createdAt: (file.birthtimeMs > 0 ? file.birthtime : file.mtime).toISOString(),
          modifiedAt: file.mtime.toISOString(),
          path: canonicalPath,
          cursorMetadataPath,
        }
        nextItems.push(item)
        byId.set(item.id, item)
        idByPath.set(canonicalKey, item.id)
        registered.push(item)
        changed = true
      }

      if (changed) {
        await this.writeLibrary(nextItems)
        this.mediaItems = nextItems
        this.rebuildMediaIndexes()
      }
      return registered.map(toPublicMediaItem)
    })
  }

  async indexExistingCaptures(): Promise<MediaItem[]> {
    const [captures, recordings] = await Promise.all([
      this.discoverMediaDirectory(this.captureDirectory, "capture"),
      this.discoverMediaDirectory(this.recordingDirectory, "recording"),
    ])
    const registered = await this.registerMediaRegistrations([
      ...captures.registrations,
      ...recordings.registrations,
    ])

    for (const bundle of recordings.recoveryBundles) {
      // A matching in-memory index is either from the single durable batch
      // above or from the already-durable library loaded at startup.
      if (this.mediaIdByPath.has(pathKey(bundle.finalPath))) {
        await completeQuickVideoMuxRecovery(bundle.markerPath)
      }
    }
    return registered
  }

  async removeMedia(idValue: unknown): Promise<boolean> {
    return this.enqueueMetadataMutation(async () => {
      const id = parseIdentifier(idValue)
      const item = this.mediaById.get(id)
      if (item === undefined) return false
      if (this.projectReferencesAsset(id)) {
        throw new StorageError("MEDIA_IN_USE", "This media item is referenced by a saved project.")
      }
      const nextItems = this.mediaItems.filter((candidate) => candidate.id !== id)
      await this.writeLibrary(nextItems)
      this.mediaItems = nextItems
      this.rebuildMediaIndexes()
      return true
    })
  }

  async handleMediaRequest(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return responseWithStatus(405, "Method not allowed", { Allow: "GET, HEAD" })
    }

    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return responseWithStatus(400, "Invalid URL")
    }
    if (
      url.protocol !== "sharpshot-media:" ||
      (url.hostname !== "asset" && url.hostname !== "audio" && url.hostname !== "background")
    ) {
      return responseWithStatus(404, "Not found")
    }

    const pathSegments = url.pathname.split("/").filter(Boolean)
    if (pathSegments.length !== 1) return responseWithStatus(404, "Not found")
    const encodedId = pathSegments[0]
    if (encodedId === undefined) return responseWithStatus(404, "Not found")

    let id: string
    try {
      id = parseIdentifier(decodeURIComponent(encodedId))
    } catch {
      return responseWithStatus(404, "Not found")
    }

    const bundledBackground = url.hostname === "background" ? this.bundledAssets.get(id) : undefined
    const item = url.hostname === "asset"
      ? this.mediaById.get(id)
      : url.hostname === "background"
        ? bundledBackground?.key === id ? bundledBackground : undefined
        : this.bundledAudioAssets.get(id)
    if (item === undefined) return responseWithStatus(404, "Not found")

    try {
      const file = await stat(item.path)
      if (!file.isFile()) return responseWithStatus(404, "Not found")
      const etag = `W/\"${file.size.toString(16)}-${Math.floor(file.mtimeMs).toString(16)}\"`
      const requestEtag = request.headers.get("if-none-match")
      const rangeHeader = request.headers.get("range")
      if (requestEtag === etag && rangeHeader === null) {
        return new Response(null, { status: 304, headers: mediaHeaders(item, file.size, etag, this.mediaAccessOrigin) })
      }

      let range: ByteRange | null = null
      if (rangeHeader !== null) {
        range = parseByteRange(rangeHeader, file.size)
        if (range === null) {
          return responseWithStatus(416, "Requested range is not satisfiable", {
            "Content-Range": `bytes */${file.size}`,
            "Accept-Ranges": "bytes",
          })
        }
      }

      const start = range?.start ?? 0
      const end = range?.end ?? Math.max(0, file.size - 1)
      const contentLength = file.size === 0 ? 0 : end - start + 1
      const headers = mediaHeaders(item, contentLength, etag, this.mediaAccessOrigin)
      if (range !== null) headers.set("Content-Range", `bytes ${start}-${end}/${file.size}`)
      if (request.method === "HEAD" || file.size === 0) {
        return new Response(null, { status: range === null ? 200 : 206, headers })
      }

      const nodeStream = (await import("node:fs")).createReadStream(item.path, { start, end })
      const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>
      return new Response(body, { status: range === null ? 200 : 206, headers })
    } catch {
      return responseWithStatus(404, "Not found")
    }
  }

  private prepareProject(value: unknown): EditorProject {
    const project = parseProjectInput(value)
    const knownProjectIds = new Set([
      ...this.projects.keys(),
      ...this.pendingProjectAutosaves.keys(),
      ...this.activeProjectWrites.keys(),
    ])
    if (knownProjectIds.size >= MAX_PROJECTS && !knownProjectIds.has(project.id)) {
      throw new StorageError("PROJECT_LIMIT", "The local project library has reached its safety limit.")
    }

    const existing = this.projects.get(project.id)
    const previousProject = this.pendingProjectAutosaves.get(project.id)?.project
      ?? this.activeProjectSnapshots.get(project.id)
      ?? existing
    const now = new Date().toISOString()
    project.createdAt = existing?.createdAt ?? project.createdAt
    project.updatedAt = now
    for (const asset of Object.values(project.assets)) {
      const indexed = this.mediaById.get(asset.id)
      if (indexed !== undefined) {
        if (indexed.kind !== asset.kind) {
          throw new StorageError("PROJECT_ASSET_MISMATCH", `Project asset ${asset.id} has the wrong media kind.`)
        }
        asset.locator = { kind: "managed", relativePath: `library/${asset.id}` }
        asset.signature = {
          byteLength: indexed.byteLength,
          modifiedMs: Date.parse(indexed.modifiedAt),
        }
        continue
      }
      if (asset.locator.kind === "bundled") {
        const bundled = this.bundledAssets.get(asset.locator.key)
        if (bundled !== undefined && asset.kind === "image") {
          asset.locator = { kind: "bundled", key: bundled.key }
          continue
        }
      }
      throw new StorageError(
        "PROJECT_ASSET_UNAVAILABLE",
        `Project asset ${asset.id} is not registered in the SharpShot library.`,
      )
    }
    for (const asset of Object.values(project.audio?.assets ?? {})) {
      if (asset.locator.kind === "library") {
        const indexed = this.mediaById.get(asset.id)
        if (indexed === undefined || indexed.kind !== "audio") {
          throw new StorageError(
            "PROJECT_ASSET_UNAVAILABLE",
            `Project audio asset ${asset.id} is not registered in the SharpShot library.`,
          )
        }
        const registeredSignature = {
          byteLength: indexed.byteLength,
          modifiedMs: Date.parse(indexed.modifiedAt),
        }
        const previousSignature = previousProject?.audio?.assets[asset.id]?.signature
        if ((asset.signature !== undefined && !sameMediaSignature(asset.signature, registeredSignature))
          || (asset.signature === undefined
            && previousSignature !== undefined
            && !sameMediaSignature(previousSignature, registeredSignature))) {
          throw new StorageError(
            "PROJECT_ASSET_CHANGED",
            `Project audio asset ${asset.id} changed since it was added. Remove its clips and add it again.`,
          )
        }
        asset.locator = { kind: "library" }
        asset.signature = registeredSignature
        continue
      }
      const bundled = this.bundledAudioAssets.get(asset.locator.key)
      if (bundled !== undefined && asset.kind === "music") {
        asset.locator = { kind: "bundled", key: bundled.key }
        asset.signature = undefined
        continue
      }
      throw new StorageError(
        "PROJECT_ASSET_UNAVAILABLE",
        `Bundled audio asset ${asset.id} is unavailable.`,
      )
    }

    const serialized = serializeProject(project)
    if (Buffer.byteLength(serialized, "utf8") > MAX_PROJECT_BYTES) {
      throw new StorageError("PROJECT_TOO_LARGE", "The project document is too large to save safely.")
    }
    return project
  }

  private async persistProject(project: EditorProject, autosave: boolean): Promise<ProjectSaveResult> {
    const operation = (async (): Promise<ProjectSaveResult> => {
      await this.enqueueTextWrite(this.projectPath(project.id), serializeProject(project))
      this.projects.set(project.id, structuredClone(project))
      return { project: structuredClone(project), autosave }
    })()
    this.activeProjectSnapshots.set(project.id, structuredClone(project))
    this.activeProjectWrites.set(project.id, operation)
    void operation.finally(() => {
      if (this.activeProjectWrites.get(project.id) === operation) {
        this.activeProjectWrites.delete(project.id)
        this.activeProjectSnapshots.delete(project.id)
      }
    }).catch(() => undefined)
    return operation
  }

  private async flushProjectAutosave(id: string): Promise<ProjectSaveResult | undefined> {
    const pending = this.takePendingAutosave(id)
    if (pending === undefined) return undefined
    try {
      const result = await this.persistProject(pending.project, true)
      settleAutosaveWaiters(pending, result)
      return result
    } catch (error) {
      rejectAutosaveWaiters(pending, error)
      throw error
    }
  }

  private takePendingAutosave(id: string): PendingProjectAutosave | undefined {
    const pending = this.pendingProjectAutosaves.get(id)
    if (pending === undefined) return undefined
    clearTimeout(pending.timer)
    this.pendingProjectAutosaves.delete(id)
    return pending
  }

  private createAutosaveTimer(id: string, delayMs: number): NodeJS.Timeout {
    return setTimeout(() => {
      void this.flushProjectAutosave(id).catch(() => undefined)
    }, delayMs)
  }

  private projectReferencesAsset(assetId: string): boolean {
    const projects = [
      ...this.projects.values(),
      ...[...this.pendingProjectAutosaves.values()].map((pending) => pending.project),
      ...this.activeProjectSnapshots.values(),
    ]
    return projects.some((project) =>
      Object.hasOwn(project.assets, assetId) ||
      Object.values(project.audio?.assets ?? {}).some(
        (asset) => asset.id === assetId && asset.locator.kind === "library",
      ))
  }

  private projectPath(id: string): string {
    return join(this.projectsDirectory, `${parseIdentifier(id, "projectId")}.json`)
  }

  private async loadProjects(): Promise<void> {
    const entries = await readdir(this.projectsDirectory, { withFileTypes: true })
    const projectFiles = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .slice(0, MAX_PROJECTS)
    for (const entry of projectFiles) {
      const candidatePath = join(this.projectsDirectory, entry.name)
      try {
        const file = await stat(candidatePath)
        if (!file.isFile() || file.size > MAX_PROJECT_BYTES) continue
        const project = pathFreeProject(parseProjectDocument(await readFile(candidatePath, "utf8")))
        if (`${project.id}.json` !== entry.name) continue
        this.projects.set(project.id, structuredClone(project))
      } catch {
        // One damaged autosave must not prevent capture shortcuts or the rest of
        // the project library from loading.
      }
    }
  }

  private async loadBundledAssets(): Promise<void> {
    const backgroundRoot = join(this.resourcesDirectory, "backgrounds")
    const manifestPath = join(backgroundRoot, "manifest.json")
    let document: unknown
    try {
      document = JSON.parse(await readFile(manifestPath, "utf8")) as unknown
    } catch {
      return
    }
    if (!isRecord(document) || !Array.isArray(document.items)) return
    for (const value of document.items) {
      if (!isRecord(value) || typeof value.id !== "string" || typeof value.file !== "string") continue
      let id: string
      try {
        id = parseIdentifier(value.id, "bundledAssetId")
      } catch {
        continue
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp)$/i.test(value.file)) continue
      const descriptor = mediaDescriptorForPath(value.file)
      if (descriptor?.kind !== "image") continue
      const candidate = resolve(backgroundRoot, value.file)
      if (!pathIsInside(backgroundRoot, candidate)) continue
      try {
        const canonicalPath = await realpath(candidate)
        if (!pathIsInside(backgroundRoot, canonicalPath) || !(await stat(canonicalPath)).isFile()) continue
        const bundled = { key: id, path: canonicalPath, mimeType: descriptor.mimeType }
        this.bundledAssets.set(id, bundled)
        this.bundledAssets.set(value.file, bundled)
        this.bundledAssets.set(`backgrounds/${value.file}`, bundled)
      } catch {
        // Missing optional art stays unavailable rather than accepting a path
        // supplied by renderer content.
      }
    }
  }

  private async loadBundledAudioAssets(): Promise<void> {
    const audioRoot = join(this.resourcesDirectory, "audio")
    const manifestPath = join(audioRoot, "manifest.json")
    let document: unknown
    try {
      document = JSON.parse(await readFile(manifestPath, "utf8")) as unknown
    } catch {
      return
    }
    if (!isRecord(document) || !Array.isArray(document.assets)) return

    const catalog: BundledAudioTrack[] = []
    for (const value of document.assets) {
      if (
        !isRecord(value) ||
        typeof value.id !== "string" ||
        typeof value.title !== "string" ||
        typeof value.creator !== "string" ||
        value.kind !== "music" ||
        value.license !== "CC0-1.0" ||
        typeof value.file !== "string" ||
        typeof value.durationSeconds !== "number" ||
        !Number.isFinite(value.durationSeconds) ||
        value.durationSeconds <= 0 ||
        !isRecord(value.media) ||
        !Number.isSafeInteger(value.media.sampleRateHz) ||
        (value.media.sampleRateHz as number) < 8_000 ||
        (value.media.sampleRateHz as number) > 384_000 ||
        !Number.isSafeInteger(value.media.channels) ||
        (value.media.channels as number) < 1 ||
        (value.media.channels as number) > 32
      ) continue
      let id: string
      try {
        id = parseIdentifier(value.id, "bundledAudioId")
      } catch {
        continue
      }
      const descriptor = mediaDescriptorForPath(value.file)
      if (descriptor?.kind !== "audio") continue
      const candidate = resolve(audioRoot, value.file)
      if (!pathIsInside(audioRoot, candidate)) continue
      try {
        const canonicalPath = await realpath(candidate)
        const file = await stat(canonicalPath)
        if (!pathIsInside(audioRoot, canonicalPath) || !file.isFile()) continue
        if (Number.isSafeInteger(value.bytes) && value.bytes !== file.size) continue
        const track: BundledAudioTrack = {
          id,
          title: value.title.trim(),
          creator: value.creator.trim(),
          durationUs: Math.round(value.durationSeconds * 1_000_000),
          sampleRate: value.media.sampleRateHz as number,
          channels: value.media.channels as number,
          license: "CC0-1.0",
          url: `sharpshot-media://audio/${encodeURIComponent(id)}`,
        }
        if (!track.title || !track.creator || !Number.isSafeInteger(track.durationUs)) continue
        const bundled: BundledAudioAsset = {
          ...track,
          key: id,
          path: canonicalPath,
          mimeType: descriptor.mimeType,
        }
        catalog.push(track)
        this.bundledAudioAssets.set(id, bundled)
        this.bundledAudioAssets.set(value.file, bundled)
        this.bundledAudioAssets.set(`audio/${value.file}`, bundled)
      } catch {
        // Missing or replaced optional audio stays unavailable.
      }
    }
    this.bundledAudioCatalog = catalog
  }

  private async readJsonFile<T>(path: string): Promise<T | null> {
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null
      throw error
    }
    try {
      return JSON.parse(text) as T
    } catch {
      await this.quarantineFile(path)
      return null
    }
  }

  private async quarantineFile(path: string): Promise<string> {
    const backupPath = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`
    try {
      await rename(path, backupPath)
      return backupPath
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return backupPath
      throw error
    }
  }

  private parseStoredLibrary(file: LibraryFile): StoredMediaItem[] {
    if (file.schemaVersion !== STORAGE_SCHEMA_VERSION || !Array.isArray(file.items)) {
      throw new StorageError("UNSUPPORTED_SCHEMA", "The library index has an unsupported format.")
    }
    if (file.items.length > MAX_MEDIA_ITEMS) {
      throw new StorageError("LIBRARY_LIMIT", "The local library index is too large to load safely.")
    }
    return file.items.map((item): StoredMediaItem => {
      if (!item || typeof item !== "object") throw new StorageError("CORRUPT_STORAGE", "A library item is invalid.")
      const candidate = item as Partial<StoredMediaItem>
      const storedPath = candidate.path
      const descriptor = typeof storedPath === "string" ? mediaDescriptorForPath(storedPath) : undefined
      if (
        descriptor === undefined ||
        typeof candidate.name !== "string" ||
        typeof candidate.byteLength !== "number" ||
        !Number.isFinite(candidate.byteLength) ||
        candidate.byteLength < 0 ||
        typeof candidate.createdAt !== "string" ||
        !Number.isFinite(Date.parse(candidate.createdAt)) ||
        typeof candidate.modifiedAt !== "string" ||
        !Number.isFinite(Date.parse(candidate.modifiedAt))
      ) {
        throw new StorageError("CORRUPT_STORAGE", "A library item is invalid.")
      }
      const origin = candidate.origin
      if (!isMediaOrigin(origin)) throw new StorageError("CORRUPT_STORAGE", "A library item has an invalid origin.")
      let cursorMetadataPath: string | undefined
      if (candidate.cursorMetadataPath !== undefined) {
        if (typeof candidate.cursorMetadataPath !== "string") {
          throw new StorageError("CORRUPT_STORAGE", "A cursor metadata path is invalid.")
        }
        const mediaStem = parsePath(resolve(storedPath as string))
        const expected = join(mediaStem.dir, `${mediaStem.name}.cursor.jsonl`)
        if (pathKey(expected) === pathKey(candidate.cursorMetadataPath)) cursorMetadataPath = expected
      }
      return {
        id: parseIdentifier(candidate.id),
        name: candidate.name.slice(0, 260),
        kind: descriptor.kind,
        origin,
        mimeType: descriptor.mimeType,
        byteLength: candidate.byteLength,
        createdAt: new Date(candidate.createdAt).toISOString(),
        modifiedAt: new Date(candidate.modifiedAt).toISOString(),
        path: resolve(storedPath as string),
        cursorMetadataPath,
      }
    })
  }

  private rebuildMediaIndexes(): void {
    this.mediaById.clear()
    this.mediaIdByPath.clear()
    const deduplicated: StoredMediaItem[] = []
    for (const item of this.mediaItems) {
      const key = pathKey(item.path)
      if (this.mediaById.has(item.id) || this.mediaIdByPath.has(key)) continue
      this.mediaById.set(item.id, item)
      this.mediaIdByPath.set(key, item.id)
      deduplicated.push(item)
    }
    this.mediaItems = deduplicated
  }

  private writeSettings(settings: AppSettings = this.settings): Promise<void> {
    return this.enqueueJsonWrite(this.settingsPath, {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings,
    } satisfies SettingsFile)
  }

  private writeWorkflows(workflowStore: WorkflowStore = this.workflowStore): Promise<void> {
    return this.enqueueJsonWrite(this.workflowsPath, workflowStore)
  }

  private writeLibrary(items: StoredMediaItem[] = this.mediaItems): Promise<void> {
    return this.enqueueJsonWrite(this.libraryPath, {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      items,
    } satisfies LibraryFile)
  }

  private async discoverMediaDirectory(
    directory: string,
    origin: "capture" | "recording",
  ): Promise<MediaDirectoryDiscovery> {
    const entries = await readdir(directory, { withFileTypes: true })
    const recoveryBundles = origin === "recording"
      ? await discoverQuickVideoMuxRecoveryBundles(directory)
      : []
    const ownedQuickMuxInputs = new Set(
      recoveryBundles.flatMap((bundle) => bundle.ownedCleanupPaths.map(pathKey)),
    )
    const filePaths = new Set(
      entries.filter((entry) => entry.isFile()).map((entry) => pathKey(join(directory, entry.name))),
    )
    const paths = entries
      .filter((entry) => entry.isFile() && isCompletedMediaFile(entry.name))
      .map((entry) => join(directory, entry.name))
      .filter((mediaPath) => !ownedQuickMuxInputs.has(pathKey(mediaPath)))
    const registrations = paths.map((mediaPath): MediaRegistration => {
      if (origin !== "recording" || extname(mediaPath).toLowerCase() !== ".mp4") {
        return { path: mediaPath, origin }
      }
      const parsed = parsePath(mediaPath)
      const cursorMetadataPath = join(parsed.dir, `${parsed.name}.cursor.jsonl`)
      return filePaths.has(pathKey(cursorMetadataPath))
        ? { path: mediaPath, origin, cursorMetadataPath, optionalCursorMetadata: true }
        : { path: mediaPath, origin }
    })
    return { registrations, recoveryBundles }
  }

  private enqueueMetadataMutation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.metadataMutationQueue.then(operation)
    this.metadataMutationQueue = pending.then(() => undefined, () => undefined)
    return pending
  }

  private enqueueJsonWrite(path: string, value: unknown): Promise<void> {
    const serialized = `${JSON.stringify(value, null, 2)}\n`
    return this.enqueueTextWrite(path, serialized)
  }

  private enqueueTextWrite(path: string, serialized: string): Promise<void> {
    const operation = this.writeQueue.then(() => atomicWriteFile(path, serialized))
    this.writeQueue = operation.catch(() => undefined)
    return operation
  }
}

function cloneWorkflowStore(store: WorkflowStore): WorkflowStore {
  return structuredClone(store)
}

function normalizeSupportedWorkflowStore(store: WorkflowStore): WorkflowStore {
  let changed = false
  const workflows = store.workflows.map((workflow) => {
    if (workflow.capture.cursor !== "editable-metadata") return workflow
    changed = true
    return {
      ...workflow,
      capture: { ...workflow.capture, cursor: "visible" as const },
    }
  })
  return changed ? { ...store, workflows } : store
}

function projectSummary(project: EditorProject): ProjectSummary {
  const durationUs = project.clips.reduce((total, clip) => {
    const duration = Math.round((clip.sourceOutUs - clip.sourceInUs) / clip.speed)
    return Number.isSafeInteger(total + duration) ? total + duration : Number.MAX_SAFE_INTEGER
  }, 0)
  const firstClip = project.clips[0]
  return {
    id: project.id,
    title: project.title,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    durationUs,
    clipCount: project.clips.length,
    ...(firstClip === undefined ? {} : { thumbnailMediaId: firstClip.assetId }),
  }
}

function settleAutosaveWaiters(pending: PendingProjectAutosave | undefined, result: ProjectSaveResult): void {
  if (pending === undefined) return
  pending.resolve(result)
}

function rejectAutosaveWaiters(pending: PendingProjectAutosave | undefined, error: unknown): void {
  if (pending === undefined) return
  pending.reject(error)
}

function mediaDescriptorForPath(path: string): MediaDescriptor | undefined {
  return MEDIA_TYPES[extname(path).toLowerCase()]
}

function isCompletedMediaFile(name: string): boolean {
  if (name.startsWith(".") || /(?:^|\.)partial(?:\.|$)/i.test(name)) return false
  return mediaDescriptorForPath(name) !== undefined
}

function pathKey(path: string): string {
  return process.platform === "win32" ? resolve(path).toLocaleLowerCase("en-US") : resolve(path)
}

function pathFreeProject(project: EditorProject): EditorProject {
  for (const asset of Object.values(project.assets)) {
    if (asset.locator.kind === "external") {
      asset.locator = { kind: "managed", relativePath: `library/${asset.id}` }
    }
  }
  return project
}

function sameMediaSignature(
  left: Readonly<{ byteLength: number; modifiedMs: number }>,
  right: Readonly<{ byteLength: number; modifiedMs: number }>,
): boolean {
  return left.byteLength === right.byteLength && Math.abs(left.modifiedMs - right.modifiedMs) <= 1
}

function toPublicMediaItem(item: StoredMediaItem): MediaItem {
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    origin: item.origin,
    mimeType: item.mimeType,
    byteLength: item.byteLength,
    createdAt: item.createdAt,
    modifiedAt: item.modifiedAt,
    url: `sharpshot-media://asset/${encodeURIComponent(item.id)}`,
    ...(item.cursorMetadataPath === undefined ? {} : { cursorMetadataAvailable: true }),
  }
}

async function validateCursorMetadataPath(mediaPath: string, value: string): Promise<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > 32_767) {
    throw new ValidationError("Cursor metadata path is invalid.")
  }
  const media = parsePath(mediaPath)
  const expected = join(media.dir, `${media.name}.cursor.jsonl`)
  const candidate = await realpath(resolve(value))
  if (pathKey(candidate) !== pathKey(expected)) {
    throw new StorageError("CURSOR_METADATA_MISMATCH", "Cursor metadata does not belong to this recording.")
  }
  if (!(await stat(candidate)).isFile()) {
    throw new StorageError("CURSOR_METADATA_NOT_FILE", "Cursor metadata is not a file.")
  }
  return candidate
}

function pathIsInside(root: string, candidate: string): boolean {
  const normalizedRoot = pathKey(root)
  const normalizedCandidate = pathKey(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}\\`) ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isMediaOrigin(value: unknown): value is MediaOrigin {
  return value === "capture" || value === "recording" || value === "import" || value === "export" || value === "background"
}

function parseByteRange(value: string, size: number): ByteRange | null {
  if (size <= 0) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (match === null) return null
  const first = match[1] ?? ""
  const second = match[2] ?? ""
  if (first.length === 0 && second.length === 0) return null

  if (first.length === 0) {
    const suffixLength = Number(second)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null
    return { start: Math.max(0, size - suffixLength), end: size - 1 }
  }

  const start = Number(first)
  const requestedEnd = second.length === 0 ? size - 1 : Number(second)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size) {
    return null
  }
  const end = Math.min(size - 1, requestedEnd)
  if (end < start) return null
  return { start, end }
}

function mediaHeaders(item: Pick<StoredMediaItem, "mimeType">, contentLength: number, etag: string, accessOrigin: string): Headers {
  return new Headers({
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": accessOrigin,
    "Cache-Control": "private, no-cache",
    "Content-Length": String(contentLength),
    "Content-Type": item.mimeType,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  })
}

function responseWithStatus(status: number, message: string, headers?: Record<string, string>): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  })
}

async function atomicWriteFile(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporaryPath, "wx", 0o600)
  try {
    await handle.writeFile(contents, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporaryPath, path)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
