import { useCallback, useEffect, useEffectEvent, useMemo, useReducer, useRef, useState } from "react";
import type {
    AppRoute as NativeAppRoute,
    AppSettings,
    BundledAudioTrack,
    EngineEvent,
    EngineStatus,
    ExportEvent,
    MediaItem,
    SettingsPatch,
    WorkflowStore,
} from "../shared/api";
import {
    getDesktopBridge,
    isDesktopBridgeAvailable,
    rendererWorkflowsToStore,
    saveProject,
    sendWindowAction,
    startNativeWorkflow,
} from "./bridge";
import { CAPTURES, DEFAULT_WORKFLOWS, INITIAL_PROJECT } from "./data";
import {
    canonicalProjectToRenderer,
    createCanonicalProjectFromVideo,
    mediaItemsToCaptures,
    nativeRouteToRenderer,
    rendererProjectToCanonical,
    workflowStoreToRenderer,
} from "./model-adapter";
import { Sidebar } from "./components/Sidebar";
import { BrandIntro } from "./components/BrandIntro";
import { WorkspaceSkeleton } from "./components/WorkspaceSkeleton";
import { TitleBar } from "./components/TitleBar";
import { Toast } from "./components/Toast";
import { EditorPage } from "./pages/EditorPage";
import { HomePage } from "./pages/HomePage";
import { LibraryPage } from "./pages/LibraryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";
import {
    appReducer,
    editorReducer,
    INITIAL_APP_STATE,
    INITIAL_EDITOR_STATE,
    type AppAction,
    type EditorAction,
} from "./state";
import { isProjectOperationCurrent, projectDocument, type ProjectOperationToken } from "./project-operation";
import { SerialTaskQueue } from "./serial-task-queue";
import { prepareWindowClose } from "./close-preparation";
import { failedEnabledBindings, rollbackRejectedWorkflowUpdate } from "./workflow-update";
import { shortcutFailureDetails } from "./shortcut-diagnostics";
import { MutationLock } from "./mutation-lock";
import { runLockedProjectSwitch } from "./project-switch";
import type { AppRoute, Workflow } from "./types";
import type { EditorProject as CanonicalEditorProject } from "../shared/project";

const ROUTE_TITLES: Record<AppRoute, string> = {
    home: "Capture",
    library: "Library",
    workflows: "Workflows",
    editor: "Studio",
    settings: "Settings",
};

const PREVIEW_SETTINGS: AppSettings = {
    schemaVersion: 1,
    launchAtLogin: false,
    closeToTray: true,
    showNotifications: true,
    theme: "system",
};

const EMPTY_WORKFLOW_STORE: WorkflowStore = { schemaVersion: 1, workflows: [], shortcutBindings: [] };
const CONNECTING_ENGINE: EngineStatus = {
    mode: "connecting",
    available: false,
    operationState: "idle",
    protocolVersion: null,
};

type SaveStatus = "saved" | "saving" | "error";

export interface AppBridgeEventHandlers {
    navigate(route: NativeAppRoute): void;
    libraryChanged(items: MediaItem[]): void;
    engineChanged(event: EngineEvent): void;
    exportChanged(event: ExportEvent): void;
}

export interface AppEventBridge {
    onNavigate(listener: (route: NativeAppRoute) => void): () => void;
    onLibraryChanged(listener: (items: MediaItem[]) => void): () => void;
    engine: { onEvent(listener: (event: EngineEvent) => void): () => void };
    exporter: { onEvent(listener: (event: ExportEvent) => void): () => void };
}

export function subscribeAppBridgeEvents(
    bridge: AppEventBridge,
    handlers: AppBridgeEventHandlers,
): () => void {
    const unsubscribes = [
        bridge.onNavigate(handlers.navigate),
        bridge.onLibraryChanged(handlers.libraryChanged),
        bridge.engine.onEvent(handlers.engineChanged),
        bridge.exporter.onEvent(handlers.exportChanged),
    ];
    return () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
}

export function resolveThemePreference(theme: AppSettings["theme"], prefersDark: boolean): "light" | "dark" {
    return theme === "system" ? prefersDark ? "dark" : "light" : theme;
}

export default function App() {
    const desktop = isDesktopBridgeAvailable();
    const previewMode = !desktop && import.meta.env.DEV;
    const [app, dispatch] = useReducer(appReducer, INITIAL_APP_STATE);
    const [editor, editorDispatch] = useReducer(editorReducer, INITIAL_EDITOR_STATE);
    const [settings, setSettings] = useState<AppSettings>(PREVIEW_SETTINGS);
    const [appVersion, setAppVersion] = useState("Preview");
    const [library, setLibrary] = useState<MediaItem[]>([]);
    const [audioCatalog, setAudioCatalog] = useState<BundledAudioTrack[]>([]);
    const [engine, setEngine] = useState<EngineStatus>(CONNECTING_ENGINE);
    const [bootstrapState, setBootstrapState] = useState<"loading" | "ready" | "error">("loading");
    const [activeMedia, setActiveMedia] = useState<MediaItem | null>(null);
    const [sourceHasAudio, setSourceHasAudio] = useState(false);
    const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
    const [editorLoading, setEditorLoading] = useState(false);
    const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
    const [exportDetail, setExportDetail] = useState<string | null>(null);
    const [captureDetail, setCaptureDetail] = useState<string | null>(null);
    const [quickVideoAudioMux, setQuickVideoAudioMux] = useState(false);
    const [closeInProgress, setCloseInProgress] = useState(false);
    const workflowStoreRef = useRef<WorkflowStore>(EMPTY_WORKFLOW_STORE);
    const lastWorkflowDocumentRef = useRef("");
    const canonicalProjectRef = useRef<CanonicalEditorProject | null>(null);
    const autosaveSequenceRef = useRef(0);
    const projectEpochRef = useRef(0);
    const editorOpenRequestRef = useRef(0);
    const lastPersistedEditorDocumentRef = useRef("");
    const workflowPersistQueueRef = useRef(new SerialTaskQueue());
    const closeRequestsRef = useRef(new Set<string>());
    const closeInProgressRef = useRef(false);
    const mutationLockRef = useRef(new MutationLock());
    const routeReadyReportedRef = useRef(false);

    const acquireMutationLock = useCallback((): (() => void) => {
        const release = mutationLockRef.current.acquire();
        closeInProgressRef.current = true;
        setCloseInProgress(true);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            release();
            const locked = mutationLockRef.current.locked;
            closeInProgressRef.current = locked;
            setCloseInProgress(locked);
        };
    }, []);

    const dispatchUserAction = useCallback((action: AppAction): void => {
        mutationLockRef.current.run(() => dispatch(action));
    }, []);

    const dispatchEditorAction = useCallback((action: EditorAction): boolean => {
        return mutationLockRef.current.run(() => editorDispatch(action));
    }, []);

    const notify = useCallback((title: string, detail: string, tone: "neutral" | "success" = "success") => {
        dispatch({ type: "SHOW_TOAST", toast: { id: Date.now(), title, detail, tone } });
    }, []);

    const captures = useMemo(
        () => desktop ? mediaItemsToCaptures(library) : previewMode ? CAPTURES : [],
        [desktop, library, previewMode],
    );
    const libraryImages = useMemo(() => library.filter((item) => item.kind === "image"), [library]);
    const libraryAudio = useMemo(() => library.filter((item) => item.kind === "audio"), [library]);
    const handleLibraryImagesImported = useCallback((items: MediaItem[]) => {
        setLibrary((current) => [
            ...new Map([...current, ...items].map((item) => [item.id, item])).values(),
        ]);
    }, []);
    const handleLibraryAudioImported = useCallback((items: MediaItem[]) => {
        setLibrary((current) => [
            ...new Map([...current, ...items].map((item) => [item.id, item])).values(),
        ]);
    }, []);

    const persistEditorNow = useCallback(async (): Promise<boolean> => {
        const base = canonicalProjectRef.current;
        if (!desktop || base === null) return true;
        const project = editor.continuousEditStart ?? editor.project;
        const token: ProjectOperationToken = { epoch: projectEpochRef.current, projectId: base.id };
        const rendererDocument = projectDocument(project);
        if (rendererDocument === lastPersistedEditorDocumentRef.current) return true;
        try {
            const next = rendererProjectToCanonical(project, base, library);
            setSaveStatus("saving");
            const result = await saveProject(next, false);
            if (!result?.ok) throw new Error(result?.error.message ?? "The project store did not respond.");
            if (isProjectOperationCurrent(token, projectEpochRef.current, canonicalProjectRef.current?.id)) {
                canonicalProjectRef.current = result.value.project;
                lastPersistedEditorDocumentRef.current = rendererDocument;
                setSaveStatus("saved");
            }
            return true;
        } catch (error) {
            if (!isProjectOperationCurrent(token, projectEpochRef.current, canonicalProjectRef.current?.id)) return false;
            setSaveStatus("error");
            notify("Project not saved", error instanceof Error ? error.message : "The project could not be saved.", "neutral");
            return false;
        }
    }, [desktop, editor.continuousEditStart, editor.project, library, notify]);

    const leaveEditor = useCallback(async (route?: Exclude<AppRoute, "editor">): Promise<boolean> => {
        if (mutationLockRef.current.locked) return false;
        const release = acquireMutationLock();
        let transitionScheduled = false;
        try {
            const epoch = projectEpochRef.current;
            const saved = await persistEditorNow();
            if (!saved || epoch !== projectEpochRef.current) return false;
            editorOpenRequestRef.current += 1;
            projectEpochRef.current += 1;
            autosaveSequenceRef.current += 1;
            canonicalProjectRef.current = null;
            lastPersistedEditorDocumentRef.current = "";
            setActiveProjectId(null);
            setActiveMedia(null);
            if (route) dispatch({ type: "NAVIGATE", route });
            else dispatch({ type: "CLOSE_EDITOR" });
            transitionScheduled = true;
            window.setTimeout(release, 0);
            return true;
        } finally {
            if (!transitionScheduled) release();
        }
    }, [acquireMutationLock, persistEditorNow]);

    useEffect(() => {
        if (!app.toast) return undefined;
        const timer = window.setTimeout(() => dispatch({ type: "CLEAR_TOAST", id: app.toast?.id ?? 0 }), 5200);
        return () => window.clearTimeout(timer);
    }, [app.toast]);

    useEffect(() => {
        const systemTheme = typeof window.matchMedia === "function"
            ? window.matchMedia("(prefers-color-scheme: dark)")
            : null;
        const applyTheme = () => {
            const resolved = resolveThemePreference(settings.theme, systemTheme?.matches !== false);
            document.documentElement.dataset.theme = resolved;
            document.documentElement.dataset.themePreference = settings.theme;
            document.documentElement.style.colorScheme = resolved;
        };
        applyTheme();
        if (settings.theme !== "system" || systemTheme === null) return undefined;
        systemTheme.addEventListener("change", applyTheme);
        return () => systemTheme.removeEventListener("change", applyTheme);
    }, [settings.theme]);

    useEffect(() => {
        const bridge = getDesktopBridge();
        if (!bridge) {
            if (previewMode) {
                dispatch({ type: "HYDRATE_WORKFLOWS", workflows: DEFAULT_WORKFLOWS });
                setEngine({ mode: "mock", available: false, operationState: "idle", protocolVersion: null, reason: "Browser design preview" });
                setBootstrapState("ready");
            } else {
                setBootstrapState("error");
                notify("Desktop bridge unavailable", "SharpShot stopped instead of showing demo data. Restart the app to restore the secure preload bridge.", "neutral");
            }
            return;
        }

        let cancelled = false;
        void bridge.getBootstrap().then((result) => {
            if (cancelled) return;
            if (!result.ok) {
                setBootstrapState("error");
                notify("SharpShot could not start", result.error.message, "neutral");
                return;
            }
            const workflows = workflowStoreToRenderer(result.value.workflowStore, result.value.capabilities);
            workflowStoreRef.current = result.value.workflowStore;
            // Persist capability-safe normalization (region capture, visible/burned cursor,
            // and supported countdowns) if an older store contains aspirational values.
            lastWorkflowDocumentRef.current = JSON.stringify(result.value.workflowStore);
            setAppVersion(result.value.appVersion);
            setQuickVideoAudioMux(result.value.capabilities.quickVideoAudioMux);
            setSettings(result.value.settings);
            setLibrary(result.value.library);
            setAudioCatalog(result.value.audioCatalog);
            setEngine(result.value.engine);
            dispatch({ type: "HYDRATE_WORKFLOWS", workflows });
            setBootstrapState("ready");
            const shortcutFailures = shortcutFailureDetails(result.value.engine.shortcutFailures, result.value.workflowStore);
            if (shortcutFailures.length > 0) {
                notify("Shortcut conflict", shortcutFailures.join(" · "), "neutral");
            }
            if (!result.value.engine.available) {
                notify("Capture engine unavailable", result.value.engine.reason ?? "The native capture helper did not start.", "neutral");
            }
        }).catch((error: unknown) => {
            if (cancelled) return;
            setBootstrapState("error");
            notify("SharpShot could not start", error instanceof Error ? error.message : "The desktop bridge did not respond.", "neutral");
        });
        return () => { cancelled = true; };
    }, [notify, previewMode]);

    const openEditor = useCallback(async (requestedMediaId?: string) => {
        if (mutationLockRef.current.locked) return;
        const request = ++editorOpenRequestRef.current;
        const bridge = getDesktopBridge();
        if (!bridge) {
            if (!previewMode) {
                notify("Studio unavailable", "The secure desktop bridge is missing.", "neutral");
                return;
            }
            projectEpochRef.current += 1;
            const previewCapture = CAPTURES.find((capture) => capture.id === requestedMediaId) ?? CAPTURES[0];
            setActiveMedia(previewCapture ? {
                id: previewCapture.id,
                name: previewCapture.name,
                kind: "image",
                origin: "import",
                mimeType: "image/png",
                byteLength: 0,
                createdAt: new Date().toISOString(),
                modifiedAt: new Date().toISOString(),
                url: previewCapture.thumbnail,
            } : null);
            setActiveProjectId(null);
            setSourceHasAudio(false);
            lastPersistedEditorDocumentRef.current = projectDocument(INITIAL_PROJECT);
            editorDispatch({ type: "LOAD_PROJECT", project: INITIAL_PROJECT });
            dispatch({ type: "OPEN_EDITOR" });
            return;
        }

        const openRequestedMedia = async (keepCurrentOnMissing: boolean): Promise<void> => {
            let media = library.find((item) => item.id === requestedMediaId && item.kind === "video");
            if (!media) {
                const refreshed = await bridge.library.list();
                if (request !== editorOpenRequestRef.current) return;
                if (refreshed.ok) {
                    setLibrary(refreshed.value);
                    media = refreshed.value.find((item) => item.id === requestedMediaId && item.kind === "video");
                }
            }
            if (!media) {
                notify("Recording unavailable", "Choose a video from your local library first.", "neutral");
                if (!keepCurrentOnMissing) dispatch({ type: "NAVIGATE", route: "library" });
                return;
            }

            const epoch = ++projectEpochRef.current;
            autosaveSequenceRef.current += 1;
            canonicalProjectRef.current = null;
            setActiveProjectId(null);
            dispatch({ type: "OPEN_EDITOR" });
            setEditorLoading(true);
            setActiveMedia(media);
            try {
                const summaries = await bridge.projects.list();
                if (!summaries.ok) throw new Error(summaries.error.message);
                const existing = summaries.value
                    .filter((project) => project.thumbnailMediaId === media?.id)
                    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
                let canonical: CanonicalEditorProject;
                if (existing) {
                    const loaded = await bridge.projects.load(existing.id);
                    if (!loaded.ok) throw new Error(loaded.error.message);
                    canonical = loaded.value;
                } else {
                    const probe = await bridge.exporter.probe(media.id);
                    if (!probe.ok) throw new Error(probe.error.message);
                    canonical = createCanonicalProjectFromVideo(media, probe.value);
                    const saved = await bridge.projects.save(canonical);
                    if (!saved.ok) throw new Error(saved.error.message);
                    canonical = saved.value.project;
                }
                if (request !== editorOpenRequestRef.current || epoch !== projectEpochRef.current) return;
                canonicalProjectRef.current = canonical;
                const sourceAsset = canonical.assets[media.id];
                setSourceHasAudio(sourceAsset?.kind === "video" && sourceAsset.audio !== undefined);
                setActiveProjectId(canonical.id);
                const rendererProject = canonicalProjectToRenderer(canonical);
                lastPersistedEditorDocumentRef.current = projectDocument(rendererProject);
                editorDispatch({ type: "LOAD_PROJECT", project: rendererProject });
                setSaveStatus("saved");
            } catch (error) {
                if (request !== editorOpenRequestRef.current || epoch !== projectEpochRef.current) return;
                canonicalProjectRef.current = null;
                lastPersistedEditorDocumentRef.current = "";
                setSourceHasAudio(false);
                setActiveProjectId(null);
                setActiveMedia(null);
                notify("Could not open Studio", error instanceof Error ? error.message : "The recording could not be prepared.", "neutral");
                dispatch({ type: "NAVIGATE", route: "library" });
            } finally {
                if (request === editorOpenRequestRef.current && epoch === projectEpochRef.current) setEditorLoading(false);
            }
        };

        const currentProjectId = canonicalProjectRef.current?.id;
        if (currentProjectId === undefined) {
            await openRequestedMedia(false);
            return;
        }

        try {
            await runLockedProjectSwitch({
                acquire: acquireMutationLock,
                currentProjectId,
                sameMedia: requestedMediaId === activeMedia?.id,
                persistCurrent: persistEditorNow,
                flushCurrent: async (projectId) => {
                    const result = await bridge.projects.flush(projectId);
                    if (!result.ok) notify("Project not saved", result.error.message, "neutral");
                    return result.ok;
                },
                continueSwitch: () => openRequestedMedia(true),
            });
        } catch (error) {
            notify("Project not saved", error instanceof Error ? error.message : "The current project could not be finalized.", "neutral");
        }
    }, [acquireMutationLock, activeMedia?.id, library, notify, persistEditorNow, previewMode]);

    const handleNavigateEvent = useEffectEvent((route: NativeAppRoute) => {
        const destination = nativeRouteToRenderer(route);
        if (destination.route === "editor") void openEditor(destination.mediaId);
        else if (app.route === "editor") void leaveEditor(destination.route);
        else dispatch({ type: "NAVIGATE", route: destination.route });
    });
    const handleLibraryChangedEvent = useEffectEvent((items: MediaItem[]) => setLibrary(items));
    const handleEngineChangedEvent = useEffectEvent((event: EngineEvent) => {
            if (event.type === "status") setEngine(event.status);
            else if (event.type === "state.changed") setEngine((current) => ({ ...current, operationState: event.state }));
            else if (event.type === "operation.failed") {
                setCaptureDetail(null);
                notify("Capture failed", event.message, "neutral");
            }
            else if (event.type === "record.processing") {
                const percent = Math.round(Math.max(0, Math.min(1, event.fraction)) * 100);
                setCaptureDetail(`Merging audio ${percent}%`);
                setEngine((current) => ({ ...current, operationState: "finalizing" }));
            }
            else if (event.type === "operation.cancelled") {
                setCaptureDetail(null);
                notify("Capture cancelled", "Nothing was saved.", "neutral");
            }
            else if (event.type === "screenshot.completed" && settings.showNotifications) notify("Screenshot saved", event.media?.name ?? "The image is in your local library.");
            else if (event.type === "record.completed") {
                setCaptureDetail(null);
                const warnings = event.warnings ?? [];
                const detail = warnings.length > 0
                    ? warnings.join(" · ")
                    : event.clipboardReady
                        ? `${event.media?.name ?? "Recording saved"} · Ready to paste.`
                        : event.audioRequiresMux
                            ? "The original video and separate audio stems were saved, but a paste-ready merged copy was not created."
                            : event.systemAudio || event.microphoneAudio
                                ? "Video and separate audio stems were saved locally."
                                : event.media?.name ?? "The video is in your local library.";
                if (settings.showNotifications || warnings.length > 0 || event.audioRequiresMux) {
                    notify(warnings.length > 0 ? "Recording saved with a warning" : "Recording saved", detail, warnings.length > 0 || event.audioRequiresMux ? "neutral" : "success");
                }
            }
    });
    const handleExportChangedEvent = useEffectEvent((event: ExportEvent) => {
        if (event.type === "progress") setExportDetail(`${event.phase} ${Math.round(event.fraction * 100)}%`);
        else if (event.type === "completed") setExportDetail("Export complete");
        else if (event.type === "failed") setExportDetail("Export failed");
        else setExportDetail(null);
    });

    useEffect(() => {
        const bridge = getDesktopBridge();
        if (!bridge) return undefined;
        return subscribeAppBridgeEvents(bridge, {
            navigate: handleNavigateEvent,
            libraryChanged: handleLibraryChangedEvent,
            engineChanged: handleEngineChangedEvent,
            exportChanged: handleExportChangedEvent,
        });
    }, []);

    useEffect(() => {
        const bridge = getDesktopBridge();
        if (!bridge) return;
        if (!routeReadyReportedRef.current) {
            routeReadyReportedRef.current = true;
            void bridge.completeRouteReady().then((result) => {
                if (!result.ok) routeReadyReportedRef.current = false;
            }).catch(() => { routeReadyReportedRef.current = false; });
        }
    });

    const persistWorkflowsNow = useCallback((): Promise<boolean> => {
        if (!desktop || bootstrapState !== "ready") return Promise.resolve(true);
        const workflows = app.workflows;
        return workflowPersistQueueRef.current.run(async () => {
            const nextStore = rendererWorkflowsToStore(workflows, workflowStoreRef.current, { quickVideoAudioMux });
            const document = JSON.stringify(nextStore);
            if (document === lastWorkflowDocumentRef.current) return true;
            const bridge = getDesktopBridge();
            if (!bridge) {
                notify("Workflow not saved", "The secure desktop bridge is unavailable.", "neutral");
                return false;
            }
            const result = await bridge.workflows.replace(nextStore);
            if (!result.ok) {
                notify("Workflow not saved", result.error.message, "neutral");
                return false;
            }
            if (!result.value.applied) {
                const rollback = rollbackRejectedWorkflowUpdate(result.value, { quickVideoAudioMux });
                workflowStoreRef.current = rollback.store;
                lastWorkflowDocumentRef.current = rollback.document;
                dispatch({ type: "HYDRATE_WORKFLOWS", workflows: rollback.workflows });
                notify("Shortcut change not applied", rollback.message, "neutral");
                return false;
            }
            workflowStoreRef.current = result.value.store;
            lastWorkflowDocumentRef.current = JSON.stringify(rendererWorkflowsToStore(workflows, result.value.store, { quickVideoAudioMux }));
            const failed = failedEnabledBindings(result.value.bindings, nextStore);
            if (failed.length > 0) {
                const details = failed.map((binding) => {
                    const shortcut = nextStore.shortcutBindings.find((item) => item.id === binding.bindingId)?.accelerator ?? binding.bindingId;
                    return `${shortcut}: ${binding.reason ?? "already used by another app"}`;
                }).join(" · ");
                notify("Shortcut conflict", details, "neutral");
            }
            return true;
        });
    }, [app.workflows, bootstrapState, desktop, notify, quickVideoAudioMux]);

    useEffect(() => {
        if (!desktop || bootstrapState !== "ready") return undefined;
        const nextStore = rendererWorkflowsToStore(app.workflows, workflowStoreRef.current, { quickVideoAudioMux });
        if (JSON.stringify(nextStore) === lastWorkflowDocumentRef.current) return undefined;
        const timer = window.setTimeout(() => { void persistWorkflowsNow(); }, 260);
        return () => window.clearTimeout(timer);
    }, [app.workflows, bootstrapState, desktop, persistWorkflowsNow, quickVideoAudioMux]);

    useEffect(() => {
        const bridge = getDesktopBridge();
        if (!bridge) return undefined;
        return bridge.onWindowCloseRequested((request) => {
            if (closeRequestsRef.current.has(request.requestId)) return;
            closeRequestsRef.current.add(request.requestId);
            const releaseMutationLock = acquireMutationLock();
            const unlockClose = (): void => {
                releaseMutationLock();
                closeRequestsRef.current.delete(request.requestId);
            };
            void (async () => {
                try {
                    const prepared = await prepareWindowClose({
                        editorActive: app.route === "editor",
                        projectId: activeProjectId,
                        persistWorkflows: persistWorkflowsNow,
                        persistProject: persistEditorNow,
                        flushProject: async (projectId) => {
                            const result = await bridge.projects.flush(projectId);
                            return result.ok;
                        },
                    });
                    if (!prepared) {
                        unlockClose();
                        notify("Close cancelled", "SharpShot stayed open because the latest local changes could not be saved.", "neutral");
                        return;
                    }
                    const completed = await bridge.completeWindowClose(request.requestId);
                    if (!completed.ok || !completed.value) {
                        unlockClose();
                        notify("Close cancelled", completed.ok ? "The close request expired before it could be confirmed." : completed.error.message, "neutral");
                    }
                } catch (error) {
                    unlockClose();
                    notify("Close cancelled", error instanceof Error ? error.message : "SharpShot could not confirm the local save.", "neutral");
                }
            })();
        });
    }, [acquireMutationLock, activeProjectId, app.route, notify, persistEditorNow, persistWorkflowsNow]);

    useEffect(() => {
        const base = canonicalProjectRef.current;
        if (!desktop || base === null || editorLoading || app.route !== "editor" || editor.continuousEditStart !== null) return undefined;
        const sequence = ++autosaveSequenceRef.current;
        const token: ProjectOperationToken = { epoch: projectEpochRef.current, projectId: base.id };
        const rendererDocument = projectDocument(editor.project);
        if (rendererDocument === lastPersistedEditorDocumentRef.current) return undefined;
        setSaveStatus("saving");
        const timer = window.setTimeout(() => {
            let next: CanonicalEditorProject;
            try {
                if (!isProjectOperationCurrent(token, projectEpochRef.current, canonicalProjectRef.current?.id)) return;
                next = rendererProjectToCanonical(editor.project, base, library);
                canonicalProjectRef.current = next;
            } catch (error) {
                setSaveStatus("error");
                notify("Project change not saved", error instanceof Error ? error.message : "The project became invalid.", "neutral");
                return;
            }
            void saveProject(next, true).then((result) => {
                if (sequence !== autosaveSequenceRef.current || !isProjectOperationCurrent(token, projectEpochRef.current, canonicalProjectRef.current?.id)) return;
                if (result?.ok) {
                    canonicalProjectRef.current = result.value.project;
                    lastPersistedEditorDocumentRef.current = rendererDocument;
                    setSaveStatus("saved");
                } else {
                    setSaveStatus("error");
                    notify("Autosave failed", result?.error.message ?? "The desktop project store did not respond.", "neutral");
                }
            });
        }, 420);
        return () => window.clearTimeout(timer);
    }, [app.route, desktop, editor.continuousEditStart, editor.project, editorLoading, library, notify]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (closeInProgressRef.current) return;
            if (app.route !== "editor" && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                dispatchUserAction({ type: "NAVIGATE", route: "library" });
                window.setTimeout(() => document.querySelector<HTMLInputElement>(".library-search input")?.focus(), 0);
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [app.route, dispatchUserAction]);

    const runWorkflow = async (workflow: Workflow) => {
        if (!workflow.enabled) {
            notify("Workflow disabled", `Enable ${workflow.name} before running it.`, "neutral");
            return;
        }
        const result = await startNativeWorkflow(workflow.id);
        if (result === undefined) {
            notify("Desktop capture required", "Global capture is unavailable in the browser design preview.", "neutral");
        } else if (!result.ok) {
            notify("Could not start capture", result.error.message, "neutral");
        } else if (!result.value.accepted) {
            notify("Capture busy", "Finish or cancel the active capture first.", "neutral");
        } else {
            notify(`${workflow.name} started`, "Select an area to begin.");
        }
    };

    const updateSettings = async (patch: SettingsPatch): Promise<void> => {
        const bridge = getDesktopBridge();
        if (!bridge) throw new Error("Settings are only stored by the installed desktop app.");
        const result = await bridge.settings.update(patch);
        if (!result.ok) throw new Error(result.error.message);
        setSettings(result.value);
    };

    const importMedia = async () => {
        const bridge = getDesktopBridge();
        if (!bridge) {
            notify("Desktop import required", "Use the installed app to add local media.", "neutral");
            return;
        }
        const result = await bridge.library.import();
        if (!result.ok) notify("Import failed", result.error.message, "neutral");
        else if (result.value.length > 0) notify("Media imported", `${result.value.length} item${result.value.length === 1 ? "" : "s"} added to the library.`);
    };

    const editWorkflow = (workflow: Workflow) => dispatchUserAction({ type: "SELECT_WORKFLOW", id: workflow.id });
    const navigate = (route: AppRoute) => dispatchUserAction({ type: "NAVIGATE", route });
    const titleDetail = app.route === "editor"
        ? exportDetail ?? (saveStatus === "saving" ? "Saving locally…" : saveStatus === "error" ? "Save failed" : "Saved locally")
        : captureDetail ?? (engine.operationState !== "idle" ? engine.operationState : engine.available ? undefined : engine.reason);

    return (
        <div aria-busy={closeInProgress} className={`app-shell${app.route === "editor" ? " app-shell--editor" : ""}${closeInProgress ? " app-shell--closing" : ""}`}>
            <BrandIntro ready={bootstrapState !== "loading"} />
            {app.route !== "editor" ? <TitleBar detail={closeInProgress ? "Saving before close…" : titleDetail} onRequestClose={() => { if (!closeInProgressRef.current) sendWindowAction("close"); }} title={app.route === "home" ? undefined : ROUTE_TITLES[app.route]} /> : null}
            {app.route !== "editor" ? <Sidebar onNavigate={navigate} route={app.route} /> : null}

            <div className="route-stage">
                {bootstrapState === "loading" && app.route !== "editor" ? <WorkspaceSkeleton variant="shell" /> : null}
                {bootstrapState === "error" && app.route !== "editor" ? <div className="page app-loading"><strong>SharpShot could not initialize.</strong><span>Restart the desktop app. No demo captures were loaded.</span></div> : null}
                {bootstrapState === "ready" && app.route === "home" ? (
                    <HomePage captures={captures} onEditWorkflow={editWorkflow} onNavigate={navigate} onOpenEditor={(id) => void openEditor(id)} onRunWorkflow={(workflow) => void runWorkflow(workflow)} workflows={app.workflows} />
                ) : null}
                {bootstrapState === "ready" && app.route === "library" ? (
                    <LibraryPage captures={captures} onImport={() => { if (!closeInProgressRef.current) void importMedia(); }} onOpenEditor={(id) => { if (!closeInProgressRef.current) void openEditor(id); }} onSelect={(id) => dispatchUserAction({ type: "SELECT_CAPTURE", id })} selectedId={app.selectedCaptureId} />
                ) : null}
                {bootstrapState === "ready" && app.route === "workflows" ? (
                    <WorkflowsPage
                        onCreate={(kind) => dispatchUserAction({ type: "CREATE_WORKFLOW", kind })}
                        onDelete={(id) => dispatchUserAction({ type: "DELETE_WORKFLOW", id })}
                        onDuplicate={(id) => dispatchUserAction({ type: "DUPLICATE_WORKFLOW", id })}
                        onSelect={(id) => dispatchUserAction({ type: "SELECT_WORKFLOW", id })}
                        onUpdate={(workflow) => dispatchUserAction({ type: "UPDATE_WORKFLOW", workflow })}
                        quickVideoAudioMux={quickVideoAudioMux}
                        selectedId={app.selectedWorkflowId}
                        workflows={app.workflows}
                    />
                ) : null}
                {bootstrapState === "ready" && app.route === "settings" ? <SettingsPage appVersion={appVersion} onUpdate={updateSettings} settings={settings} /> : null}
                {app.route === "editor" ? bootstrapState !== "ready" || editorLoading ? <WorkspaceSkeleton error={bootstrapState === "error"} label={bootstrapState === "error" ? "SharpShot could not initialize. Restart the desktop app." : undefined} onRequestWindowClose={() => { if (!closeInProgressRef.current) sendWindowAction("close"); }} variant="editor" /> : (
                    <EditorPage
                        audioCatalog={audioCatalog}
                        dispatch={dispatchEditorAction}
                        libraryAudio={libraryAudio}
                        libraryImages={libraryImages}
                        media={activeMedia}
                        mutationsLocked={closeInProgress}
                        onClose={() => { void leaveEditor(); }}
                        onRequestWindowClose={() => { if (!closeInProgressRef.current) sendWindowAction("close"); }}
                        onLibraryAudioImported={handleLibraryAudioImported}
                        onLibraryImagesImported={handleLibraryImagesImported}
                        onNotify={notify}
                        onPrepareExport={persistEditorNow}
                        projectId={activeProjectId}
                        sourceHasAudio={sourceHasAudio}
                        statusDetail={closeInProgress ? "Saving before close…" : titleDetail}
                        state={editor}
                    />
                ) : null}
            </div>

            {app.toast ? <Toast onClose={() => dispatch({ type: "CLEAR_TOAST", id: app.toast?.id ?? 0 })} toast={app.toast} /> : null}
        </div>
    );
}
