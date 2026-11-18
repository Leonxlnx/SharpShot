import { lstat, mkdir, realpath } from "node:fs/promises"
import { basename, dirname, extname, join, resolve } from "node:path"
import {
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron"
import type {
  ApiResult,
  AppBootstrap,
  AppRoute,
  EngineEvent,
  ExportEvent,
  ExportJobSnapshot,
  ExportStartRequest,
  ExportStartResult,
  MediaItem,
  MediaProbe,
  ProjectSaveResult,
  WindowAction,
  WorkflowStoreUpdate,
} from "../shared/api.js"
import {
  IPC_CHANNELS,
  IPC_EVENTS,
  parseAllowedExternalUrl,
  parseAutoZoomGenerateRequest,
  parseEngineActionRequest,
  parseExportStartRequest,
  parseIdentifier,
  parseOptionalIdentifier,
  parseOutputFolderId,
  parseProject,
  parseWindowAction,
  ValidationError,
} from "../shared/api.js"
import type { AssetId, EditorProject, OutputFormat } from "../shared/project.js"
import { activeProjectAudioAssetIds } from "../shared/project-audio.js"
import type { ZoomSegment } from "../shared/cursor-zoom.js"
import type { AfterCaptureAction } from "../shared/workflows.js"
import { muxQuickVideoAudio } from "./audio-stem-mux.js"
import { shouldMuxQuickVideoAudio } from "./capture-completion-policy.js"
import { mapClickZoomsToProjectTimeline, readNativeCursorSidecar } from "./cursor-autozoom.js"
import { completeQuickVideoMuxRecovery } from "./quick-video-mux-recovery.js"
import {
  ExportBusyError,
  ExportCancelledError,
  ExportProcessError,
  ExportService,
  ExportValidationError,
  type ProjectExportRequest,
} from "./export-service.js"
import {
  MediaProbeError,
  MediaToolNotFoundError,
  probeMedia,
  type MediaProbeResult,
} from "./media-probe.js"
import { NativeEngine, NativeEngineError, type NativeEngineRawEvent } from "./native-engine.js"
import { redactLocalPaths } from "./path-redaction.js"
import { StorageError, StorageService } from "./storage.js"
import { WindowManager } from "./windows.js"

type IpcDependencies = {
  appVersion: string
  storage: StorageService
  engine: NativeEngine
  windows: WindowManager
  resourcesDirectory: string
  developmentRoot: string
  exportDirectory: string
  allowMediaPathFallback: boolean
  updateLoginItem(enabled: boolean): void
}

export type IpcHandlerLifecycle = {
  quiesce(): Promise<void>
  dispose(): Promise<void>
}

export function registerIpcHandlers(dependencies: IpcDependencies): IpcHandlerLifecycle {
  const {
    appVersion,
    storage,
    engine,
    windows,
    resourcesDirectory,
    developmentRoot,
    exportDirectory,
    allowMediaPathFallback,
    updateLoginItem,
  } = dependencies
  const registeredChannels: string[] = []
  const exportService = new ExportService()
  const exportJobs = new Map<string, ExportJobSnapshot>()
  const exportStartControllers = new Map<string, AbortController>()
  const routedEngineEvents = new Set<Promise<void>>()
  const routedEngineControllers = new Set<AbortController>()
  const activeDurableMutations = new Set<Promise<unknown>>()
  let latestExportJobId: string | undefined
  let activeExportTask: Promise<void> | null = null
  let activeAutoZoomTask: Promise<ZoomSegment[]> | null = null
  let disposed = false
  let quiesced = false
  let handlersRemoved = false
  let workflowMutationQueue: Promise<void> = Promise.resolve()

  const enqueueWorkflowMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    if (quiesced) {
      return Promise.reject(new NativeEngineError("ENGINE_SHUTTING_DOWN", "SharpShot is shutting down."))
    }
    const pending = workflowMutationQueue.then(operation)
    workflowMutationQueue = pending.then(() => undefined, () => undefined)
    return pending
  }

  const handle = <TInput, TOutput>(
    channel: string,
    parse: (value: unknown) => TInput,
    operation: (input: TInput) => Promise<TOutput> | TOutput,
    options: { durableMutation?: boolean } = {},
  ): void => {
    ipcMain.handle(channel, async (event, value: unknown): Promise<ApiResult<TOutput>> => {
      try {
        assertTrustedSender(event, windows)
        if (options.durableMutation === true && quiesced) {
          throw new StorageError("APP_SHUTTING_DOWN", "SharpShot is shutting down.")
        }
        const input = parse(value)
        const pending = Promise.resolve(operation(input))
        if (options.durableMutation === true) activeDurableMutations.add(pending)
        try {
          return { ok: true, value: await pending }
        } finally {
          activeDurableMutations.delete(pending)
        }
      } catch (error) {
        return { ok: false, error: publicError(error) }
      }
    })
    registeredChannels.push(channel)
  }

  handle(IPC_CHANNELS.bootstrap, parseNoArgument, async (): Promise<AppBootstrap> => ({
    appVersion,
    capabilities: { quickVideoAudioMux: true },
    settings: storage.getSettings(),
    workflowStore: storage.getWorkflowStore(),
    library: storage.listMedia(),
    audioCatalog: storage.listBundledAudio(),
    engine: engine.getStatus(),
  }))

  handle(IPC_CHANNELS.windowAction, parseWindowAction, (action: WindowAction) =>
    windows.performWindowAction(action),
  )
  handle(IPC_CHANNELS.windowCloseReady, (value) => parseIdentifier(value, "closeRequestId"), (requestId) =>
    windows.completeRendererFlush(requestId),
  )
  handle(IPC_CHANNELS.windowRouteReady, parseNoArgument, () => windows.rendererReady())

  handle(IPC_CHANNELS.settingsGet, parseNoArgument, () => storage.getSettings())
  handle(
    IPC_CHANNELS.settingsUpdate,
    (value) => value,
    (patch) => storage.updateSettingsWithLoginItem(patch, updateLoginItem),
    { durableMutation: true },
  )

  handle(IPC_CHANNELS.workflowsGet, parseNoArgument, () => storage.getWorkflowStore())
  handle(IPC_CHANNELS.workflowsReplace, (value) => value, (value): Promise<WorkflowStoreUpdate> =>
    enqueueWorkflowMutation(() => replaceWorkflowStoreTransaction(storage, engine, value)),
  )
  handle(IPC_CHANNELS.workflowsRemove, parseIdentifier, (workflowId): Promise<WorkflowStoreUpdate> =>
    enqueueWorkflowMutation(() => {
      const candidate = storage.prepareWorkflowRemoval(workflowId)
      return replaceWorkflowStoreTransaction(storage, engine, candidate)
    }),
  )

  handle(IPC_CHANNELS.libraryList, parseNoArgument, () => storage.listMedia())
  handle(IPC_CHANNELS.libraryImport, parseNoArgument, async (): Promise<MediaItem[]> => {
    const options: OpenDialogOptions = {
      title: "Import media into SharpShot",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Supported media", extensions: ["png", "jpg", "jpeg", "webp", "gif", "mp4", "mov", "webm", "mkv", "wav", "mp3", "m4a", "aac"] },
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
        { name: "Videos", extensions: ["mp4", "mov", "webm", "mkv"] },
        { name: "Audio", extensions: ["wav", "mp3", "m4a", "aac"] },
      ],
    }
    const parent = windows.window
    const selection = parent === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(parent, options)
    if (selection.canceled || selection.filePaths.length === 0) return []
    const imported = await storage.registerMediaFiles(selection.filePaths, "import")
    broadcastLibrary(storage, windows)
    return imported
  }, { durableMutation: true })
  handle(IPC_CHANNELS.libraryRemove, parseIdentifier, async (id) => {
    const removed = await storage.removeMedia(id)
    if (removed) broadcastLibrary(storage, windows)
    return removed
  }, { durableMutation: true })
  handle(IPC_CHANNELS.libraryReveal, parseIdentifier, (id) => {
    const path = storage.getMediaPath(id)
    if (path === undefined) return false
    shell.showItemInFolder(path)
    return true
  })
  handle(IPC_CHANNELS.foldersReveal, parseOutputFolderId, async (folderId) => {
    const directory = folderId === "exports"
      ? resolve(exportDirectory)
      : storage.getOutputDirectory(folderId)
    try {
      const metadata = await lstat(directory)
      if (!metadata.isDirectory()) return false
    } catch {
      return false
    }
    const error = await shell.openPath(directory)
    if (error.length > 0) {
      throw new StorageError("FOLDER_OPEN_FAILED", "Windows could not open that output folder.")
    }
    return true
  })

  handle(IPC_CHANNELS.engineStatus, parseNoArgument, () => engine.getStatus())
  handle(IPC_CHANNELS.engineRunWorkflow, parseEngineActionRequest, async (request) => {
    const workflow = storage.getWorkflowStore().workflows.find((item) => item.id === request.workflowId)
    if (workflow === undefined || !workflow.enabled) {
      throw new NativeEngineError("WORKFLOW_NOT_FOUND", "That workflow is unavailable.")
    }
    return engine.runWorkflow(workflow)
  })
  handle(IPC_CHANNELS.engineStop, parseNoArgument, () => engine.stopRecording())
  handle(IPC_CHANNELS.engineCancel, parseNoArgument, () => engine.cancelOperation())

  handle(IPC_CHANNELS.projectsList, parseNoArgument, () => storage.listProjects())
  handle(IPC_CHANNELS.projectsLoad, (value) => parseIdentifier(value, "projectId"), (projectId) =>
    storage.loadProject(projectId),
  )
  handle(IPC_CHANNELS.projectsSave, parseProject, (project): Promise<ProjectSaveResult> =>
    storage.saveProject(project),
  )
  handle(IPC_CHANNELS.projectsAutosave, parseProject, (project): Promise<ProjectSaveResult> =>
    storage.autosaveProject(project),
  )
  handle(IPC_CHANNELS.projectsFlush, (value) => parseOptionalIdentifier(value, "projectId"), (projectId) =>
    storage.flushProjectAutosaves(projectId),
  )
  handle(
    IPC_CHANNELS.projectsGenerateAutoZoom,
    parseAutoZoomGenerateRequest,
    async ({ projectId, assetId }): Promise<ZoomSegment[]> => {
      if (quiesced || disposed) {
        throw new StorageError("APP_SHUTTING_DOWN", "SharpShot is shutting down.")
      }
      if (activeAutoZoomTask !== null) {
        throw new StorageError("AUTO_ZOOM_BUSY", "Automatic zoom generation is already running.")
      }
      const task = (async (): Promise<ZoomSegment[]> => {
        await storage.flushProjectAutosaves(projectId)
        const project = await storage.loadProject(projectId)
        const asset = project.assets[assetId]
        if (asset?.kind !== "video") {
          throw new StorageError("PROJECT_ASSET_MISMATCH", "Auto zoom requires a video asset in this project.")
        }
        await storage.resolveProjectAssetPath(asset)
        const cursorMetadataPath = storage.getCursorMetadataPath(assetId)
        if (cursorMetadataPath === undefined) {
          throw new StorageError(
            "CURSOR_METADATA_UNAVAILABLE",
            "This recording has no click metadata. Record into Studio with the cursor visible to generate click zooms.",
          )
        }
        const sidecar = await readNativeCursorSidecar(cursorMetadataPath)
        return mapClickZoomsToProjectTimeline(sidecar, project, assetId)
      })()
      activeAutoZoomTask = task
      try {
        return await task
      } finally {
        if (activeAutoZoomTask === task) activeAutoZoomTask = null
      }
    },
  )

  handle(IPC_CHANNELS.exportProbe, (value) => parseIdentifier(value, "mediaId"), async (mediaId): Promise<MediaProbe> => {
    const mediaPath = storage.getMediaPath(mediaId)
    if (mediaPath === undefined) throw new StorageError("MEDIA_NOT_FOUND", "That media item no longer exists.")
    const result = await probeMedia(mediaPath, {
      resourcesPath: resourcesDirectory,
      developmentRoot,
      allowPathFallback: allowMediaPathFallback,
    })
    return publicMediaProbe(mediaId, result)
  })
  handle(IPC_CHANNELS.exportCancel, (value) => parseIdentifier(value, "jobId"), (jobId) =>
    exportService.cancel(jobId),
  )
  handle(IPC_CHANNELS.exportStatus, (value) => parseOptionalIdentifier(value, "jobId"), (jobId) => {
    const selectedId = jobId ?? latestExportJobId
    if (selectedId === undefined) return null
    const snapshot = exportJobs.get(selectedId)
    return snapshot === undefined ? null : structuredClone(snapshot)
  })
  handle(IPC_CHANNELS.exportStart, parseExportStartRequest, async (request): Promise<ExportStartResult> => {
    const jobId = exportService.reserveStart()
    const startController = new AbortController()
    exportStartControllers.set(jobId, startController)
    const assertStartActive = (): void => {
      if (startController.signal.aborted || quiesced || disposed) throw new ExportCancelledError()
    }
    try {
      assertStartActive()
      await storage.flushProjectAutosaves(request.projectId)
      assertStartActive()
      const project = await storage.loadProject(request.projectId)
      assertStartActive()
      const format = request.format ?? project.export.format
      const selection = await chooseExportDestination(windows, exportDirectory, project, request, format)
      assertStartActive()
      if (selection === undefined) return { started: false }
      const { destination, overwrite } = selection

      const compiled = await compileProjectExportRequest(project, request, destination, overwrite, storage)
      assertStartActive()
      compiled.request.id = jobId
      await assertProjectExportDestinationIsNotSource(destination, compiled.request)
      assertStartActive()
      latestExportJobId = jobId
      rememberExportJob(exportJobs, {
        jobId,
        fileName: basename(destination),
        state: "queued",
      })
      const handle = exportService.startProject(compiled.request, {
        resourcesPath: resourcesDirectory,
        developmentRoot,
        allowPathFallback: allowMediaPathFallback,
        onProgress: (progress) => {
          const event = {
            type: "progress",
            jobId,
            ...progress,
          } satisfies Extract<ExportEvent, { type: "progress" }>
          rememberExportJob(exportJobs, {
            jobId,
            fileName: basename(destination),
            state: "running",
            progress: event,
          })
          if (!disposed) windows.broadcast(IPC_EVENTS.export, event)
        },
      })
      const task = handle.promise.then(async (result) => {
      const warnings = [...compiled.warnings, ...result.warnings]
      try {
        const media = await storage.registerMediaFile(result.outputPath, "export")
        const event = {
          type: "completed",
          jobId: result.id,
          media,
          durationUs: result.durationUs,
          warnings,
        } satisfies ExportEvent
        rememberExportJob(exportJobs, {
          jobId: result.id,
          fileName: basename(result.outputPath),
          state: "completed",
          media,
          durationUs: result.durationUs,
          warnings,
        })
        if (!disposed) {
          broadcastLibrary(storage, windows)
          windows.broadcast(IPC_EVENTS.export, event)
        }
      } catch (indexError) {
        const error = publicError(indexError)
        const event = {
          type: "completed-unindexed",
          jobId: result.id,
          fileName: basename(result.outputPath),
          durationUs: result.durationUs,
          warnings,
          error,
        } satisfies ExportEvent
        rememberExportJob(exportJobs, {
          jobId: result.id,
          fileName: basename(result.outputPath),
          state: "completed-unindexed",
          durationUs: result.durationUs,
          warnings,
          error,
        })
        if (!disposed) windows.broadcast(IPC_EVENTS.export, event)
      }
    }).catch((error: unknown) => {
      if (error instanceof ExportCancelledError) {
        const event = { type: "cancelled", jobId: handle.id } satisfies ExportEvent
        rememberExportJob(exportJobs, {
          jobId: handle.id,
          fileName: basename(destination),
          state: "cancelled",
        })
        if (!disposed) windows.broadcast(IPC_EVENTS.export, event)
        return
      }
      const publicFailure = publicError(error)
      const event = {
        type: "failed",
        jobId: handle.id,
        error: publicFailure,
      } satisfies ExportEvent
      rememberExportJob(exportJobs, {
        jobId: handle.id,
        fileName: basename(destination),
        state: "failed",
        error: publicFailure,
      })
      if (!disposed) windows.broadcast(IPC_EVENTS.export, event)
      }).finally(() => {
        if (activeExportTask === task) activeExportTask = null
      })
      activeExportTask = task
      return { started: true, jobId: handle.id, fileName: basename(destination) }
    } finally {
      exportStartControllers.delete(jobId)
      exportService.releaseStart(jobId)
    }
  })

  handle(IPC_CHANNELS.systemOpenExternal, parseAllowedExternalUrl, async (url) => {
    await shell.openExternal(url, { activate: true })
    return true
  })

  const onStatus = (): void => {
    windows.broadcast(IPC_EVENTS.engine, { type: "status", status: engine.getStatus() } satisfies EngineEvent)
  }
  const onEngineEvent = (event: NativeEngineRawEvent): void => {
    const controller = new AbortController()
    const task = routeEngineEvent(event, storage, windows, {
      resourcesDirectory,
      developmentRoot,
      allowMediaPathFallback,
      signal: controller.signal,
    })
    routedEngineControllers.add(controller)
    routedEngineEvents.add(task)
    void task.finally(() => {
      routedEngineControllers.delete(controller)
      routedEngineEvents.delete(task)
    }).catch(() => undefined)
  }
  engine.on("status", onStatus)
  engine.on("event", onEngineEvent)

  const removeHandlers = (): void => {
    if (handlersRemoved) return
    handlersRemoved = true
    for (const channel of registeredChannels) ipcMain.removeHandler(channel)
  }
  const quiesce = async (): Promise<void> => {
    quiesced = true
    for (const controller of exportStartControllers.values()) controller.abort()
    removeHandlers()
    await workflowMutationQueue
    while (activeDurableMutations.size > 0) {
      await Promise.allSettled([...activeDurableMutations])
    }
    await storage.drainMetadataMutations()
  }
  const dispose = async (): Promise<void> => {
    disposed = true
    for (const controller of routedEngineControllers) controller.abort()
    exportService.cancel()
    await activeExportTask?.catch(() => undefined)
    await activeAutoZoomTask?.catch(() => undefined)
    await quiesce()
    engine.off("status", onStatus)
    engine.off("event", onEngineEvent)
    await Promise.allSettled([...routedEngineEvents])
  }
  return { quiesce, dispose }
}

export async function replaceWorkflowStoreTransaction(
  storage: Pick<StorageService, "getWorkflowStore" | "prepareWorkflowStore" | "replaceWorkflowStore">,
  engine: Pick<NativeEngine, "prepareBindingReplacement" | "commitBindingReplacement" | "abortBindingReplacement">,
  value: unknown,
): Promise<WorkflowStoreUpdate> {
  const priorStore = storage.getWorkflowStore()
  const candidateStore = storage.prepareWorkflowStore(value)
  const preparation = await engine.prepareBindingReplacement(candidateStore)

  if (!preparation.ready) {
    const failedBindingIds = [...preparation.failedBindingIds]
    return {
      store: priorStore,
      bindings: [...preparation.bindings],
      applied: false,
      registrationFailure: {
        code: "SHORTCUT_REGISTRATION_FAILED",
        message: failedBindingIds.length === 1
          ? "SharpShot kept your previous shortcuts because one shortcut is owned by Windows or another app."
          : `SharpShot kept your previous shortcuts because ${failedBindingIds.length} shortcuts are owned by Windows or another app.`,
        bindingIds: failedBindingIds,
      },
    }
  }

  let candidatePersisted = false
  try {
    const appliedStore = await storage.replaceWorkflowStore(candidateStore)
    candidatePersisted = true
    await engine.commitBindingReplacement(preparation.transaction)
    return {
      store: appliedStore,
      bindings: [...preparation.bindings],
      applied: true,
    }
  } catch (error) {
    let liveRollbackError: unknown
    try {
      await engine.abortBindingReplacement(preparation.transaction)
    } catch (rollbackError) {
      liveRollbackError = rollbackError
    }
    let storageRollbackError: unknown
    if (candidatePersisted) {
      try {
        await storage.replaceWorkflowStore(priorStore)
      } catch (rollbackError) {
        storageRollbackError = rollbackError
      }
    }
    if (liveRollbackError !== undefined || storageRollbackError !== undefined) {
      throw new NativeEngineError(
        "WORKFLOW_ROLLBACK_FAILED",
        "SharpShot could not fully restore the previous shortcut configuration after the save failed.",
      )
    }
    throw error
  }
}

export async function routeEngineEvent(
  event: NativeEngineRawEvent,
  storage: StorageService,
  windows: WindowManager,
  mediaRuntime: {
    resourcesDirectory: string
    developmentRoot: string
    allowMediaPathFallback: boolean
    signal?: AbortSignal
  },
): Promise<void> {
  const payload = isRecord(event.payload) ? event.payload : {}
  try {
    if (event.name === "app.open") {
      const page = payload.page
      if (page === "library" || page === "workflows" || page === "settings") windows.show(page)
      return
    }

    if (event.name === "state.changed") {
      const state = payload.state
      if (
        state === "idle" || state === "selecting" || state === "countdown" ||
        state === "recording" || state === "finalizing" || state === "unavailable"
      ) {
        const dto: EngineEvent = {
          type: "state.changed",
          state,
          workflowId: optionalIdentifier(payload.workflowId),
        }
        windows.broadcast(IPC_EVENTS.engine, dto)
      }
      return
    }

    if (event.name === "shortcut.triggered") {
      const workflowId = parseIdentifier(payload.workflowId, "workflowId")
      windows.broadcast(IPC_EVENTS.engine, { type: "shortcut.triggered", workflowId } satisfies EngineEvent)
      return
    }

    if (event.name === "record.started") {
      const workflowId = parseIdentifier(payload.workflowId, "workflowId")
      windows.broadcast(IPC_EVENTS.engine, {
        type: "record.started",
        workflowId,
        operationId: optionalShortString(payload.operationId),
        width: optionalNonNegativeInteger(payload.width),
        height: optionalNonNegativeInteger(payload.height),
        framesPerSecond: optionalNonNegativeInteger(payload.framesPerSecond),
      } satisfies EngineEvent)
      return
    }

    if (event.name === "screenshot.completed" || event.name === "record.completed") {
      const workflowId = parseIdentifier(payload.workflowId, "workflowId")
      if (typeof payload.path !== "string") throw new ValidationError("Native media path is missing.")
      const workflowKind = payload.workflowKind
      const finishClipboard = payload.finishClipboard
      const finishAfterCapture = payload.finishAfterCapture
      if (workflowKind !== "screenshot" && workflowKind !== "video") {
        throw new ValidationError("Native completion workflow kind is invalid.")
      }
      if (finishClipboard !== "none" && finishClipboard !== "image" && finishClipboard !== "file") {
        throw new ValidationError("Native completion clipboard policy is invalid.")
      }
      if (
        finishAfterCapture !== "nothing" &&
        finishAfterCapture !== "open-editor" &&
        finishAfterCapture !== "open-library" &&
        finishAfterCapture !== "reveal-file"
      ) {
        throw new ValidationError("Native completion finish action is invalid.")
      }
      const cursorMetadataPath = optionalNativePath(payload.cursorPath)
      const systemAudioPath = optionalNativePath(payload.systemAudioPath)
      const microphonePath = optionalNativePath(payload.microphonePath)
      const hasAudioStems = systemAudioPath !== undefined || microphonePath !== undefined
      let mediaPath = payload.path
      let clipboardReady = payload.clipboard === true
      let audioRequiresMux = hasAudioStems
      let keepSeparateAudioItems = event.name === "record.completed" && hasAudioStems
      let quickMuxRecoveryMarkerPath: string | undefined
      const warnings: string[] = []
      const cursorMetadataWarning = "The recording was saved, but editable cursor metadata is unavailable."
      if (event.name === "record.completed" && payload.cursorMetadataUnavailable === true) {
        warnings.push(cursorMetadataWarning)
      }

      if (event.name === "record.completed" && hasAudioStems) {
        const shouldMuxQuickVideo = shouldMuxQuickVideoAudio({
          workflowKind,
          clipboard: finishClipboard,
          afterCapture: finishAfterCapture,
        })
        if (shouldMuxQuickVideo) {
          windows.broadcast(IPC_EVENTS.engine, {
            type: "record.processing",
            workflowId,
            stage: "muxing-audio",
            fraction: 0,
          } satisfies EngineEvent)
          try {
            const muxed = await muxQuickVideoAudio({
              sourceVideoPath: payload.path,
              systemAudioPath,
              microphoneAudioPath: microphonePath,
              copyToClipboard: true,
            }, {
              resourcesPath: mediaRuntime.resourcesDirectory,
              developmentRoot: mediaRuntime.developmentRoot,
              allowPathFallback: mediaRuntime.allowMediaPathFallback,
              signal: mediaRuntime.signal,
              onProgress: (progress) => windows.broadcast(IPC_EVENTS.engine, {
                type: "record.processing",
                workflowId,
                stage: "muxing-audio",
                fraction: progress.fraction,
              } satisfies EngineEvent),
            })
            mediaPath = muxed.outputPath
            quickMuxRecoveryMarkerPath = muxed.recoveryMarkerPath
            clipboardReady = muxed.clipboard?.mode === "file"
            audioRequiresMux = false
            keepSeparateAudioItems = false
            if (muxed.clipboard?.warning) warnings.push(muxed.clipboard.warning)
            if (cursorMetadataPath !== undefined) {
              warnings.push("Editable cursor metadata remains beside the native source recording; the quick audio-mux copy uses the rendered video only.")
            }
          } catch (error) {
            clipboardReady = false
            const detail = error instanceof Error ? error.message.slice(0, 384) : "The media tools did not complete the audio merge."
            warnings.push(`The recording and separate audio stems were saved, but audio could not be merged for Copy. ${detail}`)
          }
        }
      }

      let media: MediaItem
      if (event.name === "record.completed" && cursorMetadataPath !== undefined && mediaPath === payload.path) {
        try {
          media = await storage.registerMediaFile(mediaPath, "recording", { cursorMetadataPath })
        } catch {
          // A missing/corrupt optional sidecar must not hide an otherwise valid
          // recording from the user's library.
          media = await storage.registerMediaFile(mediaPath, "recording")
          warnings.push(cursorMetadataWarning)
        }
      } else {
        media = await storage.registerMediaFile(
          mediaPath,
          event.name === "screenshot.completed" ? "capture" : "recording",
        )
      }
      if (quickMuxRecoveryMarkerPath !== undefined) {
        // The muxed final is durable in library.json before native raw inputs
        // are retired. A failed cleanup deliberately leaves its identity-bound
        // marker in place so startup recovery hides and retries only those
        // exact Quick Video files; Studio/open-editor recordings never enter
        // this branch and retain their editable stems.
        await completeQuickVideoMuxRecovery(quickMuxRecoveryMarkerPath).catch(() => undefined)
      }
      const systemAudio = keepSeparateAudioItems
        ? await registerOptionalAudio(storage, systemAudioPath)
        : undefined
      const microphoneAudio = keepSeparateAudioItems
        ? await registerOptionalAudio(storage, microphonePath)
        : undefined
      // Shutdown cancellation still durably indexes the native recording and
      // stems above, but it must never reopen Studio, reveal Explorer, or emit
      // stale completion UI while the app is tearing down.
      if (mediaRuntime.signal?.aborted === true) return
      broadcastLibrary(storage, windows)
      const dto: EngineEvent = event.name === "screenshot.completed"
        ? { type: "screenshot.completed", workflowId, media }
        : {
            type: "record.completed",
            workflowId,
            media,
            systemAudio,
            microphoneAudio,
            clipboardReady,
            audioRequiresMux,
            warnings: warnings.length > 0 ? warnings : undefined,
            durationMs: optionalNonNegativeInteger(payload.durationMs),
          }
      windows.broadcast(IPC_EVENTS.engine, dto)
      await applyFinishAction(finishAfterCapture, media, storage, windows)
      return
    }

    if (event.name === "operation.cancelled") {
      windows.broadcast(IPC_EVENTS.engine, {
        type: "operation.cancelled",
        workflowId: optionalIdentifier(payload.workflowId),
      } satisfies EngineEvent)
      return
    }

    if (event.name === "operation.failed") {
      windows.broadcast(IPC_EVENTS.engine, {
        type: "operation.failed",
        workflowId: optionalIdentifier(payload.workflowId),
        code: optionalShortString(payload.code) ?? "ENGINE_ERROR",
        message: optionalShortString(payload.message, 512) ?? "Native capture failed.",
      } satisfies EngineEvent)
    }
  } catch (error) {
    if (mediaRuntime.signal?.aborted === true) return
    const failure = publicError(error)
    windows.broadcast(IPC_EVENTS.engine, {
      type: "operation.failed",
      workflowId: optionalIdentifier(payload.workflowId),
      code: failure.code,
      message: failure.message,
    } satisfies EngineEvent)
  }
}

async function applyFinishAction(
  action: AfterCaptureAction,
  media: MediaItem,
  storage: StorageService,
  windows: WindowManager,
): Promise<void> {
  if (action === "open-editor") {
    windows.show(`editor/${media.id}`)
  } else if (action === "open-library") {
    windows.show("library")
  } else if (action === "reveal-file") {
    const path = storage.getMediaPath(media.id)
    if (path !== undefined) shell.showItemInFolder(path)
  }
}

type CompiledExport = {
  request: ProjectExportRequest
  warnings: string[]
}

type ExportDestinationSelection = {
  destination: string
  /** True only when the selected path existed when the native dialog returned. */
  overwrite: boolean
}

async function chooseExportDestination(
  windows: WindowManager,
  exportDirectory: string,
  project: EditorProject,
  request: ExportStartRequest,
  format: OutputFormat,
): Promise<ExportDestinationSelection | undefined> {
  await mkdir(exportDirectory, { recursive: true })
  const extension = format === "mp4" ? ".mp4" : ".gif"
  const requestedStem = request.suggestedName ?? project.title
  const stem = safeFileStem(requestedStem.replace(/\.(?:mp4|gif)$/i, ""))
  const options: SaveDialogOptions = {
    title: format === "mp4" ? "Export SharpShot video" : "Export SharpShot GIF",
    defaultPath: join(exportDirectory, `${stem}${extension}`),
    filters: [
      format === "mp4"
        ? { name: "MP4 video", extensions: ["mp4"] }
        : { name: "Animated GIF", extensions: ["gif"] },
    ],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  }
  const parent = windows.window
  const selection = parent === null
    ? await dialog.showSaveDialog(options)
    : await dialog.showSaveDialog(parent, options)
  if (selection.canceled || selection.filePath === undefined) return undefined
  let destination = selection.filePath
  const selectedExtension = extname(destination).toLowerCase()
  if (selectedExtension.length === 0) destination += extension
  else if (selectedExtension !== extension) {
    throw new ExportValidationError(`The export filename must end in ${extension}.`)
  }
  if (destination.length > 32_767) throw new ExportValidationError("The export path is too long.")
  destination = resolve(destination)
  return {
    destination,
    overwrite: await destinationExists(destination),
  }
}

async function destinationExists(destination: string): Promise<boolean> {
  try {
    await lstat(destination)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false
    throw error
  }
}

async function compileProjectExportRequest(
  project: EditorProject,
  overrides: ExportStartRequest,
  outputPath: string,
  overwrite: boolean,
  storage: StorageService,
): Promise<CompiledExport> {
  const format = overrides.format ?? project.export.format
  const requestedFps = overrides.fps ?? project.export.fps
  const includeAudio = format === "mp4" && (overrides.includeAudio ?? true)
  const warnings: string[] = []

  if (format === "gif" && requestedFps > 50) {
    warnings.push("GIF frame rate was limited to 50 fps for reliable palette rendering.")
  }

  const referencedAssetIds = new Set<AssetId>()
  for (const clip of project.clips) {
    const asset = project.assets[clip.assetId]
    if (asset === undefined) throw new ExportValidationError(`Project asset ${clip.assetId} is missing.`)
    if (asset.kind !== "video") {
      throw new ExportValidationError(`Clip ${clip.id} does not reference a video asset.`)
    }
    referencedAssetIds.add(asset.id)
  }
  if (project.clips.length === 0) throw new ExportValidationError("Cannot export an empty project.")
  if (project.canvas.background.kind === "image") {
    const backgroundAsset = project.assets[project.canvas.background.assetId]
    if (backgroundAsset === undefined) {
      throw new ExportValidationError(`Project asset ${project.canvas.background.assetId} is missing.`)
    }
    if (backgroundAsset.kind !== "image") {
      throw new ExportValidationError("The canvas background does not reference an image.")
    }
    referencedAssetIds.add(backgroundAsset.id)
  }

  const assetPaths: Record<AssetId, string> = {}
  for (const assetId of referencedAssetIds) {
    const asset = project.assets[assetId]
    if (asset === undefined) throw new ExportValidationError(`Project asset ${assetId} is missing.`)
    assetPaths[assetId] = await storage.resolveProjectAssetPath(asset)
  }
  if (includeAudio && project.audio !== undefined) {
    for (const assetId of activeProjectAudioAssetIds(project.audio)) {
      if (Object.hasOwn(assetPaths, assetId)) {
        throw new ExportValidationError(`Project audio asset ${assetId} collides with a video asset.`)
      }
      const asset = project.audio.assets[assetId]
      if (asset === undefined) {
        throw new ExportValidationError(`Project audio asset ${assetId} is missing.`)
      }
      assetPaths[assetId] = await storage.resolveProjectAudioAssetPath(asset)
    }
  }

  return {
    request: {
      project,
      assetPaths,
      format,
      outputPath,
      overwrite,
      width: overrides.width,
      height: overrides.height,
      frameRate: overrides.fps,
      quality: overrides.quality,
      includeAudio,
      audioBitRateKbps: 192,
      hardwareAcceleration: "auto",
      ...(format === "gif" ? {
        gif: {
          frameRate: Math.min(requestedFps, 50),
          maxWidth: overrides.width ?? project.canvas.width,
        },
      } : {}),
    },
    warnings: [...new Set(warnings)],
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

async function assertProjectExportDestinationIsNotSource(
  outputPath: string,
  request: ProjectExportRequest,
): Promise<void> {
  const destination = await canonicalDestination(outputPath)
  for (const input of Object.values(request.assetPaths)) {
    const canonicalInput = await realpath(input)
    if (pathKey(canonicalInput) === pathKey(destination)) {
      throw new ExportValidationError("The export destination cannot overwrite project source media.")
    }
  }
}

async function canonicalDestination(value: string): Promise<string> {
  try {
    return await realpath(value)
  } catch {
    const parent = await realpath(dirname(value))
    return join(parent, basename(value))
  }
}

function publicMediaProbe(mediaId: string, result: MediaProbeResult): MediaProbe {
  return {
    mediaId,
    formatName: result.formatName,
    formatLongName: result.formatLongName,
    durationUs: result.durationUs,
    sizeBytes: result.sizeBytes,
    bitRate: result.bitRate,
    video: result.video === undefined ? undefined : { ...result.video },
    audio: result.audio === undefined ? undefined : { ...result.audio },
  }
}

function safeFileStem(value: string): string {
  const sanitized = value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120)
  return sanitized || "SharpShot export"
}

function rememberExportJob(
  jobs: Map<string, ExportJobSnapshot>,
  snapshot: ExportJobSnapshot,
): void {
  jobs.delete(snapshot.jobId)
  jobs.set(snapshot.jobId, structuredClone(snapshot))
  while (jobs.size > 32) {
    const oldest = jobs.keys().next().value as string | undefined
    if (oldest === undefined) break
    jobs.delete(oldest)
  }
}

function pathKey(value: string): string {
  const absolute = resolve(value)
  return process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute
}

async function registerOptionalAudio(
  storage: StorageService,
  path: string | undefined,
): Promise<MediaItem | undefined> {
  if (path === undefined) return undefined
  try {
    const media = await storage.registerMediaFile(path, "recording")
    return media.kind === "audio" ? media : undefined
  } catch {
    return undefined
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent, windows: WindowManager): void {
  const frame = event.senderFrame
  if (frame === null || frame !== event.sender.mainFrame || !windows.isTrustedSender(event.sender, frame.url)) {
    throw new NativeEngineError("UNTRUSTED_SENDER", "This request did not come from SharpShot.")
  }
}

function parseNoArgument(value: unknown): undefined {
  if (value !== undefined && value !== null) throw new ValidationError("This request does not accept arguments.")
  return undefined
}

export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof ValidationError || error instanceof StorageError || error instanceof NativeEngineError) {
    return { code: error.code, message: publicErrorMessage(error.message) }
  }
  if (error instanceof ExportBusyError) {
    return { code: "EXPORT_BUSY", message: "Another export is already running." }
  }
  if (error instanceof ExportCancelledError) {
    return { code: "EXPORT_CANCELLED", message: publicErrorMessage(error.message) }
  }
  if (error instanceof ExportValidationError) {
    return { code: "INVALID_EXPORT", message: publicErrorMessage(error.message) }
  }
  if (error instanceof MediaToolNotFoundError) {
    return { code: "MEDIA_TOOL_UNAVAILABLE", message: "The bundled FFmpeg tools are unavailable." }
  }
  if (error instanceof MediaProbeError) {
    return { code: "MEDIA_PROBE_FAILED", message: publicErrorMessage(error.message) }
  }
  if (error instanceof ExportProcessError) {
    return { code: "EXPORT_FAILED", message: publicErrorMessage(error.message) }
  }
  if (error instanceof Error && error.name === "WorkflowValidationError") {
    return { code: "INVALID_WORKFLOW", message: publicErrorMessage(error.message) }
  }
  if (error instanceof Error && error.name === "ProjectValidationError") {
    return { code: "INVALID_PROJECT", message: publicErrorMessage(error.message) }
  }
  return { code: "INTERNAL_ERROR", message: "SharpShot could not complete that request." }
}

function publicErrorMessage(message: string): string {
  return redactLocalPaths(message).slice(0, 512)
}

function broadcastLibrary(storage: StorageService, windows: WindowManager): void {
  windows.broadcast(IPC_EVENTS.libraryChanged, storage.listMedia())
}

function optionalIdentifier(value: unknown): string | undefined {
  if (value === undefined) return undefined
  try {
    return parseIdentifier(value)
  } catch {
    return undefined
  }
}

function optionalShortString(value: unknown, maximumLength = 128): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, maximumLength) : undefined
}

function optionalNativePath(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 32_767 ? value : undefined
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
