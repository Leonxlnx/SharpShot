import type {
    ApiResult,
    AppBootstrap,
    EditorProject,
    ExportStartRequest,
    ExportStartResult,
    MediaItem,
    ProjectSummary,
    SharpShotApi,
    ShortcutBinding,
    Workflow as NativeWorkflow,
    WorkflowStore,
    WorkflowStoreUpdate,
} from "../shared/api";
import type { Workflow } from "./types";

export function getDesktopBridge(): SharpShotApi | undefined {
    return (window as unknown as { sharpShot?: SharpShotApi }).sharpShot;
}

export function isDesktopBridgeAvailable(): boolean {
    return Boolean(getDesktopBridge());
}

export async function getBootstrap(): Promise<ApiResult<AppBootstrap> | undefined> {
    return getDesktopBridge()?.getBootstrap();
}

export async function importLibraryImages(): Promise<MediaItem[]> {
    const bridge = getDesktopBridge();
    if (!bridge) return [];
    const result = await bridge.library.import();
    return result.ok ? result.value.filter((item) => item.kind === "image") : [];
}

export async function openExternalLink(url: string): Promise<boolean> {
    const bridge = getDesktopBridge();
    if (!bridge) return false;
    const result = await bridge.system.openExternal(url);
    return result.ok && result.value;
}

export function sendWindowAction(action: "minimize" | "maximize" | "close"): void {
    void getDesktopBridge()?.windowAction(action);
}

export async function startNativeWorkflow(workflowId: string) {
    const bridge = getDesktopBridge();
    if (!bridge) return undefined;
    return bridge.engine.runWorkflow({ workflowId });
}

function toNativeWorkflow(workflow: Workflow, options: { quickVideoAudioMux?: boolean }): NativeWorkflow {
    const afterCapture = workflow.kind === "video" && workflow.after.includes("Open Editor") ? "open-editor" : "nothing";
    const separateAudioStems = workflow.kind === "video" && (workflow.systemAudio || workflow.microphone);
    const canMuxQuickAudio = options.quickVideoAudioMux === true && afterCapture !== "open-editor";
    const clipboard = workflow.after.includes("Copy") && (!separateAudioStems || canMuxQuickAudio) ? (workflow.kind === "screenshot" ? "image" : "file") : "none";
    const quality = workflow.quality === "Balanced" ? "balanced" : workflow.quality === "Maximum" ? "maximum" : "high";
    return {
        version: 1,
        id: workflow.id,
        name: workflow.name.trim() || "Untitled workflow",
        kind: workflow.kind,
        enabled: workflow.enabled,
        capture: {
            source: "area",
            cursor: workflow.cursor ? "visible" : "hidden",
            countdownMs: workflow.countdown === 3 ? 3_000 : 0,
        },
        ...(workflow.kind === "video" ? {
            video: {
                fps: workflow.fps ?? 60,
                quality,
                systemAudio: workflow.systemAudio,
                ...(workflow.microphone ? { microphoneDeviceId: "default" } : {}),
            },
        } : {}),
        finish: {
            saveOriginal: true,
            clipboard,
            afterCapture,
        },
    };
}

export function rendererWorkflowsToStore(
    workflows: readonly Workflow[],
    base: WorkflowStore,
    options: { quickVideoAudioMux?: boolean } = {},
): WorkflowStore {
    const retainedBindings = base.shortcutBindings.filter((binding) => binding.action.type !== "workflow.run");
    const workflowBindings: ShortcutBinding[] = workflows.flatMap((workflow) => workflow.shortcuts.map((chord, index) => ({
        version: 1 as const,
        id: `shortcut-${workflow.id}-${index + 1}`,
        accelerator: chord.join("+"),
        enabled: workflow.enabled,
        action: { type: "workflow.run" as const, workflowId: workflow.id },
    })));
    return {
        schemaVersion: 1,
        workflows: workflows.map((workflow) => toNativeWorkflow(workflow, options)),
        shortcutBindings: [...retainedBindings, ...workflowBindings],
    };
}

export async function persistWorkflowStore(store: WorkflowStore): Promise<ApiResult<WorkflowStoreUpdate> | undefined> {
    return getDesktopBridge()?.workflows.replace(store);
}

export async function listProjects(): Promise<ApiResult<ProjectSummary[]> | undefined> {
    return getDesktopBridge()?.projects.list();
}

export async function loadProject(projectId: string): Promise<ApiResult<EditorProject> | undefined> {
    return getDesktopBridge()?.projects.load(projectId);
}

export async function saveProject(project: EditorProject, autosave = false) {
    const bridge = getDesktopBridge();
    if (!bridge) return undefined;
    return autosave ? bridge.projects.autosave(project) : bridge.projects.save(project);
}

export async function flushProject(projectId?: string) {
    return getDesktopBridge()?.projects.flush(projectId);
}

export async function requestExport(request: ExportStartRequest): Promise<ApiResult<ExportStartResult> | undefined> {
    return getDesktopBridge()?.exporter.start(request);
}

export async function cancelExport(jobId: string) {
    return getDesktopBridge()?.exporter.cancel(jobId);
}

export function revealCapture(captureId: string): void {
    void getDesktopBridge()?.library.reveal(captureId);
}
