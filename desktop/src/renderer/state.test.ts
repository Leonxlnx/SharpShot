import { describe, expect, it } from "vitest";
import { appReducer, editorReducer, INITIAL_EDITOR_STATE, projectDuration, projectDurationUs, trimRangeForDrag, type AppState } from "./state";
import type { EditorState, Workflow } from "./types";
import { createEmptyOverlayDocument } from "../shared/overlays";
import type { AudioAsset } from "../shared/audio-timeline";
import { applySelectedAudioEdit, insertMusicClip } from "./audio-editor";

function workflow(id: string): Workflow {
    return {
        id,
        name: id,
        description: "Test workflow",
        kind: "video",
        target: "Region",
        shortcuts: [],
        enabled: true,
        fps: 60,
        quality: "High",
        cursor: true,
        systemAudio: false,
        microphone: false,
        countdown: 3,
        after: ["Save to Library"],
    };
}

function stateWith(workflows: Workflow[]): AppState {
    return {
        route: "workflows",
        previousRoute: "home",
        workflows,
        selectedWorkflowId: workflows[0]?.id ?? "",
        selectedCaptureId: null,
        toast: null,
    };
}

describe("workflow ids", () => {
    it("fills a free id instead of colliding after a deletion", () => {
        const state = stateWith([workflow("workflow-1"), workflow("workflow-3")]);
        const next = appReducer(state, { type: "CREATE_WORKFLOW", kind: "video" });
        expect(next.workflows.map((item) => item.id)).toEqual(["workflow-1", "workflow-3", "workflow-2"]);
        expect(new Set(next.workflows.map((item) => item.id)).size).toBe(next.workflows.length);
    });

    it("keeps duplicate ids unique when prior copies already exist", () => {
        const state = stateWith([workflow("video"), workflow("video-copy-1")]);
        const next = appReducer(state, { type: "DUPLICATE_WORKFLOW", id: "video" });
        expect(next.workflows.at(-1)?.id).toBe("video-copy-2");
        expect(new Set(next.workflows.map((item) => item.id)).size).toBe(next.workflows.length);
    });
});

describe("screen transform history", () => {
    function editorState(): EditorState {
        return structuredClone(INITIAL_EDITOR_STATE);
    }

    it("commits a direct-manipulation transform as one undo entry", () => {
        const state = { ...editorState(), playing: true };
        const crop = { x: 0.12, y: 0.08, width: 0.7, height: 0.82 };
        const next = editorReducer(state, {
            type: "SET_SCREEN_TRANSFORM",
            patch: { scale: 128, offsetX: -18, offsetY: 23, crop },
        });

        expect(next.project).toMatchObject({ fitMode: "fill", scale: 128, offsetX: -18, offsetY: 23, crop });
        expect(next.project.crop).not.toBe(crop);
        expect(next.history).toHaveLength(1);
        expect(next.history[0]).toBe(state.project);
        expect(next.playing).toBe(false);

        const undone = editorReducer(next, { type: "UNDO" });
        expect(undone.project).toBe(state.project);
        expect(undone.future).toHaveLength(1);
    });

    it("does not create history for an unchanged transform", () => {
        const state = editorState();
        const next = editorReducer(state, {
            type: "SET_SCREEN_TRANSFORM",
            patch: { scale: state.project.scale, offsetX: state.project.offsetX },
        });
        expect(next).toBe(state);
    });

    it("clears a custom crop when Fit or Fill is chosen", () => {
        const state = editorState();
        state.project = {
            ...state.project,
            fitMode: "fill",
            crop: { x: 0.1, y: 0.2, width: 0.75, height: 0.7 },
        };
        const next = editorReducer(state, { type: "SET_FIT_MODE", value: "fill" });

        expect(next.project.crop).toBeUndefined();
        expect(next.history).toHaveLength(1);
        expect(editorReducer(next, { type: "UNDO" }).project.crop).toEqual(state.project.crop);
    });
});

describe("zoom edit history", () => {
    function editorState(): EditorState {
        return structuredClone(INITIAL_EDITOR_STATE);
    }

    it("adds, updates, deletes, and restores canonical zoom snapshots", () => {
        const state = editorState();
        const segment = {
            id: "manual-zoom-1",
            startUs: 1_000_000,
            endUs: 3_000_000,
            focus: { x: 0.7, y: 0.3 },
            scale: 2,
            easeInUs: 180_000,
            easeOutUs: 220_000,
            source: "manual" as const,
        };
        const added = editorReducer(state, { type: "EDIT_ZOOM", operation: { type: "zoom.add", segment } });
        expect(added.project.zoomSegments).toEqual([segment]);
        expect(added.project.zoomSegments[0]).not.toBe(segment);
        expect(added.project.zoomSegments[0]?.focus).not.toBe(segment.focus);
        expect(added.selectedZoomId).toBe(segment.id);
        expect(added.history).toEqual([state.project]);

        const updated = editorReducer(added, {
            type: "EDIT_ZOOM",
            operation: { type: "zoom.update", id: segment.id, changes: { scale: 2.5, focus: { x: 0.4, y: 0.6 } } },
        });
        expect(updated.project.zoomSegments[0]).toMatchObject({ scale: 2.5, focus: { x: 0.4, y: 0.6 } });
        expect(editorReducer(updated, {
            type: "EDIT_ZOOM",
            operation: { type: "zoom.update", id: segment.id, changes: { scale: 2.5 } },
        })).toBe(updated);

        const deleted = editorReducer(updated, {
            type: "EDIT_ZOOM",
            operation: { type: "zoom.delete", id: segment.id },
        });
        expect(deleted.project.zoomSegments).toEqual([]);
        expect(deleted.selectedZoomId).toBeNull();
        expect(editorReducer(deleted, { type: "UNDO" }).project.zoomSegments).toEqual(updated.project.zoomSegments);
        expect(editorReducer(added, { type: "UNDO" }).project).toBe(state.project);
    });

    it("replaces zooms from trusted click generation as one undoable edit", () => {
        const state = editorState();
        const generated = [{
            id: "auto-zoom-1",
            startUs: 2_000_000,
            endUs: 4_000_000,
            focus: { x: 0.65, y: 0.35 },
            scale: 2,
            easeInUs: 180_000,
            easeOutUs: 220_000,
            source: "auto" as const,
        }];
        const next = editorReducer(state, {
            type: "EDIT_ZOOM",
            operation: { type: "zoom.replace", segments: generated },
        });
        expect(next.project.zoomSegments).toEqual(generated);
        expect(next.selectedZoomId).toBe(generated[0]?.id);
        expect(next.history).toEqual([state.project]);
        expect(editorReducer(next, { type: "UNDO" }).project).toBe(state.project);
    });

    it.each([
        { name: "start", sourceStart: 2, sourceEnd: 4 },
        { name: "end", sourceStart: 0, sourceEnd: 2 },
    ])("shifts a later zoom when the $name of an earlier clip is trimmed", ({ sourceStart, sourceEnd }) => {
        const state = editorState();
        state.project = twoClipZoomProject(state.project);
        state.selectedClipId = "clip-a";
        const before = state.project;
        const trimmed = editorReducer(state, { type: "TRIM_CLIP", id: "clip-a", sourceStart, sourceEnd });

        expect(trimmed.project.zoomSegments[0]).toMatchObject({ startUs: 3_000_000, endUs: 5_000_000 });
        expect(trimmed.history).toEqual([before]);
    });

    it("retimes a zoom inside a speed-changed clip instead of dropping it", () => {
        const state = editorState();
        state.project = {
            ...state.project,
            sourceDuration: 4,
            clips: [{ id: "clip-a", name: "A", sourceStart: 0, sourceEnd: 4, speed: 1, color: "#7897e8" }],
            zoomSegments: [zoomSegment("inside", 1_000_000, 3_000_000)],
        };
        state.selectedClipId = "clip-a";
        const spedUp = editorReducer(state, { type: "SET_SPEED", speed: 2 });

        expect(spedUp.project.zoomSegments[0]).toMatchObject({
            startUs: 500_000,
            endUs: 1_500_000,
            easeInUs: 100_000,
            easeOutUs: 100_000,
        });
    });

    it("does not create history or clear redo when speed is unchanged", () => {
        const state = editorState();
        state.future = [structuredClone(state.project)];
        const next = editorReducer(state, { type: "SET_SPEED", speed: state.project.clips[0]!.speed });

        expect(next).toBe(state);
        expect(next.history).toHaveLength(0);
        expect(next.future).toHaveLength(1);
    });

    it("ripples a later zoom with retained content when a clip is deleted", () => {
        const state = editorState();
        state.project = twoClipZoomProject(state.project);
        state.selectedClipId = "clip-a";
        const deleted = editorReducer(state, { type: "REMOVE_SELECTED" });

        expect(deleted.project.zoomSegments[0]).toMatchObject({ startUs: 1_000_000, endUs: 3_000_000 });
    });

    it("preserves zoom timing through a duration-neutral split", () => {
        const state = editorState();
        state.project = {
            ...state.project,
            sourceDuration: 4,
            clips: [{ id: "clip-a", name: "A", sourceStart: 0, sourceEnd: 4, speed: 1, color: "#7897e8" }],
            zoomSegments: [zoomSegment("split-zoom", 1_000_000, 3_000_000)],
        };
        state.selectedClipId = "clip-a";
        state.playhead = 2;
        const split = editorReducer(state, { type: "SPLIT" });

        expect(split.project.clips).toHaveLength(2);
        expect(split.project.zoomSegments).toEqual(state.project.zoomSegments);
    });
});

function zoomSegment(id: string, startUs: number, endUs: number) {
    return {
        id,
        startUs,
        endUs,
        focus: { x: 0.5, y: 0.5 },
        scale: 2,
        easeInUs: 200_000,
        easeOutUs: 200_000,
        source: "manual" as const,
    };
}

function twoClipZoomProject(project: EditorState["project"]): EditorState["project"] {
    return {
        ...project,
        sourceDuration: 8,
        clips: [
            { id: "clip-a", name: "A", sourceStart: 0, sourceEnd: 4, speed: 1, color: "#7897e8" },
            { id: "clip-b", name: "B", sourceStart: 4, sourceEnd: 8, speed: 1, color: "#8b8fe8" },
        ],
        zoomSegments: [zoomSegment("later", 5_000_000, 7_000_000)],
    };
}

describe("caption project history and timeline edits", () => {
    function editorState(): EditorState {
        return structuredClone(INITIAL_EDITOR_STATE);
    }

    function timedDocument() {
        const document = createEmptyOverlayDocument();
        document.captions = [{
            id: "caption-later",
            startUs: 5_000_000,
            endUs: 7_000_000,
            text: "Stay with the edit",
            speaker: "Host",
            style: { preset: "boxed", overrides: { color: "#FFEEDDFF" } },
        }];
        document.overlays = [{
            id: "blur-later",
            kind: "blur-mask",
            startUs: 5_500_000,
            endUs: 6_500_000,
            opacity: 0.8,
            shape: "rectangle",
            area: { x: 0.1, y: 0.2, width: 0.3, height: 0.25 },
            blurPx: 12,
            featherPx: 4,
        }];
        return document;
    }

    it("commits the full overlay document as one undoable snapshot", () => {
        const state = editorState();
        const document = timedDocument();
        const edited = editorReducer(state, {
            type: "EDIT_OVERLAYS",
            document,
            selectedCaptionId: "caption-later",
            selectedOverlayId: "blur-later",
        });

        expect(edited.project.overlays).toEqual(document);
        expect(edited.project.overlays).not.toBe(document);
        expect(edited.selectedCaptionId).toBe("caption-later");
        expect(edited.selectedOverlayId).toBe("blur-later");
        expect(edited.history).toEqual([state.project]);

        const undone = editorReducer(edited, { type: "UNDO" });
        expect(undone.project.overlays).toEqual(state.project.overlays);
        const redone = editorReducer(undone, { type: "REDO" });
        expect(redone.project.overlays).toEqual(document);
        expect(redone.project.overlays.overlays).toEqual(document.overlays);
    });

    it("selects and removes one visual overlay without touching captions", () => {
        const state = editorState();
        state.project = { ...state.project, overlays: timedDocument() };
        state.activeTool = "annotations";
        const selected = editorReducer(state, { type: "SELECT_OVERLAY", id: "blur-later" });
        const removed = editorReducer(selected, { type: "REMOVE_SELECTED" });

        expect(selected.selectedOverlayId).toBe("blur-later");
        expect(removed.project.overlays.overlays).toEqual([]);
        expect(removed.project.overlays.captions).toEqual(state.project.overlays.captions);
        expect(removed.selectedOverlayId).toBeNull();
        expect(removed.history).toEqual([state.project]);
        expect(editorReducer(removed, { type: "UNDO" }).project.overlays).toEqual(state.project.overlays);
    });

    it("retimes captions and visual overlays through trim, speed, and ripple delete", () => {
        const base = editorState();
        base.project = { ...twoClipZoomProject(base.project), overlays: timedDocument() };
        base.selectedClipId = "clip-a";

        const trimmed = editorReducer(base, { type: "TRIM_CLIP", id: "clip-a", sourceStart: 2, sourceEnd: 4 });
        expect(trimmed.project.overlays.captions[0]).toMatchObject({ startUs: 3_000_000, endUs: 5_000_000, speaker: "Host" });
        expect(trimmed.project.overlays.overlays[0]).toMatchObject({ startUs: 3_500_000, endUs: 4_500_000, blurPx: 12 });

        const deleted = editorReducer(base, { type: "REMOVE_SELECTED" });
        expect(deleted.project.overlays.captions[0]).toMatchObject({ startUs: 1_000_000, endUs: 3_000_000 });
        expect(deleted.project.overlays.overlays[0]).toMatchObject({ startUs: 1_500_000, endUs: 2_500_000 });

        const single = editorState();
        single.project = {
            ...single.project,
            sourceDuration: 4,
            clips: [{ id: "clip-a", name: "A", sourceStart: 0, sourceEnd: 4, speed: 1, color: "#7897e8" }],
            overlays: {
                ...timedDocument(),
                captions: [{ ...timedDocument().captions[0]!, startUs: 1_000_000, endUs: 3_000_000 }],
                overlays: [],
            },
        };
        single.selectedClipId = "clip-a";
        const spedUp = editorReducer(single, { type: "SET_SPEED", speed: 2 });
        expect(spedUp.project.overlays.captions[0]).toMatchObject({ startUs: 500_000, endUs: 1_500_000 });
    });

    it("preserves caption and visual timing exactly through a duration-neutral split", () => {
        const state = editorState();
        state.project = {
            ...state.project,
            sourceDuration: 8,
            clips: [{ id: "clip-a", name: "A", sourceStart: 0, sourceEnd: 8, speed: 1, color: "#7897e8" }],
            overlays: timedDocument(),
        };
        state.selectedClipId = "clip-a";
        state.playhead = 4;
        const split = editorReducer(state, { type: "SPLIT" });
        expect(split.project.clips).toHaveLength(2);
        expect(split.project.overlays).toEqual(state.project.overlays);
    });
});

describe("music project history and timeline edits", () => {
    const musicAsset: AudioAsset = {
        id: "music-test",
        kind: "music",
        name: "Music test",
        locator: { kind: "library" },
        durationUs: 8_000_000,
        sampleRate: 48_000,
        channels: 2,
    };

    function editorState(): EditorState {
        return structuredClone(INITIAL_EDITOR_STATE);
    }

    function insertAt(state: EditorState, playheadUs = 1_000_000) {
        return insertMusicClip({
            timeline: state.project.audio,
            durationUs: Math.max(1, Math.round(projectDuration(state.project) * 1_000_000)),
            asset: musicAsset,
            playheadUs,
        });
    }

    it("commits a complete audio timeline as one undoable project snapshot", () => {
        const state = editorState();
        const inserted = insertAt(state);
        const edited = editorReducer(state, {
            type: "EDIT_AUDIO",
            timeline: inserted.timeline,
            selectedAudioClipId: inserted.selection.clipId,
        });

        expect(edited.project.audio).toEqual(inserted.timeline);
        expect(edited.selectedAudioClipId).toBe(inserted.selection.clipId);
        expect(edited.history).toEqual([state.project]);
        const undone = editorReducer(edited, { type: "UNDO" });
        expect(undone.project.audio).toBeUndefined();
        expect(undone.selectedAudioClipId).toBeNull();
        expect(editorReducer(undone, { type: "REDO" }).project.audio).toEqual(inserted.timeline);
    });

    it("coalesces continuous music level previews into one history entry", () => {
        const state = editorState();
        const inserted = insertAt(state);
        state.project = { ...state.project, audio: inserted.timeline };
        state.selectedAudioClipId = inserted.selection.clipId;
        const before = state.project;
        const begun = editorReducer(state, { type: "BEGIN_CONTINUOUS_EDIT" });
        const gained = applySelectedAudioEdit(inserted.timeline, inserted.selection, {
            type: "clip.gain",
            gainDb: -9,
        });
        const preview = editorReducer(begun, { type: "EDIT_AUDIO", timeline: gained });

        expect(preview.history).toHaveLength(0);
        expect(preview.project.audio?.lanes[1]?.clips[0]?.gainDb).toBe(-9);
        const committed = editorReducer(preview, { type: "COMMIT_CONTINUOUS_EDIT" });
        expect(committed.history).toEqual([before]);
        expect(editorReducer(committed, { type: "UNDO" }).project).toBe(before);
    });

    it("routes split and delete to the selected music clip without changing video", () => {
        const state = editorState();
        const inserted = insertAt(state, 0);
        state.project = { ...state.project, audio: inserted.timeline };
        state.activeTool = "audio";
        state.selectedAudioClipId = inserted.selection.clipId;
        state.playhead = 2;
        const originalVideo = state.project.clips;

        const split = editorReducer(state, { type: "SPLIT" });
        expect(split.project.clips).toBe(originalVideo);
        expect(split.project.audio?.lanes.find((lane) => lane.kind === "music")?.clips).toHaveLength(2);
        expect(split.selectedAudioClipId).not.toBe(inserted.selection.clipId);

        const removed = editorReducer(split, { type: "REMOVE_SELECTED" });
        expect(removed.project.clips).toBe(originalVideo);
        expect(removed.project.audio?.lanes.find((lane) => lane.kind === "music")?.clips).toHaveLength(1);
    });

    it("reconciles absolute music placement when a video edit shortens the project", () => {
        const state = editorState();
        state.project = twoClipZoomProject(state.project);
        state.selectedClipId = "clip-a";
        const inserted = insertMusicClip({
            durationUs: 8_000_000,
            asset: { ...musicAsset, durationUs: 2_000_000 },
            playheadUs: 5_000_000,
        });
        state.project = { ...state.project, audio: inserted.timeline };

        const deleted = editorReducer(state, { type: "REMOVE_SELECTED" });
        expect(deleted.project.audio?.durationUs).toBe(4_000_000);
        expect(deleted.project.audio?.lanes.find((lane) => lane.kind === "music")?.clips).toEqual([]);
        expect(deleted.project.audio?.assets).toEqual({});
    });

    it("matches canonical per-clip microsecond rounding at an audio end boundary", () => {
        const state = editorState();
        state.project = {
            ...state.project,
            sourceDuration: 0.000249,
            clips: [{
                id: "precision-clip",
                name: "Precision",
                sourceStart: 0,
                sourceEnd: 0.000249,
                speed: 2,
                color: "#7897e8",
            }],
        };
        const inserted = insertMusicClip({
            durationUs: 125,
            asset: { ...musicAsset, durationUs: 125 },
            playheadUs: 0,
        });
        state.project = { ...state.project, audio: inserted.timeline };

        expect(projectDurationUs(state.project)).toBe(125);
        const committed = editorReducer(state, { type: "SET_PADDING", value: state.project.padding + 1 });
        expect(committed.project.audio?.durationUs).toBe(125);
        expect(committed.project.audio?.lanes.find((lane) => lane.kind === "music")?.clips[0]?.sourceOutUs).toBe(125);
    });

    it.each([
        { sourceDurationUs: 1_000_002, speed: 2, playheadUs: 250_000.5 },
        { sourceDurationUs: 900_001, speed: 1.5, playheadUs: 200_001.33333333334 },
    ])("keeps audio and timed tracks duration-neutral through an odd-microsecond video split", ({
        sourceDurationUs,
        speed,
        playheadUs,
    }) => {
        const state = editorState();
        const sourceDuration = sourceDurationUs / 1_000_000;
        state.project = {
            ...state.project,
            sourceDuration,
            clips: [{
                id: "precision-split",
                name: "Precision split",
                sourceStart: 0,
                sourceEnd: sourceDuration,
                speed,
                color: "#7897e8",
            }],
        };
        const durationUs = projectDurationUs(state.project);
        const inserted = insertMusicClip({
            durationUs,
            asset: { ...musicAsset, durationUs },
            playheadUs: 0,
        });
        state.project = {
            ...state.project,
            audio: inserted.timeline,
            zoomSegments: [zoomSegment("precision-zoom", 0, durationUs)],
            overlays: {
                ...createEmptyOverlayDocument(),
                captions: [{
                    id: "precision-caption",
                    startUs: 0,
                    endUs: durationUs,
                    text: "Exact end",
                    style: { preset: "boxed", overrides: {} },
                }],
            },
        };
        state.selectedClipId = "precision-split";
        state.playhead = playheadUs / 1_000_000;
        const beforeAudio = structuredClone(state.project.audio);
        const beforeZoom = structuredClone(state.project.zoomSegments);
        const beforeOverlays = structuredClone(state.project.overlays);

        const split = editorReducer(state, { type: "SPLIT" });

        expect(split.project.clips).toHaveLength(2);
        expect(projectDurationUs(split.project)).toBe(durationUs);
        expect(split.project.audio).toEqual(beforeAudio);
        expect(split.project.zoomSegments).toEqual(beforeZoom);
        expect(split.project.overlays).toEqual(beforeOverlays);
    });
});

describe("timeline trim gestures", () => {
    function editorState(): EditorState {
        return structuredClone(INITIAL_EDITOR_STATE);
    }

    it("commits one undo entry after a component-local trim preview", () => {
        const state = editorState();
        const before = state.project;
        const clip = before.clips[0]!;
        const committed = editorReducer(state, {
            type: "COMMIT_TRIM_CLIP",
            before,
            id: clip.id,
            side: "start",
            sourceStart: 1.25,
            sourceEnd: clip.sourceEnd,
        });
        expect(committed.project.clips[0]?.sourceStart).toBe(1.25);
        expect(committed.history).toEqual([before]);
        expect(editorReducer(committed, { type: "UNDO" }).project).toBe(before);
    });

    it("does not create undo history when a gesture ends where it began", () => {
        const state = editorState();
        const before = state.project;
        const clip = before.clips[0]!;
        const committed = editorReducer(state, {
            type: "COMMIT_TRIM_CLIP",
            before,
            id: clip.id,
            side: "end",
            sourceStart: clip.sourceStart,
            sourceEnd: clip.sourceEnd,
        });

        expect(committed.project).toBe(before);
        expect(committed.history).toHaveLength(0);
    });

    it("does not overwrite an intervening project edit with a stale trim commit", () => {
        const state = editorState();
        const before = state.project;
        const changed = editorReducer(state, { type: "SET_BACKGROUND", id: "obsidian" });
        const clip = before.clips[0]!;
        const committed = editorReducer(changed, {
            type: "COMMIT_TRIM_CLIP",
            before,
            id: clip.id,
            side: "start",
            sourceStart: clip.sourceStart + 1,
            sourceEnd: clip.sourceEnd,
        });

        expect(committed).toBe(changed);
        expect(committed.project.backgroundId).toBe("obsidian");
    });

    it("rejects non-finite trim input without corrupting project history", () => {
        const state = editorState();
        const clip = state.project.clips[0]!;
        const next = editorReducer(state, {
            type: "TRIM_CLIP",
            id: clip.id,
            sourceStart: Number.NaN,
            sourceEnd: clip.sourceEnd,
        });

        expect(next).toBe(state);
        expect(next.history).toHaveLength(0);
    });

    it("keeps the opposite trim edge fixed at the minimum clip duration", () => {
        const state = editorState();
        const clip = state.project.clips[0]!;
        const endPreview = editorReducer(state, {
            type: "COMMIT_TRIM_CLIP",
            before: state.project,
            id: clip.id,
            side: "end",
            sourceStart: clip.sourceStart,
            sourceEnd: -100,
        });
        const trimmed = endPreview.project.clips[0]!;

        expect(trimmed.sourceStart).toBe(clip.sourceStart);
        expect(trimmed.sourceEnd).toBe(clip.sourceStart + 0.25);
    });

    it("converts pointer travel through timeline scale and clip speed", () => {
        const clip = { sourceStart: 2, sourceEnd: 10, speed: 2 };
        expect(trimRangeForDrag(clip, "start", 100, 110, 200, 20)).toEqual({ sourceStart: 4, sourceEnd: 10 });
        expect(trimRangeForDrag(clip, "end", 100, 90, 200, 20)).toEqual({ sourceStart: 2, sourceEnd: 8 });
        expect(trimRangeForDrag(clip, "end", 100, 200, 0, 20)).toEqual({ sourceStart: 2, sourceEnd: 10 });
        expect(trimRangeForDrag(clip, "end", 100, Number.POSITIVE_INFINITY, 200, 20)).toEqual({ sourceStart: 2, sourceEnd: 10 });
    });
});
