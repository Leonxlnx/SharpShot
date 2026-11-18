import { describe, expect, it } from "vitest";
import { validateZoomSegments, type ZoomSegment } from "../shared/cursor-zoom";
import type { EditorClip } from "./types";
import { remapZoomSegmentsForClips } from "./zoom-remap";

const clip = (id: string, sourceStart: number, sourceEnd: number, speed = 1): EditorClip => ({
    id,
    name: id,
    sourceStart,
    sourceEnd,
    speed,
    color: "#000000",
});

const zoom = (
    id: string,
    startUs: number,
    endUs: number,
    easeInUs = 400_000,
    easeOutUs = 200_000,
): ZoomSegment => ({
    id,
    startUs,
    endUs,
    focus: { x: 0.7, y: 0.3 },
    scale: 2,
    easeInUs,
    easeOutUs,
    source: "manual",
});

const durationUs = (clips: readonly EditorClip[]) => Math.round(clips.reduce(
    (total, item) => total + (item.sourceEnd - item.sourceStart) / item.speed,
    0,
) * 1_000_000);

describe("zoom remapping through clip edits", () => {
    it("shifts a later zoom when an earlier clip is trimmed or ripple-deleted", () => {
        const oldClips = [clip("a", 0, 4), clip("b", 0, 4)];
        const segments = [zoom("later", 5_000_000, 7_000_000)];

        expect(remapZoomSegmentsForClips(segments, oldClips, [clip("a", 0, 2), oldClips[1]!]))
            .toMatchObject([{ id: "later", startUs: 3_000_000, endUs: 5_000_000 }]);
        expect(remapZoomSegmentsForClips(segments, oldClips, [oldClips[1]!]))
            .toMatchObject([{ id: "later", startUs: 1_000_000, endUs: 3_000_000 }]);
        expect(remapZoomSegmentsForClips([zoom("removed", 1_000_000, 2_000_000)], oldClips, [oldClips[1]!]))
            .toEqual([]);
    });

    it("retimes a zoom inside a speed-changed clip and scales its easing", () => {
        const oldClips = [clip("a", 0, 4)];
        const output = remapZoomSegmentsForClips(
            [zoom("speed", 1_000_000, 3_000_000)],
            oldClips,
            [clip("a", 0, 4, 2)],
        );

        expect(output).toEqual([{
            ...zoom("speed", 500_000, 1_500_000),
            focus: { x: 0.7, y: 0.3 },
            easeInUs: 200_000,
            easeOutUs: 100_000,
        }]);
        validateZoomSegments(output, 2_000_000);
    });

    it("preserves every retained fragment and only eases original segment edges", () => {
        const oldClips = [clip("a", 0, 4), clip("b", 0, 4)];
        const newClips = [clip("a", 0, 3.5), clip("b", 1, 4)];
        const original = zoom("crossing", 3_000_000, 6_000_000, 600_000, 300_000);
        const output = remapZoomSegmentsForClips([original], oldClips, newClips);

        expect(output).toEqual([
            {
                ...original,
                startUs: 3_000_000,
                endUs: 3_500_000,
                focus: { ...original.focus },
                easeInUs: 500_000,
                easeOutUs: 0,
            },
            {
                ...original,
                id: "crossing.part2",
                startUs: 3_500_000,
                endUs: 4_500_000,
                focus: { ...original.focus },
                easeInUs: 0,
                easeOutUs: 300_000,
            },
        ]);
        expect(output[0]!.focus).not.toBe(original.focus);
        validateZoomSegments(output, durationUs(newClips));
    });

    it("uses deterministic valid part ids when retained pieces are no longer adjacent", () => {
        const oldClips = [clip("a", 0, 2), clip("b", 0, 2), clip("c", 0, 2)];
        const newClips = [oldClips[0]!, oldClips[2]!, oldClips[1]!];
        const original = zoom("wide", 1_000_000, 5_000_000);
        const first = remapZoomSegmentsForClips([original], oldClips, newClips);
        const second = remapZoomSegmentsForClips([original], oldClips, newClips);

        expect(first.map((segment) => ({ id: segment.id, startUs: segment.startUs, endUs: segment.endUs }))).toEqual([
            { id: "wide", startUs: 1_000_000, endUs: 2_000_000 },
            { id: "wide.part2", startUs: 2_000_000, endUs: 3_000_000 },
            { id: "wide.part3", startUs: 4_000_000, endUs: 6_000_000 },
        ]);
        expect(first.map(({ easeInUs, easeOutUs }) => ({ easeInUs, easeOutUs }))).toEqual([
            { easeInUs: 400_000, easeOutUs: 0 },
            { easeInUs: 0, easeOutUs: 200_000 },
            { easeInUs: 0, easeOutUs: 0 },
        ]);
        expect(second).toEqual(first);
        validateZoomSegments(first, durationUs(newClips));
    });
});
