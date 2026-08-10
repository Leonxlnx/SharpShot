import { describe, expect, it } from "vitest";
import { createEmptyProjectAudio } from "../shared/project-audio";
import { editorReducer, INITIAL_EDITOR_STATE } from "./state";

describe("continuous editor gestures", () => {
    it("previews many state-backed slider values but commits one undo snapshot", () => {
        const initial = structuredClone(INITIAL_EDITOR_STATE);
        const before = initial.project;
        before.zoomSegments = [{
            id: "zoom-slider",
            startUs: 1_000_000,
            endUs: 3_000_000,
            focus: { x: .5, y: .5 },
            scale: 2,
            easeInUs: 200_000,
            easeOutUs: 200_000,
            source: "manual",
        }];
        let state = editorReducer(initial, { type: "BEGIN_CONTINUOUS_EDIT" });

        for (let value = 20; value < 70; value += 1) {
            state = editorReducer(state, { type: "SET_PADDING", value });
            state = editorReducer(state, { type: "SET_SCALE", value: 100 + value });
            state = editorReducer(state, { type: "SET_SYSTEM_VOLUME", value });
            state = editorReducer(state, {
                type: "EDIT_ZOOM",
                operation: { type: "zoom.update", id: "zoom-slider", changes: { scale: 1 + value / 100 } },
            });
        }

        expect(state.continuousEditStart).toBe(before);
        expect(state.history).toHaveLength(0);
        expect(state.project).toMatchObject({ padding: 69, scale: 169, systemVolume: 69 });

        const committed = editorReducer(state, { type: "COMMIT_CONTINUOUS_EDIT" });
        expect(committed.continuousEditStart).toBeNull();
        expect(committed.history).toEqual([before]);
        expect(editorReducer(committed, { type: "UNDO" }).project).toBe(before);
    });

    it("restores the exact start snapshot on cancel and skips no-op history", () => {
        const initial = structuredClone(INITIAL_EDITOR_STATE);
        const started = editorReducer(initial, { type: "BEGIN_CONTINUOUS_EDIT" });
        const changed = editorReducer(started, { type: "SET_OFFSET_X", value: 42 });
        const cancelled = editorReducer(changed, { type: "CANCEL_CONTINUOUS_EDIT" });

        expect(cancelled.project).toBe(initial.project);
        expect(cancelled.continuousEditStart).toBeNull();
        expect(cancelled.history).toHaveLength(0);

        const returned = editorReducer(
            editorReducer(
                editorReducer(cancelled, { type: "BEGIN_CONTINUOUS_EDIT" }),
                { type: "SET_OFFSET_X", value: 42 },
            ),
            { type: "SET_OFFSET_X", value: initial.project.offsetX },
        );
        const committed = editorReducer(returned, { type: "COMMIT_CONTINUOUS_EDIT" });
        expect(committed.project).toBe(initial.project);
        expect(committed.history).toHaveLength(0);
    });

    it("preserves matching audio by reference through one hundred visual drafts", () => {
        const initial = structuredClone(INITIAL_EDITOR_STATE);
        const durationUs = Math.round(initial.project.clips.reduce(
            (total, clip) => total + (clip.sourceEnd - clip.sourceStart) / clip.speed,
            0,
        ) * 1_000_000);
        const audio = createEmptyProjectAudio(durationUs);
        initial.project = { ...initial.project, audio };
        let state = editorReducer(initial, { type: "BEGIN_CONTINUOUS_EDIT" });

        for (let draft = 0; draft < 100; draft += 1) {
            state = editorReducer(state, { type: "SET_PADDING", value: draft % 97 });
            expect(state.project.audio).toBe(audio);
        }

        const committed = editorReducer(state, { type: "COMMIT_CONTINUOUS_EDIT" });
        expect(committed.project.audio).toBe(audio);
        expect(committed.history).toEqual([initial.project]);
    });
});
