import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    clipTimelineEndUs,
    createAudioClip,
    createAudioLane,
    createAudioTimeline,
    type AudioTimeline,
} from "../../shared/audio-timeline";
import {
    audioTimelineForTrimCommit,
    audioTrimForClientX,
    horizontalValueForClientX,
    readHorizontalPointerBounds,
    redactionDocumentForTrimCommit,
    timelineTicks,
    type AudioTrimDrag,
    Timeline,
} from "./Timeline";
import { addSafeRedaction, resizeSafeRedactionRange } from "../safe-redaction";
import { createEmptyOverlayDocument } from "../../shared/overlays";
import { INITIAL_EDITOR_STATE } from "../state";

function timeline(): AudioTimeline {
    const clip = createAudioClip({
        id: "music-clip",
        assetId: "music-asset",
        timelineStartUs: 1_000_000,
        sourceOutUs: 4_000_000,
        fadeInUs: 3_000_000,
        fadeOutUs: 3_000_000,
    });
    return createAudioTimeline({
        durationUs: 6_000_000,
        assets: {
            "music-asset": {
                id: "music-asset",
                kind: "music",
                name: "Music",
                locator: { kind: "library" },
                durationUs: 4_000_000,
                sampleRate: 48_000,
                channels: 2,
            },
        },
        lanes: [createAudioLane({ id: "music", kind: "music", clips: [clip] })],
    });
}

function drag(before: AudioTimeline, side: "start" | "end"): AudioTrimDrag {
    const clip = before.lanes[0]!.clips[0]!;
    return {
        pointerId: 1,
        before,
        laneId: "music",
        clip,
        side,
        startX: 0,
        trackWidth: 100,
        projectDurationUs: 6_000_000,
        latest: clip,
    };
}

describe("Timeline audio trim drafts", () => {
    it("clamps the start to the current source range and clamps fades to the remaining duration", () => {
        const before = timeline();
        const outward = audioTrimForClientX(drag(before, "start"), -100);
        expect(outward).toEqual(before.lanes[0]!.clips[0]);

        const trimmed = audioTrimForClientX(drag(before, "start"), 25);
        expect(trimmed.timelineStartUs).toBe(2_500_000);
        expect(trimmed.sourceInUs).toBe(1_500_000);
        expect(clipTimelineEndUs(trimmed)).toBe(5_000_000);
        expect(trimmed.fadeInUs).toBe(2_500_000);
        expect(trimmed.fadeOutUs).toBe(2_500_000);
    });

    it("clamps the end to the current source and project timeline bounds", () => {
        const before = timeline();
        const outward = audioTrimForClientX(drag(before, "end"), 100);
        expect(outward).toEqual(before.lanes[0]!.clips[0]);

        const projectBoundedDrag = drag(before, "end");
        projectBoundedDrag.projectDurationUs = 4_000_000;
        const projectBounded = audioTrimForClientX(projectBoundedDrag, 100);
        expect(clipTimelineEndUs(projectBounded)).toBe(4_000_000);
        expect(projectBounded.sourceOutUs).toBe(3_000_000);

        const trimmed = audioTrimForClientX(drag(before, "end"), -25);
        expect(trimmed.timelineStartUs).toBe(1_000_000);
        expect(trimmed.sourceOutUs).toBe(2_500_000);
        expect(clipTimelineEndUs(trimmed)).toBe(3_500_000);
        expect(trimmed.fadeInUs).toBe(2_500_000);
        expect(trimmed.fadeOutUs).toBe(2_500_000);
    });

    it("does not build a commit for cancel, stale state, or an exact no-op", () => {
        const before = timeline();
        const original = before.lanes[0]!.clips[0]!;
        const latest = audioTrimForClientX(drag(before, "end"), -25);
        const options = { before, current: before, laneId: "music", original, latest };

        expect(audioTimelineForTrimCommit({ ...options, commit: false })).toBeUndefined();
        expect(audioTimelineForTrimCommit({ ...options, current: structuredClone(before), commit: true })).toBeUndefined();
        expect(audioTimelineForTrimCommit({ ...options, latest: original, commit: true })).toBeUndefined();
    });

    it("constructs one immutable final timeline for the target clip", () => {
        const before = timeline();
        const original = before.lanes[0]!.clips[0]!;
        const latest = audioTrimForClientX(drag(before, "start"), 25);
        const committed = audioTimelineForTrimCommit({
            before,
            current: before,
            laneId: "music",
            original,
            latest,
            commit: true,
        });

        expect(committed).toBeDefined();
        expect(committed).not.toBe(before);
        expect(committed!.lanes[0]!.clips).toEqual([latest]);
        expect(before.lanes[0]!.clips[0]).toBe(original);
        expect(original.timelineStartUs).toBe(1_000_000);
    });
});

describe("Timeline ruler density", () => {
    it("preserves two-second ticks for short recordings", () => {
        expect(timelineTicks(5)).toEqual([0, 2, 4]);
        expect(timelineTicks(10)).toEqual([0, 2, 4, 6, 8, 10]);
    });

    it("uses a bounded nice step for long recordings", () => {
        const oneHour = timelineTicks(60 * 60);
        const twelveHours = timelineTicks(12 * 60 * 60);

        expect(oneHour.length).toBeLessThanOrEqual(120);
        expect(oneHour.slice(0, 3)).toEqual([0, 50, 100]);
        expect(twelveHours.length).toBeLessThanOrEqual(120);
        expect(twelveHours.every((tick, index) => index === 0 || tick > twelveHours[index - 1]!)).toBe(true);
        expect(twelveHours.at(-1)).toBeLessThanOrEqual(12 * 60 * 60);
    });
});

describe("Timeline pointer bounds", () => {
    it("reads track geometry once and reuses it for a pointer storm", () => {
        const getBoundingClientRect = vi.fn(() => ({ left: 20, width: 200 }) as DOMRect);
        const bounds = readHorizontalPointerBounds({ getBoundingClientRect });
        const values = Array.from({ length: 100 }, (_, index) =>
            horizontalValueForClientX(20 + index * 2, bounds, 10));

        expect(getBoundingClientRect).toHaveBeenCalledTimes(1);
        expect(values[0]).toBe(0);
        expect(values.at(-1)).toBeCloseTo(9.9, 8);
    });
});

describe("Timeline redaction trim transactions", () => {
    it("commits one immutable timed rectangle and cancels or rejects stale drafts exactly", () => {
        const added = addSafeRedaction({
            document: createEmptyOverlayDocument(),
            playheadUs: 1_000_000,
            projectDurationUs: 8_000_000,
        });
        const latest = resizeSafeRedactionRange(added.redaction, "end", 6_000_000, 8_000_000);
        const options = {
            before: added.document,
            current: added.document,
            original: added.redaction,
            latest,
        };

        expect(redactionDocumentForTrimCommit({ ...options, commit: false })).toBeUndefined();
        expect(redactionDocumentForTrimCommit({ ...options, current: structuredClone(added.document), commit: true })).toBeUndefined();
        expect(redactionDocumentForTrimCommit({ ...options, latest: added.redaction, commit: true })).toBeUndefined();

        const committed = redactionDocumentForTrimCommit({ ...options, commit: true });
        expect(committed).toBeDefined();
        expect(committed).not.toBe(added.document);
        expect(committed!.overlays[0]).toMatchObject({ id: added.redaction.id, startUs: 1_000_000, endUs: 6_000_000 });
        expect(added.document.overlays[0]).toMatchObject({ startUs: 1_000_000, endUs: 4_000_000 });
    });

    it("shows a dedicated selectable lane with both trim handles", () => {
        const state = structuredClone(INITIAL_EDITOR_STATE);
        const added = addSafeRedaction({
            document: state.project.overlays,
            playheadUs: 1_000_000,
            projectDurationUs: 8_000_000,
        });
        state.activeTool = "annotations";
        state.selectedOverlayId = added.redaction.id;
        state.project.overlays = added.document;
        const html = renderToStaticMarkup(createElement(Timeline, { state, dispatch: vi.fn(), sourceHasAudio: false }));

        expect(html).toContain("<strong>Redact</strong><small>Opaque</small>");
        expect(html).toContain("timeline-redaction-cue is-selected");
        expect(html).toContain('aria-label="Trim start of redaction 1"');
        expect(html).toContain('aria-label="Trim end of redaction 1"');
    });
});
