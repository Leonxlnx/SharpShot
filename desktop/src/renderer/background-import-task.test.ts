import { describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../shared/api";
import {
    applyBackgroundImportTaskResult,
    backgroundImportTaskIsCurrent,
    type BackgroundImportCurrent,
    type BackgroundImportTask,
} from "./components/EditorInspector";
import { editorReducer, INITIAL_EDITOR_STATE, type EditorAction } from "./state";
import type { EditorState } from "./types";

const IMPORTED_IMAGE: MediaItem = {
    id: "background-a",
    name: "background.gif",
    kind: "image",
    origin: "import",
    mimeType: "image/gif",
    byteLength: 1_024,
    createdAt: "2026-08-10T00:00:00.000Z",
    modifiedAt: "2026-08-10T00:00:00.000Z",
    url: "sharpshot-media://background/background-a",
};

function task(state: EditorState): BackgroundImportTask {
    return {
        generation: 4,
        project: state.project,
        projectId: "project-a",
        mediaId: "media-a",
    };
}

function current(state: EditorState): BackgroundImportCurrent {
    return {
        generation: 4,
        state,
        projectId: "project-a",
        mediaId: "media-a",
        mutationsLocked: false,
    };
}

describe("background import async task guard", () => {
    it("applies an imported image only to the unchanged project and requires reducer acknowledgement", () => {
        let state: EditorState = structuredClone(INITIAL_EDITOR_STATE);
        const request = task(state);
        const dispatch = (action: EditorAction) => {
            state = editorReducer(state, action);
            return true;
        };

        expect(applyBackgroundImportTaskResult(request, current(state), IMPORTED_IMAGE, dispatch)).toBe(true);
        expect(state.project.backgroundId).toBe(IMPORTED_IMAGE.url);

        const rejectedState: EditorState = structuredClone(INITIAL_EDITOR_STATE);
        const rejectedDispatch = vi.fn(() => false);
        expect(applyBackgroundImportTaskResult(
            task(rejectedState),
            current(rejectedState),
            IMPORTED_IMAGE,
            rejectedDispatch,
        )).toBe(false);
        expect(rejectedDispatch).toHaveBeenCalledOnce();
    });

    it("drops a picker result after another project is loaded", () => {
        const state: EditorState = structuredClone(INITIAL_EDITOR_STATE);
        const request = task(state);
        const switched = editorReducer(state, {
            type: "LOAD_PROJECT",
            project: { ...structuredClone(state.project), name: "Another project" },
        });
        const dispatch = vi.fn(() => true);

        expect(applyBackgroundImportTaskResult(request, current(switched), IMPORTED_IMAGE, dispatch)).toBe(false);
        expect(dispatch).not.toHaveBeenCalled();
        expect(switched.project.backgroundId).not.toBe(IMPORTED_IMAGE.url);
    });

    it("rejects stale generations, project/media switches, and mutation-sensitive phases", () => {
        const state: EditorState = structuredClone(INITIAL_EDITOR_STATE);
        const request = task(state);
        const baseline = current(state);

        expect(backgroundImportTaskIsCurrent(request, baseline)).toBe(true);
        expect(backgroundImportTaskIsCurrent(request, { ...baseline, generation: 5 })).toBe(false);
        expect(backgroundImportTaskIsCurrent(request, { ...baseline, projectId: "project-b" })).toBe(false);
        expect(backgroundImportTaskIsCurrent(request, { ...baseline, mediaId: "media-b" })).toBe(false);
        expect(backgroundImportTaskIsCurrent(request, { ...baseline, state: { ...state, continuousEditStart: state.project } })).toBe(false);
        expect(backgroundImportTaskIsCurrent(request, { ...baseline, state: { ...state, exportOpen: true } })).toBe(false);
        expect(backgroundImportTaskIsCurrent(request, { ...baseline, mutationsLocked: true })).toBe(false);
    });
});
