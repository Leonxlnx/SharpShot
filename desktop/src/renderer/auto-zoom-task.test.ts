import { describe, expect, it, vi } from "vitest";
import type { ZoomSegment } from "../shared/cursor-zoom";
import {
    applyAutoZoomTaskResult,
    autoZoomTaskIsCurrent,
    type AutoZoomCurrent,
    type AutoZoomTask,
} from "./components/EditorInspector";
import { editorReducer, INITIAL_EDITOR_STATE, projectDurationUs, type EditorAction } from "./state";
import type { EditorState } from "./types";

const GENERATED_ZOOM: ZoomSegment = {
    id: "generated",
    startUs: 20_000_000,
    endUs: 21_000_000,
    focus: { x: 0.5, y: 0.5 },
    scale: 2,
    easeInUs: 100_000,
    easeOutUs: 100_000,
    source: "auto",
};

function task(state: EditorState): AutoZoomTask {
    return { generation: 4, project: state.project, projectId: "project-a", mediaId: "media-a" };
}

function current(state: EditorState): AutoZoomCurrent {
    return {
        generation: 4,
        state,
        projectId: "project-a",
        mediaId: "media-a",
        mutationsLocked: false,
    };
}

describe("auto-zoom async task guard", () => {
    it("applies a result only to the unchanged project snapshot", () => {
        let state: EditorState = structuredClone(INITIAL_EDITOR_STATE);
        const request = task(state);
        const dispatch = (action: EditorAction) => {
            state = editorReducer(state, action);
            return true;
        };

        expect(applyAutoZoomTaskResult(request, current(state), [GENERATED_ZOOM], dispatch)).toBe(true);
        expect(state.project.zoomSegments).toEqual([GENERATED_ZOOM]);
    });

    it("ignores a stale result after a trim shortens the project instead of reaching the throwing reducer", () => {
        let state: EditorState = structuredClone(INITIAL_EDITOR_STATE);
        state = editorReducer(state, {
            type: "EDIT_ZOOM",
            operation: { type: "zoom.replace", segments: [{ ...GENERATED_ZOOM, id: "prior", startUs: 1_000_000, endUs: 2_000_000 }] },
        });
        const request = task(state);
        state = editorReducer(state, {
            type: "TRIM_CLIP",
            id: state.project.clips[0]!.id,
            sourceStart: 0,
            sourceEnd: 1,
        });
        const zoomsAfterTrim = state.project.zoomSegments;
        const dispatch = vi.fn((action: EditorAction) => {
            state = editorReducer(state, action);
            return true;
        });

        expect(projectDurationUs(state.project)).toBeLessThan(GENERATED_ZOOM.endUs);
        expect(() => applyAutoZoomTaskResult(request, current(state), [GENERATED_ZOOM], dispatch)).not.toThrow();
        expect(dispatch).not.toHaveBeenCalled();
        expect(state.project.zoomSegments).toBe(zoomsAfterTrim);
    });

    it("ignores a stale result after a duration-neutral split", () => {
        let state: EditorState = { ...structuredClone(INITIAL_EDITOR_STATE), playhead: 1 };
        const request = task(state);
        const durationBefore = projectDurationUs(state.project);
        state = editorReducer(state, { type: "SPLIT" });
        const dispatch = vi.fn(() => true);

        expect(projectDurationUs(state.project)).toBe(durationBefore);
        expect(state.project).not.toBe(request.project);
        expect(applyAutoZoomTaskResult(request, current(state), [{ ...GENERATED_ZOOM, startUs: 1_000_000, endUs: 2_000_000 }], dispatch)).toBe(false);
        expect(dispatch).not.toHaveBeenCalled();
    });

    it("rejects project/media switches and continuous, export, or locked mutation phases", () => {
        const state: EditorState = structuredClone(INITIAL_EDITOR_STATE);
        const request = task(state);
        const baseline = current(state);

        expect(autoZoomTaskIsCurrent(request, baseline)).toBe(true);
        expect(autoZoomTaskIsCurrent(request, { ...baseline, projectId: "project-b" })).toBe(false);
        expect(autoZoomTaskIsCurrent(request, { ...baseline, mediaId: "media-b" })).toBe(false);
        expect(autoZoomTaskIsCurrent(request, { ...baseline, state: { ...state, continuousEditStart: state.project } })).toBe(false);
        expect(autoZoomTaskIsCurrent(request, { ...baseline, state: { ...state, exportOpen: true } })).toBe(false);
        expect(autoZoomTaskIsCurrent(request, { ...baseline, mutationsLocked: true })).toBe(false);
    });
});
