import { contextBridge, ipcRenderer } from "electron"
import type {
  AutoZoomGenerateRequest,
  AppRoute,
  EditorProject,
  EngineActionRequest,
  EngineEvent,
  ExportEvent,
  ExportStartRequest,
  MediaItem,
  OutputFolderId,
  SettingsPatch,
  SharpShotApi,
  WindowAction,
  WindowCloseRequest,
  WorkflowStore,
} from "../shared/api.js"
import { IPC_CHANNELS, IPC_EVENTS } from "../shared/api.js"

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  if (typeof listener !== "function") throw new TypeError("Event listener must be a function.")
  const wrapped = (_event: Electron.IpcRendererEvent, value: T): void => listener(value)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api: SharpShotApi & {
  startWorkflow(workflowId: string): ReturnType<SharpShotApi["engine"]["runWorkflow"]>
  revealCapture(mediaId: string): ReturnType<SharpShotApi["library"]["reveal"]>
} = Object.freeze({
  getBootstrap: () => ipcRenderer.invoke(IPC_CHANNELS.bootstrap),
  windowAction: (action: WindowAction) => ipcRenderer.invoke(IPC_CHANNELS.windowAction, action),
  completeWindowClose: (requestId: string) => ipcRenderer.invoke(IPC_CHANNELS.windowCloseReady, requestId),
  completeRouteReady: () => ipcRenderer.invoke(IPC_CHANNELS.windowRouteReady),
  onWindowCloseRequested: (listener: (request: WindowCloseRequest) => void) =>
    subscribe(IPC_EVENTS.windowCloseRequested, listener),
  settings: Object.freeze({
    get: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
    update: (patch: SettingsPatch) => ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, patch),
  }),
  workflows: Object.freeze({
    get: () => ipcRenderer.invoke(IPC_CHANNELS.workflowsGet),
    replace: (store: WorkflowStore) => ipcRenderer.invoke(IPC_CHANNELS.workflowsReplace, store),
    remove: (workflowId: string) => ipcRenderer.invoke(IPC_CHANNELS.workflowsRemove, workflowId),
  }),
  library: Object.freeze({
    list: () => ipcRenderer.invoke(IPC_CHANNELS.libraryList),
    import: () => ipcRenderer.invoke(IPC_CHANNELS.libraryImport),
    remove: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.libraryRemove, id),
    reveal: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.libraryReveal, id),
  }),
  folders: Object.freeze({
    reveal: (id: OutputFolderId) => ipcRenderer.invoke(IPC_CHANNELS.foldersReveal, id),
  }),
  engine: Object.freeze({
    status: () => ipcRenderer.invoke(IPC_CHANNELS.engineStatus),
    runWorkflow: (request: EngineActionRequest) => ipcRenderer.invoke(IPC_CHANNELS.engineRunWorkflow, request),
    stop: () => ipcRenderer.invoke(IPC_CHANNELS.engineStop),
    cancel: () => ipcRenderer.invoke(IPC_CHANNELS.engineCancel),
    onEvent: (listener: (event: EngineEvent) => void) => subscribe(IPC_EVENTS.engine, listener),
  }),
  projects: Object.freeze({
    list: () => ipcRenderer.invoke(IPC_CHANNELS.projectsList),
    load: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.projectsLoad, projectId),
    save: (project: EditorProject) => ipcRenderer.invoke(IPC_CHANNELS.projectsSave, project),
    autosave: (project: EditorProject) => ipcRenderer.invoke(IPC_CHANNELS.projectsAutosave, project),
    flush: (projectId?: string) => ipcRenderer.invoke(IPC_CHANNELS.projectsFlush, projectId),
    generateAutoZoom: (request: AutoZoomGenerateRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.projectsGenerateAutoZoom, request),
  }),
  exporter: Object.freeze({
    start: (request: ExportStartRequest) => ipcRenderer.invoke(IPC_CHANNELS.exportStart, request),
    cancel: (jobId: string) => ipcRenderer.invoke(IPC_CHANNELS.exportCancel, jobId),
    probe: (mediaId: string) => ipcRenderer.invoke(IPC_CHANNELS.exportProbe, mediaId),
    status: (jobId?: string) => ipcRenderer.invoke(IPC_CHANNELS.exportStatus, jobId),
    onEvent: (listener: (event: ExportEvent) => void) => subscribe(IPC_EVENTS.export, listener),
  }),
  system: Object.freeze({
    openExternal: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.systemOpenExternal, url),
  }),
  onNavigate: (listener: (route: AppRoute) => void) => subscribe(IPC_EVENTS.navigate, listener),
  onLibraryChanged: (listener: (items: MediaItem[]) => void) =>
    subscribe(IPC_EVENTS.libraryChanged, listener),

  // Narrow compatibility aliases for the renderer's initial bridge. They route
  // through the same validated IPC methods and expose no generic send primitive.
  startWorkflow: (workflowId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.engineRunWorkflow, { workflowId }),
  revealCapture: (mediaId: string) => ipcRenderer.invoke(IPC_CHANNELS.libraryReveal, mediaId),
})

contextBridge.exposeInMainWorld("sharpShot", api)
