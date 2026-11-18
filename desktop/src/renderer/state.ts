import { INITIAL_PROJECT } from "./data";
import { reduceZoomSegments, type ZoomOperation } from "../shared/cursor-zoom";
import { isFullCrop, type ScreenTransformPatch } from "./screen-manipulation";
import { outputTimelineTransformForClips } from "./output-timeline-transform";
import { remapZoomSegments } from "./zoom-remap";
import { remapOverlayDocument } from "./overlay-time-remap";
import { projectDocument } from "./project-operation";
import { canonicalizeOverlayDocument, type OverlayDocument } from "../shared/overlays";
import { clipTimelineEndUs, type AudioTimeline } from "../shared/audio-timeline";
import {
    findAudioClip,
    reconcileAudioTimeline,
    removeAudioClip,
    splitSelectedAudioClip,
} from "./audio-editor";
import type { AppRoute, EditorClip, EditorProject, EditorState, ToastMessage, Workflow } from "./types";
import { isSafeRedaction } from "./safe-redaction";

export interface AppState {
    route: AppRoute;
    previousRoute: Exclude<AppRoute, "editor">;
    workflows: Workflow[];
    selectedWorkflowId: string;
    selectedCaptureId: string | null;
    toast: ToastMessage | null;
}

export type AppAction =
    | { type: "NAVIGATE"; route: AppRoute }
    | { type: "HYDRATE_WORKFLOWS"; workflows: Workflow[] }
    | { type: "OPEN_EDITOR" }
    | { type: "CLOSE_EDITOR" }
    | { type: "SELECT_WORKFLOW"; id: string }
    | { type: "UPDATE_WORKFLOW"; workflow: Workflow }
    | { type: "DUPLICATE_WORKFLOW"; id: string }
    | { type: "CREATE_WORKFLOW"; kind: "screenshot" | "video" }
    | { type: "DELETE_WORKFLOW"; id: string }
    | { type: "SELECT_CAPTURE"; id: string | null }
    | { type: "SHOW_TOAST"; toast: ToastMessage }
    | { type: "CLEAR_TOAST"; id: number };

export const INITIAL_APP_STATE: AppState = {
    route: "home",
    previousRoute: "home",
    workflows: [],
    selectedWorkflowId: "",
    selectedCaptureId: null,
    toast: null,
};

export function appReducer(state: AppState, action: AppAction): AppState {
    switch (action.type) {
        case "HYDRATE_WORKFLOWS":
            return {
                ...state,
                workflows: action.workflows,
                selectedWorkflowId: action.workflows.some((workflow) => workflow.id === state.selectedWorkflowId)
                    ? state.selectedWorkflowId
                    : action.workflows[0]?.id ?? "",
            };
        case "NAVIGATE":
            return {
                ...state,
                route: action.route,
                previousRoute: action.route === "editor" ? state.previousRoute : action.route,
            };
        case "OPEN_EDITOR":
            return {
                ...state,
                route: "editor",
                previousRoute: state.route === "editor" ? state.previousRoute : state.route,
            };
        case "CLOSE_EDITOR":
            return { ...state, route: state.previousRoute };
        case "SELECT_WORKFLOW":
            return { ...state, selectedWorkflowId: action.id, route: "workflows" };
        case "UPDATE_WORKFLOW":
            return {
                ...state,
                workflows: state.workflows.map((workflow) => workflow.id === action.workflow.id ? action.workflow : workflow),
            };
        case "DUPLICATE_WORKFLOW": {
            const source = state.workflows.find((workflow) => workflow.id === action.id);
            if (!source) {
                return state;
            }
            const copy: Workflow = {
                ...source,
                id: uniqueItemId(state.workflows, `${source.id.slice(0, 108)}-copy`),
                name: `${source.name} Copy`,
                shortcuts: [],
                after: [...source.after],
            };
            return {
                ...state,
                workflows: [...state.workflows, copy],
                selectedWorkflowId: copy.id,
                route: "workflows",
            };
        }
        case "CREATE_WORKFLOW": {
            const isVideo = action.kind === "video";
            const workflow: Workflow = {
                id: uniqueItemId(state.workflows, "workflow"),
                name: isVideo ? "New Video Workflow" : "New Screenshot Workflow",
                description: isVideo ? "A focused video capture recipe" : "A focused image capture recipe",
                kind: action.kind,
                target: "Region",
                shortcuts: [],
                enabled: true,
                fps: isVideo ? 60 : undefined,
                quality: isVideo ? "High" : "Lossless",
                cursor: isVideo,
                systemAudio: false,
                microphone: false,
                countdown: isVideo ? 3 : 0,
                after: ["Save to Library", "Copy"],
            };
            return {
                ...state,
                workflows: [...state.workflows, workflow],
                selectedWorkflowId: workflow.id,
                route: "workflows",
            };
        }
        case "DELETE_WORKFLOW": {
            if (state.workflows.length <= 1) {
                return state;
            }
            const workflows = state.workflows.filter((workflow) => workflow.id !== action.id);
            return {
                ...state,
                workflows,
                selectedWorkflowId: state.selectedWorkflowId === action.id ? workflows[0]?.id ?? "" : state.selectedWorkflowId,
            };
        }
        case "SELECT_CAPTURE":
            return { ...state, selectedCaptureId: action.id };
        case "SHOW_TOAST":
            return { ...state, toast: action.toast };
        case "CLEAR_TOAST":
            return state.toast?.id === action.id ? { ...state, toast: null } : state;
        default:
            return state;
    }
}

function uniqueItemId(items: readonly { id: string }[], prefix: string): string {
    const used = new Set(items.map((item) => item.id));
    let sequence = 1;
    let candidate = `${prefix}-${sequence}`;
    while (used.has(candidate)) {
        sequence += 1;
        candidate = `${prefix}-${sequence}`;
    }
    return candidate;
}

export type EditorAction =
    | { type: "LOAD_PROJECT"; project: EditorProject }
    | { type: "SET_PLAYING"; playing: boolean }
    | { type: "SET_PLAYHEAD"; time: number }
    | { type: "TICK"; delta: number }
    | { type: "SELECT_CLIP"; id: string }
    | { type: "SELECT_ZOOM"; id: string | null }
    | { type: "SELECT_CAPTION"; id: string | null }
    | { type: "SELECT_OVERLAY"; id: string | null }
    | { type: "SELECT_AUDIO_CLIP"; id: string | null }
    | { type: "EDIT_ZOOM"; operation: ZoomOperation }
    | { type: "EDIT_OVERLAYS"; document: OverlayDocument; selectedCaptionId?: string | null; selectedOverlayId?: string | null }
    | { type: "EDIT_AUDIO"; timeline: AudioTimeline | undefined; selectedAudioClipId?: string | null }
    | { type: "BEGIN_CONTINUOUS_EDIT" }
    | { type: "COMMIT_CONTINUOUS_EDIT" }
    | { type: "CANCEL_CONTINUOUS_EDIT" }
    | { type: "SET_TOOL"; tool: EditorState["activeTool"] }
    | { type: "SPLIT" }
    | { type: "REMOVE_SELECTED" }
    | { type: "SET_SPEED"; speed: number }
    | { type: "TRIM_CLIP"; id: string; sourceStart: number; sourceEnd: number }
    | { type: "COMMIT_TRIM_CLIP"; before: EditorProject; id: string; side: TrimSide; sourceStart: number; sourceEnd: number }
    | { type: "SET_BACKGROUND"; id: string }
    | { type: "SET_ASPECT"; value: EditorProject["aspectRatio"] }
    | { type: "SET_PADDING"; value: number }
    | { type: "SET_CORNER_RADIUS"; value: number }
    | { type: "SET_SHADOW"; value: number }
    | { type: "SET_FIT_MODE"; value: EditorProject["fitMode"] }
    | { type: "SET_SCREEN_TRANSFORM"; patch: ScreenTransformPatch }
    | { type: "SET_SCALE"; value: number }
    | { type: "SET_OFFSET_X"; value: number }
    | { type: "SET_OFFSET_Y"; value: number }
    | { type: "SET_SYSTEM_VOLUME"; value: number }
    | { type: "SET_MICROPHONE_VOLUME"; value: number }
    | { type: "UNDO" }
    | { type: "REDO" }
    | { type: "OPEN_EXPORT" }
    | { type: "CLOSE_EXPORT" };

export const INITIAL_EDITOR_STATE: EditorState = {
    project: INITIAL_PROJECT,
    continuousEditStart: null,
    history: [],
    future: [],
    playhead: 3.4,
    playing: false,
    selectedClipId: INITIAL_PROJECT.clips[0]?.id ?? "",
    selectedZoomId: null,
    selectedCaptionId: null,
    selectedOverlayId: null,
    selectedAudioClipId: null,
    activeTool: "background",
    exportOpen: false,
};

export function clipDuration(clip: EditorClip): number {
    return editorClipDurationUs(clip) / 1_000_000;
}

export function projectDuration(project: EditorProject): number {
    return projectDurationUs(project) / 1_000_000;
}

export type TrimSide = "start" | "end";

export function trimRangeForDrag(
    clip: Pick<EditorClip, "sourceStart" | "sourceEnd" | "speed">,
    side: TrimSide,
    startX: number,
    clientX: number,
    trackWidth: number,
    timelineDuration: number,
): Pick<EditorClip, "sourceStart" | "sourceEnd"> {
    if (![clip.sourceStart, clip.sourceEnd, clip.speed, startX, clientX, trackWidth, timelineDuration].every(Number.isFinite) || trackWidth <= 0) {
        return { sourceStart: clip.sourceStart, sourceEnd: clip.sourceEnd };
    }
    const timelineDelta = (clientX - startX) / trackWidth * timelineDuration;
    const sourceDelta = timelineDelta * clip.speed;
    return side === "start"
        ? { sourceStart: clip.sourceStart + sourceDelta, sourceEnd: clip.sourceEnd }
        : { sourceStart: clip.sourceStart, sourceEnd: clip.sourceEnd + sourceDelta };
}

function clampPlayhead(project: EditorProject, time: number): number {
    return Math.max(0, Math.min(time, projectDuration(project)));
}

function commitProject(
    state: EditorState,
    project: EditorProject,
    selectedClipId = state.selectedClipId,
    selectedAudioClipId = state.selectedAudioClipId,
): EditorState {
    const zoomPrepared = fitZoomSegmentsToDuration(project);
    const durationUs = projectDurationUs(zoomPrepared);
    const prepared = zoomPrepared.audio === undefined || zoomPrepared.audio.durationUs === durationUs
        ? zoomPrepared
        : { ...zoomPrepared, audio: reconcileAudioTimeline(zoomPrepared.audio, durationUs) };
    const previewing = state.continuousEditStart !== null;
    return {
        ...state,
        project: prepared,
        history: previewing ? state.history : [...state.history.slice(-39), state.project],
        future: previewing ? state.future : [],
        selectedClipId,
        selectedZoomId: prepared.zoomSegments.some((segment) => segment.id === state.selectedZoomId)
            ? state.selectedZoomId
            : null,
        selectedCaptionId: prepared.overlays.captions.some((cue) => cue.id === state.selectedCaptionId)
            ? state.selectedCaptionId
            : null,
        selectedOverlayId: prepared.overlays.overlays.some((overlay) => overlay.id === state.selectedOverlayId)
            ? state.selectedOverlayId
            : null,
        selectedAudioClipId: audioClipExists(prepared.audio, selectedAudioClipId)
            ? selectedAudioClipId
            : firstAudioClipId(prepared.audio),
        playhead: clampPlayhead(prepared, state.playhead),
        playing: false,
    };
}

function updateProject(state: EditorState, change: Partial<EditorProject>): EditorState {
    return commitProject(state, { ...state.project, ...change });
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
    switch (action.type) {
        case "LOAD_PROJECT":
            return {
                ...state,
                project: action.project,
                continuousEditStart: null,
                history: [],
                future: [],
                playhead: 0,
                playing: false,
                selectedClipId: action.project.clips[0]?.id ?? "",
                selectedZoomId: null,
                selectedCaptionId: null,
                selectedOverlayId: null,
                selectedAudioClipId: firstAudioClipId(action.project.audio),
                exportOpen: false,
            };
        case "SET_PLAYING":
            return {
                ...state,
                playing: projectDuration(state.project) > 0 ? action.playing : false,
                playhead: action.playing && state.playhead >= projectDuration(state.project) ? 0 : state.playhead,
            };
        case "SET_PLAYHEAD":
            return { ...state, playhead: clampPlayhead(state.project, action.time), playing: false };
        case "TICK": {
            if (!state.playing) {
                return state;
            }
            const duration = projectDuration(state.project);
            const playhead = state.playhead + action.delta;
            return playhead >= duration
                ? { ...state, playhead: duration, playing: false }
                : { ...state, playhead };
        }
        case "SELECT_CLIP":
            return { ...state, selectedClipId: action.id };
        case "SELECT_ZOOM":
            return {
                ...state,
                selectedZoomId: action.id !== null && state.project.zoomSegments.some((segment) => segment.id === action.id)
                    ? action.id
                    : null,
            };
        case "SELECT_CAPTION":
            return {
                ...state,
                selectedCaptionId: action.id !== null && state.project.overlays.captions.some((cue) => cue.id === action.id)
                    ? action.id
                    : null,
            };
        case "SELECT_OVERLAY":
            return {
                ...state,
                selectedOverlayId: action.id !== null && state.project.overlays.overlays.some((overlay) => overlay.id === action.id)
                    ? action.id
                    : null,
            };
        case "SELECT_AUDIO_CLIP":
            return {
                ...state,
                selectedAudioClipId: audioClipExists(state.project.audio, action.id) ? action.id : null,
            };
        case "EDIT_ZOOM": {
            const zoomSegments = reduceZoomSegments(
                state.project.zoomSegments,
                action.operation,
                projectDurationUs(state.project),
            );
            if (sameZoomSegments(zoomSegments, state.project.zoomSegments)) return state;
            const next = commitProject(state, { ...state.project, zoomSegments });
            if (action.operation.type === "zoom.add") {
                return { ...next, selectedZoomId: action.operation.segment.id };
            }
            if (action.operation.type === "zoom.replace") {
                const playheadUs = state.playhead * 1_000_000;
                return {
                    ...next,
                    selectedZoomId: zoomSegments.find((segment) =>
                        playheadUs >= segment.startUs && playheadUs < segment.endUs,
                    )?.id ?? zoomSegments[0]?.id ?? null,
                };
            }
            return next;
        }
        case "EDIT_OVERLAYS": {
            const overlays = canonicalizeOverlayDocument(action.document);
            const selectedCaptionId = action.selectedCaptionId === undefined
                ? state.selectedCaptionId
                : overlays.captions.some((cue) => cue.id === action.selectedCaptionId)
                    ? action.selectedCaptionId
                    : null;
            const selectedOverlayId = action.selectedOverlayId === undefined
                ? state.selectedOverlayId
                : overlays.overlays.some((overlay) => overlay.id === action.selectedOverlayId)
                    ? action.selectedOverlayId
                    : null;
            if (JSON.stringify(overlays) === JSON.stringify(state.project.overlays)) {
                return selectedCaptionId === state.selectedCaptionId && selectedOverlayId === state.selectedOverlayId
                    ? state
                    : { ...state, selectedCaptionId, selectedOverlayId };
            }
            const next = commitProject(state, { ...state.project, overlays });
            return {
                ...next,
                selectedCaptionId,
                selectedOverlayId,
            };
        }
        case "EDIT_AUDIO": {
            const selectedAudioClipId = action.selectedAudioClipId === undefined
                ? state.selectedAudioClipId
                : action.selectedAudioClipId;
            if (sameAudioTimeline(action.timeline, state.project.audio)) {
                const selection = audioClipExists(action.timeline, selectedAudioClipId)
                    ? selectedAudioClipId
                    : firstAudioClipId(action.timeline);
                return selection === state.selectedAudioClipId ? state : { ...state, selectedAudioClipId: selection };
            }
            return commitProject(
                state,
                projectWithAudio(state.project, action.timeline),
                state.selectedClipId,
                selectedAudioClipId,
            );
        }
        case "BEGIN_CONTINUOUS_EDIT":
            return state.continuousEditStart === null
                ? { ...state, continuousEditStart: state.project, playing: false }
                : state;
        case "COMMIT_CONTINUOUS_EDIT": {
            const before = state.continuousEditStart;
            if (before === null) return state;
            if (projectDocument(before) === projectDocument(state.project)) {
                return { ...state, project: before, continuousEditStart: null, playing: false };
            }
            return {
                ...state,
                continuousEditStart: null,
                history: [...state.history.slice(-39), before],
                future: [],
                playing: false,
            };
        }
        case "CANCEL_CONTINUOUS_EDIT": {
            const project = state.continuousEditStart;
            if (project === null) return state;
            return {
                ...state,
                project,
                continuousEditStart: null,
                playhead: clampPlayhead(project, state.playhead),
                selectedClipId: project.clips.some((clip) => clip.id === state.selectedClipId)
                    ? state.selectedClipId
                    : project.clips[0]?.id ?? "",
                selectedZoomId: project.zoomSegments.some((segment) => segment.id === state.selectedZoomId)
                    ? state.selectedZoomId
                    : null,
                selectedCaptionId: project.overlays.captions.some((cue) => cue.id === state.selectedCaptionId)
                    ? state.selectedCaptionId
                    : null,
                selectedOverlayId: project.overlays.overlays.some((overlay) => overlay.id === state.selectedOverlayId)
                    ? state.selectedOverlayId
                    : null,
                selectedAudioClipId: audioClipExists(project.audio, state.selectedAudioClipId)
                    ? state.selectedAudioClipId
                    : firstAudioClipId(project.audio),
                playing: false,
            };
        }
        case "SET_TOOL": {
            const selectedZoomId = action.tool !== "zoom" || state.selectedZoomId !== null
                ? state.selectedZoomId
                : state.project.zoomSegments.find((segment) =>
                    state.playhead * 1_000_000 >= segment.startUs && state.playhead * 1_000_000 < segment.endUs,
                )?.id ?? state.project.zoomSegments[0]?.id ?? null;
            const selectedCaptionId = action.tool !== "captions" || state.selectedCaptionId !== null
                ? state.selectedCaptionId
                : state.project.overlays.captions.find((cue) =>
                    state.playhead * 1_000_000 >= cue.startUs && state.playhead * 1_000_000 < cue.endUs,
                )?.id ?? state.project.overlays.captions[0]?.id ?? null;
            const redactions = state.project.overlays.overlays.filter(isSafeRedaction);
            const currentOverlayIsSafe = redactions.some((overlay) => overlay.id === state.selectedOverlayId);
            const selectedOverlayId = action.tool !== "annotations"
                ? state.selectedOverlayId
                : currentOverlayIsSafe
                    ? state.selectedOverlayId
                    : redactions.find((overlay) =>
                    state.playhead * 1_000_000 >= overlay.startUs && state.playhead * 1_000_000 < overlay.endUs,
                )?.id ?? redactions[0]?.id ?? null;
            const selectedAudioClipId = action.tool !== "audio" || state.selectedAudioClipId !== null
                ? state.selectedAudioClipId
                : activeAudioClipId(state.project.audio, Math.round(state.playhead * 1_000_000))
                    ?? firstAudioClipId(state.project.audio);
            return { ...state, activeTool: action.tool, selectedZoomId, selectedCaptionId, selectedOverlayId, selectedAudioClipId };
        }
        case "SPLIT": {
            if (state.activeTool === "audio") {
                if (state.project.audio === undefined || state.selectedAudioClipId === null) return state;
                const found = findAudioClip(state.project.audio, state.selectedAudioClipId);
                if (found === undefined) return state;
                try {
                    const split = splitSelectedAudioClip(
                        state.project.audio,
                        { laneId: found.lane.id, clipId: found.clip.id },
                        Math.round(state.playhead * 1_000_000),
                    );
                    return commitProject(
                        state,
                        { ...state.project, audio: split.timeline },
                        state.selectedClipId,
                        split.rightClipId,
                    );
                } catch {
                    return state;
                }
            }
            let cursor = 0;
            for (const clip of state.project.clips) {
                const duration = clipDuration(clip);
                const localTime = state.playhead - cursor;
                if (localTime > 0.15 && localTime < duration - 0.15) {
                    const sourcePoint = durationNeutralSplitSourcePoint(clip, localTime);
                    if (sourcePoint === undefined) return state;
                    const left: EditorClip = { ...clip, sourceEnd: sourcePoint };
                    const right: EditorClip = { ...clip, id: uniqueItemId(state.project.clips, "clip"), sourceStart: sourcePoint, name: `${clip.name} B` };
                    const clips = state.project.clips.flatMap((item) => item.id === clip.id ? [left, right] : [item]);
                    return commitProject(state, { ...state.project, clips }, right.id);
                }
                cursor += duration;
            }
            return state;
        }
        case "REMOVE_SELECTED": {
            if (state.activeTool === "annotations") {
                if (state.selectedOverlayId === null) return state;
                const index = state.project.overlays.overlays.findIndex((overlay) => overlay.id === state.selectedOverlayId);
                if (index < 0) return state;
                const overlays = state.project.overlays.overlays.filter((overlay) => overlay.id !== state.selectedOverlayId);
                const next = commitProject(state, {
                    ...state.project,
                    overlays: canonicalizeOverlayDocument({ ...state.project.overlays, overlays }),
                });
                return {
                    ...next,
                    selectedOverlayId: overlays[Math.min(index, overlays.length - 1)]?.id ?? null,
                };
            }
            if (state.activeTool === "audio") {
                if (state.project.audio === undefined || state.selectedAudioClipId === null) return state;
                const clipIds = audioClipIds(state.project.audio);
                const index = clipIds.indexOf(state.selectedAudioClipId);
                if (index < 0) return state;
                try {
                    const audio = removeAudioClip(state.project.audio, state.selectedAudioClipId);
                    const remaining = audioClipIds(audio);
                    const selection = remaining[Math.max(0, Math.min(index, remaining.length - 1))] ?? null;
                    return commitProject(
                        state,
                        { ...state.project, audio },
                        state.selectedClipId,
                        selection,
                    );
                } catch {
                    return state;
                }
            }
            if (state.project.clips.length <= 1) {
                return state;
            }
            const index = state.project.clips.findIndex((clip) => clip.id === state.selectedClipId);
            const clips = state.project.clips.filter((clip) => clip.id !== state.selectedClipId);
            const fallback = clips[Math.max(0, Math.min(index, clips.length - 1))];
            return commitProject(
                state,
                remapProjectTimedTracks(state.project, { ...state.project, clips }),
                fallback?.id ?? "",
            );
        }
        case "SET_SPEED": {
            const selected = state.project.clips.find((clip) => clip.id === state.selectedClipId);
            if (selected === undefined || selected.speed === action.speed) return state;
            const clips = state.project.clips.map((clip) => clip.id === state.selectedClipId ? { ...clip, speed: action.speed } : clip);
            return commitProject(state, remapProjectTimedTracks(state.project, { ...state.project, clips }));
        }
        case "TRIM_CLIP": {
            const edited = trimProject(state.project, action.id, action.sourceStart, action.sourceEnd);
            return edited === state.project
                ? state
                : commitProject(state, remapProjectTimedTracks(state.project, edited), action.id);
        }
        case "COMMIT_TRIM_CLIP": {
            if (state.project !== action.before) return state;
            const edited = trimProject(action.before, action.id, action.sourceStart, action.sourceEnd, action.side);
            if (edited === action.before) {
                return {
                    ...state,
                    project: action.before,
                    selectedClipId: action.id,
                    playhead: clampPlayhead(action.before, state.playhead),
                    playing: false,
                };
            }
            const project = remapProjectTimedTracks(action.before, edited);
            return commitProject({ ...state, project: action.before }, project, action.id);
        }
        case "SET_BACKGROUND":
            return updateProject(state, { backgroundId: action.id });
        case "SET_ASPECT":
            return updateProject(state, { aspectRatio: action.value });
        case "SET_PADDING":
            return updateProject(state, { padding: action.value });
        case "SET_CORNER_RADIUS":
            return updateProject(state, { cornerRadius: action.value });
        case "SET_SHADOW":
            return updateProject(state, { shadow: action.value });
        case "SET_FIT_MODE": {
            if (state.project.fitMode === action.value && state.project.crop === undefined) return state;
            const { crop: _crop, ...project } = state.project;
            return commitProject(state, { ...project, fitMode: action.value });
        }
        case "SET_SCREEN_TRANSFORM": {
            const { patch } = action;
            const cropChanged = patch.crop !== undefined && !sameCrop(patch.crop, state.project.crop);
            const fitMode = patch.crop === undefined
                ? state.project.fitMode
                : isFullCrop(patch.crop) ? "fit" : "fill";
            if ((patch.scale === undefined || patch.scale === state.project.scale)
                && (patch.offsetX === undefined || patch.offsetX === state.project.offsetX)
                && (patch.offsetY === undefined || patch.offsetY === state.project.offsetY)
                && fitMode === state.project.fitMode
                && !cropChanged) return state;
            return commitProject(state, {
                ...state.project,
                fitMode,
                ...(patch.scale === undefined ? {} : { scale: patch.scale }),
                ...(patch.offsetX === undefined ? {} : { offsetX: patch.offsetX }),
                ...(patch.offsetY === undefined ? {} : { offsetY: patch.offsetY }),
                ...(patch.crop === undefined ? {} : { crop: { ...patch.crop } }),
            });
        }
        case "SET_SCALE":
            return updateProject(state, { scale: action.value });
        case "SET_OFFSET_X":
            return updateProject(state, { offsetX: action.value });
        case "SET_OFFSET_Y":
            return updateProject(state, { offsetY: action.value });
        case "SET_SYSTEM_VOLUME":
            return updateProject(state, { systemVolume: action.value });
        case "SET_MICROPHONE_VOLUME":
            return updateProject(state, { microphoneVolume: action.value });
        case "UNDO": {
            const project = state.history[state.history.length - 1];
            if (!project) {
                return state;
            }
            return {
                ...state,
                project,
                continuousEditStart: null,
                history: state.history.slice(0, -1),
                future: [state.project, ...state.future.slice(0, 39)],
                playhead: clampPlayhead(project, state.playhead),
                selectedClipId: project.clips.some((clip) => clip.id === state.selectedClipId)
                    ? state.selectedClipId
                    : project.clips[0]?.id ?? "",
                selectedZoomId: project.zoomSegments.some((segment) => segment.id === state.selectedZoomId)
                    ? state.selectedZoomId
                    : null,
                selectedCaptionId: project.overlays.captions.some((cue) => cue.id === state.selectedCaptionId)
                    ? state.selectedCaptionId
                    : null,
                selectedOverlayId: project.overlays.overlays.some((overlay) => overlay.id === state.selectedOverlayId)
                    ? state.selectedOverlayId
                    : null,
                selectedAudioClipId: audioClipExists(project.audio, state.selectedAudioClipId)
                    ? state.selectedAudioClipId
                    : firstAudioClipId(project.audio),
                playing: false,
            };
        }
        case "REDO": {
            const project = state.future[0];
            if (!project) {
                return state;
            }
            return {
                ...state,
                project,
                continuousEditStart: null,
                history: [...state.history.slice(-39), state.project],
                future: state.future.slice(1),
                playhead: clampPlayhead(project, state.playhead),
                selectedClipId: project.clips.some((clip) => clip.id === state.selectedClipId)
                    ? state.selectedClipId
                    : project.clips[0]?.id ?? "",
                selectedZoomId: project.zoomSegments.some((segment) => segment.id === state.selectedZoomId)
                    ? state.selectedZoomId
                    : null,
                selectedCaptionId: project.overlays.captions.some((cue) => cue.id === state.selectedCaptionId)
                    ? state.selectedCaptionId
                    : null,
                selectedOverlayId: project.overlays.overlays.some((overlay) => overlay.id === state.selectedOverlayId)
                    ? state.selectedOverlayId
                    : null,
                selectedAudioClipId: audioClipExists(project.audio, state.selectedAudioClipId)
                    ? state.selectedAudioClipId
                    : firstAudioClipId(project.audio),
                playing: false,
            };
        }
        case "OPEN_EXPORT":
            return { ...state, exportOpen: true, playing: false };
        case "CLOSE_EXPORT":
            return { ...state, exportOpen: false };
        default:
            return state;
    }
}

function trimProject(project: EditorProject, id: string, requestedStart: number, requestedEnd: number, side?: TrimSide): EditorProject {
    const clip = project.clips.find((item) => item.id === id);
    if (!clip || !Number.isFinite(requestedStart) || !Number.isFinite(requestedEnd)) return project;

    const sourceDuration = Math.max(0, project.sourceDuration);
    const minimumDuration = Math.min(0.25, sourceDuration);
    let sourceStart: number;
    let sourceEnd: number;

    if (side === "start" || (side === undefined && requestedEnd === clip.sourceEnd)) {
        sourceEnd = clamp(requestedEnd, minimumDuration, sourceDuration);
        sourceStart = clamp(requestedStart, 0, sourceEnd - minimumDuration);
    } else {
        sourceStart = clamp(requestedStart, 0, sourceDuration - minimumDuration);
        sourceEnd = clamp(requestedEnd, sourceStart + minimumDuration, sourceDuration);
    }

    if (sourceStart === clip.sourceStart && sourceEnd === clip.sourceEnd) return project;
    return {
        ...project,
        clips: project.clips.map((item) => item.id === id ? { ...item, sourceStart, sourceEnd } : item),
    };
}

function fitZoomSegmentsToDuration(project: EditorProject): EditorProject {
    const durationUs = projectDurationUs(project);
    let changed = false;
    const zoomSegments = project.zoomSegments.flatMap((segment) => {
        if (segment.startUs >= durationUs) {
            changed = true;
            return [];
        }
        const endUs = Math.min(segment.endUs, durationUs);
        if (endUs === segment.endUs) return [segment];
        changed = true;
        const segmentDurationUs = endUs - segment.startUs;
        const easeInUs = Math.min(segment.easeInUs, segmentDurationUs);
        const easeOutUs = Math.min(segment.easeOutUs, segmentDurationUs - easeInUs);
        return [{ ...segment, endUs, easeInUs, easeOutUs }];
    });
    return changed ? { ...project, zoomSegments } : project;
}

function remapProjectTimedTracks(before: EditorProject, after: EditorProject): EditorProject {
    const transform = outputTimelineTransformForClips(before.clips, after.clips);
    return {
        ...after,
        zoomSegments: remapZoomSegments(before.zoomSegments, transform),
        overlays: remapOverlayDocument(before.overlays, transform),
    };
}

function projectWithAudio(project: EditorProject, audio: AudioTimeline | undefined): EditorProject {
    if (audio !== undefined) return { ...project, audio };
    const { audio: _audio, ...withoutAudio } = project;
    return withoutAudio;
}

export function projectDurationUs(project: EditorProject): number {
    return project.clips.reduce((total, clip) => total + editorClipDurationUs(clip), 0);
}

function editorClipDurationUs(clip: Pick<EditorClip, "sourceStart" | "sourceEnd" | "speed">): number {
    const sourceStartUs = Math.round(clip.sourceStart * 1_000_000);
    const sourceEndUs = Math.round(clip.sourceEnd * 1_000_000);
    return Math.max(1, Math.round((sourceEndUs - sourceStartUs) / clip.speed));
}

function durationNeutralSplitSourcePoint(clip: EditorClip, localTime: number): number | undefined {
    const sourceStartUs = Math.round(clip.sourceStart * 1_000_000);
    const sourceEndUs = Math.round(clip.sourceEnd * 1_000_000);
    const parentDurationUs = editorClipDurationUs(clip);
    const requestedSourceUs = Math.max(
        sourceStartUs + 1,
        Math.min(sourceEndUs - 1, sourceStartUs + Math.round(localTime * 1_000_000 * clip.speed)),
    );
    const searchRadiusUs = Math.ceil(clip.speed * 8) + 8;
    for (let distanceUs = 0; distanceUs <= searchRadiusUs; distanceUs += 1) {
        const candidates = distanceUs === 0
            ? [requestedSourceUs]
            : [requestedSourceUs - distanceUs, requestedSourceUs + distanceUs];
        for (const candidateUs of candidates) {
            if (candidateUs <= sourceStartUs || candidateUs >= sourceEndUs) continue;
            const leftDurationUs = Math.max(1, Math.round((candidateUs - sourceStartUs) / clip.speed));
            const rightDurationUs = Math.max(1, Math.round((sourceEndUs - candidateUs) / clip.speed));
            if (leftDurationUs + rightDurationUs === parentDurationUs) return candidateUs / 1_000_000;
        }
    }
    return undefined;
}

function audioClipIds(audio: AudioTimeline | undefined): string[] {
    return audio?.lanes
        .filter((lane) => lane.kind === "music")
        .flatMap((lane) => lane.clips.map((clip) => clip.id)) ?? [];
}

function firstAudioClipId(audio: AudioTimeline | undefined): string | null {
    return audioClipIds(audio)[0] ?? null;
}

function audioClipExists(audio: AudioTimeline | undefined, clipId: string | null): clipId is string {
    return clipId !== null && audioClipIds(audio).includes(clipId);
}

function activeAudioClipId(audio: AudioTimeline | undefined, playheadUs: number): string | undefined {
    if (audio === undefined) return undefined;
    for (const lane of audio.lanes) {
        if (lane.kind !== "music") continue;
        const clip = lane.clips.find((candidate) =>
            playheadUs >= candidate.timelineStartUs && playheadUs < clipTimelineEndUs(candidate));
        if (clip !== undefined) return clip.id;
    }
    return undefined;
}

function sameAudioTimeline(left: AudioTimeline | undefined, right: AudioTimeline | undefined): boolean {
    return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(value, maximum));
}

function sameCrop(left: EditorProject["crop"], right: EditorProject["crop"]): boolean {
    return left === right || (left !== undefined && right !== undefined
        && left.x === right.x
        && left.y === right.y
        && left.width === right.width
        && left.height === right.height);
}

function sameZoomSegments(left: EditorProject["zoomSegments"], right: EditorProject["zoomSegments"]): boolean {
    return left.length === right.length && left.every((segment, index) => {
        const candidate = right[index];
        return candidate !== undefined
            && segment.id === candidate.id
            && segment.startUs === candidate.startUs
            && segment.endUs === candidate.endUs
            && segment.focus.x === candidate.focus.x
            && segment.focus.y === candidate.focus.y
            && segment.scale === candidate.scale
            && segment.easeInUs === candidate.easeInUs
            && segment.easeOutUs === candidate.easeOutUs
            && segment.source === candidate.source;
    });
}

export function formatTime(time: number, withFrames = false): string {
    const safeTime = Math.max(0, time);
    const minutes = Math.floor(safeTime / 60);
    const seconds = Math.floor(safeTime % 60);
    if (!withFrames) {
        return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }
    const frames = Math.floor((safeTime % 1) * 60);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
}
